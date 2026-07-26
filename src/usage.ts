/**
 * Subscription usage introspection.
 *
 * Claude Code never reports quota in absolute units — every source it has is a
 * percentage of an opaque window. What it does expose, and what this module
 * reads, is:
 *
 * - `claude -p /usage`, a local slash command that costs no tokens, runs
 *   non-interactively, and refreshes the on-disk usage cache as a side effect;
 * - `~/.claude.json` → `cachedUsageUtilization`, the verbatim server payload
 *   that command leaves behind, with integer percentages and ISO reset
 *   timestamps;
 * - `claude auth status`, for the plan and whether plan limits apply at all.
 *
 * Reading the cache without refreshing it first is a trap: it is written only
 * when something asks for usage, so an untouched machine can hold a payload
 * days old. Claude Code itself discards this cache past one hour.
 *
 * Deliberately not used: `GET /api/oauth/usage`. It is the authoritative
 * source and it is undocumented — reaching it directly means lifting the
 * user's OAuth token out of the system credential store and impersonating the
 * CLI. Letting `claude` make that call for us costs nothing and stays inside
 * documented behaviour.
 */

import os from 'node:os';
import path from 'node:path';

/** Length of each rate-limit window, in seconds. */
const windowSeconds: Record<string, number> = {
  five_hour: 5 * 60 * 60,
  seven_day: 7 * 24 * 60 * 60,
};

/**
 * Consumption-ahead-of-clock thresholds, taken from Claude Code's own warning
 * rule: a window is burning fast when utilization has passed `utilization`
 * while no more than `elapsed` of the window has gone by.
 */
const burnThresholds: Record<string, { utilization: number, elapsed: number }[]> = {
  five_hour: [ { utilization: 0.9, elapsed: 0.72 } ],
  seven_day: [
    { utilization: 0.75, elapsed: 0.6 },
    { utilization: 0.5, elapsed: 0.35 },
    { utilization: 0.25, elapsed: 0.15 },
  ],
};

/** Longest a cached usage payload may be before it is refused, matching Claude Code. */
export const maxUsageCacheAgeMs = 60 * 60 * 1000;

/**
 * One rate-limit window.
 */
export interface UsageWindow {
  /** Window identifier, e.g. `five_hour`, `seven_day`, or a model display name. */
  name: string,

  /** Percentage of the window consumed, 0-100. */
  utilization: number,

  /** ISO 8601 timestamp at which the window resets. */
  resetsAt: string,

  /** Seconds remaining until the reset, floored at zero. */
  secondsUntilReset: number,

  /**
   * Fraction of the window already elapsed, 0-1, or null when the window's
   * length is unknown (model-scoped windows do not declare one).
   */
  elapsed: number | null,

  /**
   * Whether consumption is running ahead of the clock by Claude Code's own
   * thresholds. Null when `elapsed` is unknown.
   */
  burningFast: boolean | null,
}

/**
 * A point-in-time answer to "how much subscription is left".
 */
export interface UsageReport {
  /** Whether the CLI reports an authenticated session. */
  loggedIn: boolean,

  /** Subscription type reported by `claude auth status`, e.g. `max`. */
  plan: string | null,

  /** When the underlying payload was fetched from the server. */
  fetchedAt: string,

  /** Age of that payload at the time of reading. */
  ageSeconds: number,

  /** Every window the server reported, most-constrained first. */
  windows: UsageWindow[],
}

/**
 * Narrows to a plain object. The payloads below are Claude Code's shapes, not
 * ours, and they change between releases: everything is checked, nothing is
 * assumed.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Reads one window out of a `{ utilization, resets_at }` payload.
 * Returns null for windows the server left unpopulated.
 */
export function parseUsageWindow(name: string, value: unknown, now: number): UsageWindow | null {
  if (!isRecord(value)) {
    return null;
  }

  const utilization = value.utilization;
  const resetsAt = value.resets_at;
  if (typeof utilization !== 'number' || typeof resetsAt !== 'string') {
    return null;
  }

  const resetsAtMs = Date.parse(resetsAt);
  if (Number.isNaN(resetsAtMs)) {
    return null;
  }

  const length = windowSeconds[name];
  const elapsed = length === undefined
    ? null
    : Math.min(1, Math.max(0, (now - (resetsAtMs - length * 1000)) / (length * 1000)));

  return {
    name,
    utilization,
    resetsAt,
    secondsUntilReset: Math.max(0, Math.round((resetsAtMs - now) / 1000)),
    elapsed,
    burningFast: elapsed === null ? null : isBurningFast(name, utilization, elapsed),
  };
}

/**
 * Whether a window's consumption has outrun the clock badly enough that Claude
 * Code would warn about it.
 */
export function isBurningFast(name: string, utilization: number, elapsed: number): boolean {
  return (burnThresholds[name] ?? []).some(
    t => utilization / 100 >= t.utilization && elapsed <= t.elapsed
  );
}

/**
 * Turns a `cachedUsageUtilization` payload into windows. Named windows come
 * first, then any model-scoped weekly limits the server reported.
 */
export function parseUsageCache(cache: unknown, now: number): UsageWindow[] {
  if (!isRecord(cache) || !isRecord(cache.utilization)) {
    return [];
  }

  const windows: UsageWindow[] = [];

  for (const [ name, value ] of Object.entries(cache.utilization)) {
    if (name === 'limits' || name === 'spend' || name === 'extra_usage') {
      continue;
    }
    const window = parseUsageWindow(name, value, now);
    if (window !== null) {
      windows.push(window);
    }
  }

  // Model-scoped weeklies (e.g. a per-model cap) arrive only in `limits`.
  const limits = cache.utilization.limits;
  if (Array.isArray(limits)) {
    for (const limit of limits) {
      if (!isRecord(limit) || limit.kind !== 'weekly_scoped') {
        continue;
      }
      const scope = isRecord(limit.scope) ? limit.scope : {};
      const model = isRecord(scope.model) ? scope.model : {};
      const label = typeof model.display_name === 'string' ? model.display_name : 'scoped';
      const window = parseUsageWindow(
        label,
        { utilization: limit.percent, resets_at: limit.resets_at },
        now
      );
      if (window !== null) {
        windows.push(window);
      }
    }
  }

  return windows.sort((a, b) => b.utilization - a.utilization);
}

/** Runs a `claude` subcommand, returning its stdout. Never throws on nonzero exit. */
async function runClaude(claudePath: string, args: string[]): Promise<string> {
  const subprocess = Bun.spawn({
    cmd: [ claudePath, ...args ],
    stdout: 'pipe',
    stderr: 'ignore',
    // Deliberately the ambient environment: usage lives in the user's real
    // config directory, not in an ephemeral one.
    env: process.env,
  });
  const [ stdout ] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);
  return stdout;
}

/**
 * Options for {@link readUsage}.
 */
export interface ReadUsageOptions {
  /** Claude Code executable. Defaults to `claude` on `PATH`. */
  claudePath?: string,

  /**
   * Whether to run `claude -p /usage` first to refresh the cache. Costs no
   * tokens and one HTTP round trip. Defaults to true; turning it off makes the
   * read purely local, at the cost of possibly reporting a stale payload.
   */
  refresh?: boolean,

  /** Path to Claude Code's config file. Defaults to `~/.claude.json`. */
  configPath?: string,
}

/**
 * Reads subscription usage. Returns null when no usable payload is available —
 * an API-key session, an unauthenticated machine, or a cache too old to trust.
 */
export async function readUsage(options: ReadUsageOptions = {}): Promise<UsageReport | null> {
  const claudePath = options.claudePath ?? 'claude';
  const configPath = options.configPath ?? path.join(os.homedir(), '.claude.json');

  let loggedIn = false;
  let plan: string | null = null;
  try {
    const status: unknown = JSON.parse(await runClaude(claudePath, [ 'auth', 'status' ]));
    if (isRecord(status)) {
      loggedIn = status.loggedIn === true;
      plan = typeof status.subscriptionType === 'string' ? status.subscriptionType : null;
    }
  } catch {
    // An unparseable status is not fatal: the cache below may still be usable.
  }

  if (options.refresh !== false) {
    await runClaude(claudePath, [ '-p', '/usage' ]);
  }

  const config: unknown = await Bun.file(configPath).json().catch(() => null);
  if (!isRecord(config)) {
    return null;
  }

  const cache = config.cachedUsageUtilization;
  if (!isRecord(cache) || typeof cache.fetchedAtMs !== 'number') {
    return null;
  }
  const fetchedAtMs = cache.fetchedAtMs;

  const now = Date.now();
  const ageMs = now - fetchedAtMs;
  if (ageMs > maxUsageCacheAgeMs) {
    return null;
  }

  return {
    loggedIn,
    plan,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
    windows: parseUsageCache(cache, now),
  };
}
