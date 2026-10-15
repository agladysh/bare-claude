import { closeSync, fstatSync, ftruncateSync, openSync, writeSync, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deepmerge } from 'deepmerge-ts';

// Relative, not by package name: the module is not in package.json `exports`,
// and a self-reference by name resolves through `exports` once installed.
import { cloneSessionSeed, type PublishedFile } from './session-seed.ts';
import {
  hasCredential, readTokenFile, resolveTokenFile, tokenVariable
} from '@agladysh/bare-claude/token';

/**
 * Represents a JSON structure that can be either an object or array.
 */
export type JsonStructure = JsonObject | JsonArray

/**
 * Interface representing a JSON object with string keys and Json values.
 */
export interface JsonObject {
	[k: string]: Json
}

/**
 * Represents a JSON array containing Json values.
 */
export type JsonArray = Json[]

/**
 * Represents a JSON primitive value (string, boolean, number, or null).
 */
export type JsonPrimitive = string | boolean | number | null

/**
 * Represents any valid JSON value - either a structure (object/array) or primitive.
 */
export type Json = JsonStructure | JsonPrimitive

/**
 * Narrows an arbitrary value to a {@link JsonObject}.
 * @param v - The value to test
 * @returns True when `v` is a non-null, non-array object
 */
function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merges JSON objects left to right, so the rightmost argument wins.
 *
 * Objects merge key by key at every depth and arrays concatenate, which is the
 * `deepmerge-ts` behaviour `src/preset.ts` already relies on.
 * @param objects - The objects to merge, least significant first
 * @returns The merged object
 */
function mergeJson(...objects: JsonObject[]): JsonObject {
  const merged: unknown = deepmerge(...objects);
  if (!isJsonObject(merged)) {
    // Unreachable: deepmerge of plain objects is a plain object. Guarded
    // rather than cast, because the library's return type is not JsonObject.
    throw new Error('deep merge of JSON objects did not produce a JSON object');
  }
  return merged;
}

/**
 * Sanitizes a string for use as a filename by replacing non-alphanumeric characters with hyphens.
 * @param s - The string to sanitize
 * @returns A sanitized string safe for use as a filename
 */
function sanitizeForFilename(s: string) {
  return s.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Converts a file path to a filename suitable for filesystem use.
 * @param path - The file path to convert
 * @returns A sanitized filename, truncated with hash if too long
 */
function pathToFilename(path: string): string {
  const maxLength = 200;
  const filename = sanitizeForFilename(path);
  return filename.length <= maxLength
    ? filename
    : `${filename.slice(0, maxLength)}-${Bun.hash(path).toString(36)}`;
}

/**
 * Rejects call-to-action strings claude would misparse.
 *
 * Measured trap: a call to action starting with `-` is consumed by claude's
 * flag parser even after `--print`. On 2.1.220 that surfaces as
 * `error: unknown option` and exit 1 with empty stdout; older versions exited
 * 0 silently. Either way the run does nothing, so refuse it before spawning.
 * The workaround is to prefix the prompt, e.g. with `# `.
 * @param callToAction - The prompt about to be passed to `--print`
 */
export function assertSafeCallToAction(callToAction: string): void {
  if (callToAction.startsWith('-')) {
    throw new Error(
      'callToAction starts with "-" and claude would parse it as a flag, not a prompt. '
      + 'Prefix it, e.g. with "# ", to make it safe.'
    );
  }
}

/**
 * Markers Claude Code injects into processes it spawns, and reads back to
 * recognize itself as a child session. Inheriting them makes a bare run
 * believe it belongs to the session that launched it — it would report the
 * parent's session id and entrypoint. Auth variables are deliberately not in
 * this list: they are how a bare run authenticates.
 */
const parentSessionMarkers = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];

/**
 * Available launcher types for spawning Claude processes.
 */
export const Launchers = {
  claude: 'claude',
  ollama: 'ollama',
} as const;

/**
 * Type representing all possible launcher values.
 */
export type Launchers = typeof Launchers;

/**
 * Type representing a single launcher key.
 */
export type Launcher = keyof Launchers;
/**
 * Operations that can be performed to modify the system prompt.
 */
type SystemPromptOp = 'appendString' | 'setString' | 'appendFile' | 'setFile';

/**
 * Who supplies the child's credential.
 *
 * - `'fallback'`: the caller's environment first; when it carries no
 *   credential, Bare Claude falls back to its own sources — the token file
 *   (see {@link LaunchOptions.tokenFile}) and, where `linkAuth` is on, the
 *   credential file it links into the ephemeral home.
 * - `'caller'`: the caller owns authentication. Bare Claude reads no token
 *   file and links no credential file; the child authenticates with whatever
 *   the environment the caller built carries, or however the executable
 *   named by `claudePath` authenticates itself. A managed launcher that
 *   brings its own credential needs this: under `'fallback'` a token file
 *   would be put beside it whenever the environment lacks a credential.
 */
export type AuthMode = 'fallback' | 'caller';

/** The two {@link AuthMode} values, for checking one that came from untyped code. */
const authModes: readonly AuthMode[] = [ 'fallback', 'caller' ];

/** Narrows a value from untyped code, a JavaScript caller's for one, to an {@link AuthMode}. */
function isAuthMode(value: unknown): value is AuthMode {
  return authModes.some(mode => mode === value);
}

/**
 * What a session id may look like. It names the journal file
 * (`<sessionId>.jsonl`) inside the Claude home, so a separator or a leading
 * dot would place that file somewhere else: one leading letter or digit, then
 * letters, digits, `.`, `_` or `-`, 128 characters at most. Claude Code's own
 * ids are UUIDs, which match. Whether Claude Code accepts a non-UUID id for
 * `--resume` is not checked here.
 */
export const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * A prior session continued from memory. `value` is written whole as the new
 * run's journal: the caller has already allocated those bytes, and this route
 * spends them once more on disk.
 */
export interface InMemorySessionSeed {
  /** Session id the run resumes (`--resume`). */
  sessionId: string,

  /** The journal, in Claude Code's JSONL format. */
  value: string,
}

/**
 * A prior session continued from a journal file the caller keeps. The new
 * run's journal is a copy-on-write clone of it on the same filesystem; the
 * source is never written, and there is no byte-copy fallback. See
 * `src/session-seed.ts` for every refusal.
 */
export interface FileSessionSeed {
  /** Session id the run resumes (`--resume`). */
  sessionId: string,

  /** The prior journal: a regular, single-link file, not a symbolic link. */
  sourcePath: string,

  /** Lowercase SHA-256 hex digest the source must still have, when recorded. */
  sourceSha256?: string,
}

/** A prior session to continue: from memory, or from a journal file. */
export type SessionSeed = InMemorySessionSeed | FileSessionSeed;

// TODO: Support worktrees.
/**
 * Options for launching a Claude subprocess.
 */
export interface LaunchOptions {
  /**
   * Working directory for the Claude process, resolved to an absolute path.
   * Defaults to process.cwd().
   */
  cwd?: string | null,

  /**
   * Claude home directory (`CLAUDE_CONFIG_DIR`) for the run, owned by the
   * caller: resolved to an absolute path, created when missing, and never
   * removed by this library, whether the run succeeds, fails or is
   * interrupted. Its `settings.json` is replaced on every spawn. Nothing here
   * stops two runs sharing a home; keeping to one live run per home is the
   * caller's. If not provided, a temporary directory is created, and
   * `dispose()` removes it.
   */
  ephemeralClaudeHomePath?: string | null,

  /**
   * A prior session to continue under its own session id, which must match
   * {@link sessionIdPattern}. Either route refuses to replace a journal
   * already at the destination, which can only happen in a caller-supplied
   * home.
   */
  customSessionData?: null | SessionSeed,

  /**
   * Launcher to use for spawning Claude. Defaults to 'claude'.
   */
  launcher?: Launcher,

  /**
   * Path to the Claude Code executable. Defaults to `claude` on `PATH`.
   * Only affects the `claude` launcher's own argv[0] — the `ollama` launcher
   * spawns `ollama`, and the `claude` in its argv names what `ollama launch`
   * runs, not a filesystem path, so this option does not reach it.
   */
  claudePath?: string,

  /**
   * Model to use for Claude. Defaults to null (uses Claude's default).
   */
  model?: null | string,

  /**
   * Effort level for Claude. Defaults to 'high'.
   */
  effortLevel?: string,

  /**
   * Permission mode for Claude. Defaults to 'auto'.
   */
  permissionMode?: string,

  /**
   * Configuration for modifying the system prompt.
   */
  changeSystemPrompt?: null | { type: SystemPromptOp, value: string },

  /**
   * Whether to disable instruction files. Defaults to true.
   */
  noInstructionFiles?: boolean,

  /**
   * Whether to disable memory. Defaults to true.
   */
  noMemory?: boolean,

  /**
   * Whether to disable skills. Defaults to true.
   */
  noSkills?: boolean,

  /**
   * Whether to disable hooks. Defaults to true.
   */
  noHooks?: boolean,

  /**
   * Whether to disable plugins. Defaults to true.
   */
  noPlugins?: boolean,

  /**
   * Whether to disable MCP. Defaults to true.
   */
  noMcp?: boolean,

  /**
   * Whether to disable agents. Defaults to true.
   */
  noAgents?: boolean,

  /**
   * Whether to disable tasks. Defaults to false.
   */
  noTasks?: boolean,

  /**
   * Whether to disable compact. Defaults to true.
   */
  noCompact?: boolean,

  /**
   * Whether to disable integrations. Defaults to true.
   */
  noIntegrations?: boolean,

  /**
   * Whether to disable housekeeping. Defaults to true.
   */
  noHousekeeping?: boolean,

  /**
   * Whether to disable the Bash tool's per-command changed-file diff by
   * writing `CLAUDE_CODE_BASH_EDIT_DIFF=0` into the settings `env`. Defaults
   * to true. Claude reads that variable before any `bashEditDiffEnabled`
   * setting, so while it is set a caller's `bashEditDiffEnabled: true` does
   * not re-enable the diff. False only omits the variable: a caller's
   * `bashEditDiffEnabled: false` (or policy) still disables the diff, and
   * otherwise Claude's own default applies.
   */
  noBashEditDiff?: boolean,

  /**
   * Whether to disable calling the mothership.
   * Defaults to false when launcher is claude, true otherwise.
   */
  noMothership?: boolean,

  /**
   * Whether to drop the inherited process environment. Defaults to false.
   * When false, everything is inherited except the parent-session markers,
   * credentials included. When true, nothing is, credentials included:
   * only `spawnOptions.env` and `extraEnv` reach the child. Neither setting
   * governs the token file — under `auth: 'fallback'` it is still read when
   * the resulting environment has no credential, from the default location
   * under `os.homedir()` if `HOME` is absent. `auth: 'caller'` is what turns
   * that off.
   */
  noProcessEnv?: boolean,

  /**
   * Who supplies the child's credential; see {@link AuthMode}. Defaults to
   * `'fallback'`. `'caller'` cannot be combined with `linkAuth: true` or a
   * `tokenFile`: each would name a credential source the caller just
   * declared it owns.
   */
  auth?: AuthMode,

  /**
   * Whether to symlink the credential file from the real Claude config dir into
   * the ephemeral home, so a bare run keeps the subscription session. Only the
   * credential file is linked, never `.claude.json`, so the child cannot
   * clobber the real config, and a token refresh writes back through the link.
   * The real config dir is this process's `CLAUDE_CONFIG_DIR`, else
   * `~/.claude`.
   *
   * Platform note: this only helps where Claude Code keeps credentials in a
   * file. On macOS they live in the login keychain and there is nothing to
   * link — use `CLAUDE_CODE_OAUTH_TOKEN` there. Defaults to true under
   * `auth: 'fallback'` and false under `auth: 'caller'`.
   */
  linkAuth?: boolean,

  /**
   * File holding the subscription token, bare and alone, read into the
   * child's `CLAUDE_CODE_OAUTH_TOKEN` at spawn time when the child's
   * environment carries neither that variable nor an alternate credential
   * (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`), and only for the `claude`
   * launcher under `auth: 'fallback'`. Null (the default) resolves it:
   * `BARE_CLAUDE_TOKEN_FILE` from the child's environment, then
   * `$XDG_CONFIG_HOME/bare-claude/oauth`, then `~/.config/bare-claude/oauth`.
   * Null does not disable the lookup; `auth: 'caller'` does. A missing file is
   * fine; an empty or unreadable one is an error. The value is never surfaced
   * anywhere.
   */
  tokenFile?: string | null,

  /**
   * Tools the run may use, as passed to `--tools`. An empty array disables all
   * tools. Note that `--allowedTools ''` does *not*: it fails open, and the
   * model still reaches the filesystem. Defaults to null (Claude's default set).
   */
  tools?: null | string[],

  /**
   * Tools the run may not use, as passed to `--disallowed-tools`.
   * `['*']` blocks everything. Defaults to null.
   */
  disallowedTools?: null | string[],

  /**
   * Extra directories the run may reach, as passed to `--add-dir`. A headless
   * run cannot read outside its cwd without these.
   */
  addDirs?: string[],

  /**
   * Hard spend ceiling for the run in US dollars, as passed to
   * `--max-budget-usd`. Defaults to null (no ceiling).
   */
  maxBudgetUsd?: null | number,

  /**
   * Maximum tokens the model may generate, via `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
   * Distinct from `maxOutputLength`, which caps *tool* output going into
   * context. Note that exceeding this errors the turn rather than truncating
   * it. Defaults to null (default limit).
   */
  maxTokens?: null | number,

  /**
   * Maximum output length for various Claude components. Defaults to null (default limit).
   */
  maxOutputLength?: null | number,

  /**
   * Additional environment variables for the Claude *process*. Distinct from
   * `extraSettings.env`, which Claude Code applies to itself after startup.
   * See {@link spawnClaude} for where this sits in the environment precedence.
   */
  extraEnv?: Record<string, string>,

  /**
   * Additional command-line arguments to pass to Claude. Appended after every
   * flag this library derives and before the trailing `--print`.
   */
  extraArgs?: string[],

  /**
   * Additional settings deep-merged into Claude's `settings.json`, applied
   * last so a caller can override anything {@link buildSettings} derives —
   * including nested keys such as `permissions.defaultMode`, `sandbox.enabled`
   * and individual entries of the `env` block. Objects merge key by key at
   * every depth and arrays concatenate; there is no way to delete a key this
   * library writes, only to give it another value.
   */
  extraSettings?: JsonObject,

  /**
   * The call-to-action prompt to send to Claude.
   */
  callToAction: string
}

/**
 * A fully resolved {@link LaunchOptions}: every field present, every default
 * applied. This is the sole input to {@link buildArgv}, {@link buildEnv} and
 * {@link buildSettings}, so those three never have to re-derive a default.
 */
export type LaunchConfig = Required<LaunchOptions>;

/**
 * Converts LaunchOptions to a fully resolved LaunchConfig by applying defaults.
 * @param o - The launch options to convert
 * @returns A LaunchConfig with all fields resolved to non-optional values
 * @throws When `auth` is neither `'fallback'` nor `'caller'`; when
 *   `auth: 'caller'` is combined with a credential source of Bare Claude's
 *   own, `linkAuth: true` or a `tokenFile`; when a session seed's
 *   `sessionId` does not match {@link sessionIdPattern}
 */
export function LaunchConfig(o: LaunchOptions): LaunchConfig {
  // Checked at run time because a JavaScript caller is not held to the type,
  // and an unknown mode would otherwise turn every fallback off unannounced.
  // Only an absent mode defaults: `??` would also let a null through.
  const requested: unknown = o.auth === undefined ? 'fallback' : o.auth;
  if (!isAuthMode(requested)) {
    throw new Error(`auth must be "fallback" or "caller", got ${JSON.stringify(requested)}`);
  }
  const auth = requested;

  const sessionId: unknown = o.customSessionData?.sessionId;
  if (o.customSessionData !== undefined && o.customSessionData !== null
    && (typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId))) {
    throw new Error(
      `customSessionData.sessionId ${JSON.stringify(sessionId)} cannot name a journal file: `
      + 'it must be a letter or digit followed by letters, digits, ".", "_" or "-", 128 characters at most'
    );
  }

  if (auth === 'caller') {
    if (o.linkAuth === true) {
      throw new Error('auth "caller" leaves authentication to the caller, so it cannot also take linkAuth');
    }
    if (o.tokenFile !== undefined && o.tokenFile !== null && o.tokenFile !== '') {
      throw new Error('auth "caller" leaves authentication to the caller, so it cannot also take a tokenFile');
    }
  }

  return {
    cwd: o.cwd ?? null,
    ephemeralClaudeHomePath: o.ephemeralClaudeHomePath ?? null,
    customSessionData: o.customSessionData ?? null,
    launcher: o.launcher ?? 'claude',
    claudePath: o.claudePath ?? 'claude',
    model: o.model ?? null,
    effortLevel: o.effortLevel ?? 'high',
    permissionMode: o.permissionMode ?? 'auto',
    changeSystemPrompt: o.changeSystemPrompt ?? null,
    noInstructionFiles: o.noInstructionFiles ?? true,
    noMemory: o.noMemory ?? true,
    noSkills: o.noSkills ?? true,
    noHooks: o.noHooks ?? true,
    noPlugins: o.noPlugins ?? true,
    noMcp: o.noMcp ?? true,
    noAgents: o.noAgents ?? true,
    noTasks: o.noTasks ?? false,
    noCompact: o.noCompact ?? true,
    noIntegrations: o.noIntegrations ?? true,
    noHousekeeping: o.noHousekeeping ?? true,
    noBashEditDiff: o.noBashEditDiff ?? true,
    // Branches on the resolved launcher, not the raw option: omitting
    // `launcher` means `claude`, and must behave like passing it.
    noMothership: o.noMothership ?? ((o.launcher ?? 'claude') !== 'claude'),
    noProcessEnv: o.noProcessEnv ?? false,
    auth,
    linkAuth: o.linkAuth ?? auth === 'fallback',
    tokenFile: o.tokenFile ?? null,
    tools: o.tools ?? null,
    disallowedTools: o.disallowedTools ?? null,
    addDirs: o.addDirs ?? [],
    maxBudgetUsd: o.maxBudgetUsd ?? null,
    maxTokens: o.maxTokens ?? null,
    maxOutputLength: o.maxOutputLength ?? null,
    extraEnv: o.extraEnv ?? {},
    extraArgs: o.extraArgs ?? [],
    extraSettings: o.extraSettings ?? {},
    callToAction: o.callToAction,
  };
}

/**
 * Flags for each way of changing the system prompt. `--system-prompt` replaces
 * the built-in prompt; note that it does *not* suppress CLAUDE.md discovery,
 * which is what `noInstructionFiles` is for.
 */
const systemPromptFlags: Record<SystemPromptOp, string> = {
  'appendString': '--append-system-prompt',
  'appendFile': '--append-system-prompt-file',
  'setString': '--system-prompt',
  'setFile': '--system-prompt-file',
};

/**
 * Builds the complete command vector for a launch, `argv[0]` included.
 *
 * Pure: no filesystem, no clock, no environment. Every ordering constraint the
 * CLI imposes lives here, and one of them is load-bearing — `--print` and its
 * prompt are always the last two elements, because a flag after `--print` is
 * measured to be swallowed by the parser rather than treated as the prompt.
 * `extraArgs` is therefore appended just before them.
 * @param config - The resolved launch configuration
 * @param sessionId - The session id to run under; for a resumed run this is
 *   `customSessionData.sessionId`
 * @returns The command vector to hand to `Bun.spawn`
 * @throws If `config.launcher` is not a known launcher
 */
export function buildArgv(config: LaunchConfig, sessionId: string): string[] {
  if (!(config.launcher in Launchers)) {
    throw new Error(
      `Unknown launcher "${config.launcher}", known launchers are ${Object.keys(Launchers).join(', ')}`
    );
  }

  const modelFlag = config.model ? [ '--model', config.model ] : [];
  const launcherArgv: Record<Launcher, string[]> = {
    claude: [ config.claudePath, ...modelFlag ],
    // `claude` here is not a path: it is the target name `ollama launch`
    // takes, unrelated to config.claudePath, which only ever names a
    // filesystem executable. See the LaunchOptions.claudePath TSDoc.
    ollama: [ 'ollama', 'launch', 'claude', ...modelFlag, '--yes', '--' ],
  };

  const argv: string[] = [ ...launcherArgv[config.launcher] ];

  // A resumed session must be named with --resume; --session-id would ask for
  // a fresh one and collide with the transcript already on disk.
  argv.push(config.customSessionData ? '--resume' : '--session-id', sessionId);

  argv.push('--effort', config.effortLevel);
  argv.push('--permission-mode', config.permissionMode);

  // Only the ephemeral home's own settings.json may contribute; project and
  // local .claude/settings*.json would otherwise still be loaded, which is
  // the opposite of running bare.
  argv.push('--setting-sources', 'user');

  if (config.changeSystemPrompt) {
    argv.push(systemPromptFlags[config.changeSystemPrompt.type], config.changeSystemPrompt.value);
  }

  // TODO: This still feeds model a ton of skills
  if (config.noSkills) {
    argv.push('--disable-slash-commands');
  }

  if (config.noIntegrations) {
    // The only part of noIntegrations that is a CLI flag; the IDE half is env
    // vars, see buildSettings. Verified 2026-07-26 on 2.1.220: `--no-chrome`
    // parses, and an invented `--no-zzzchrome` is rejected with
    // `error: unknown option` plus a "Did you mean --no-chrome?" suggestion.
    argv.push('--no-chrome');
  }

  if (config.tools !== null) {
    // '' is the documented way to say "no tools"; an empty array must not
    // become a missing argument, which would swallow the next flag.
    argv.push('--tools', config.tools.join(','));
  }

  if (config.disallowedTools !== null) {
    argv.push('--disallowed-tools', config.disallowedTools.join(','));
  }

  for (const dir of config.addDirs) {
    argv.push('--add-dir', dir);
  }

  if (config.maxBudgetUsd !== null) {
    argv.push('--max-budget-usd', String(config.maxBudgetUsd));
  }

  argv.push(...config.extraArgs);

  // Measured (thai/oracle-runtime): --print must be the last flag before the
  // prompt text. Nothing may be appended after these two.
  argv.push('--print', config.callToAction);

  return argv;
}

/**
 * Inputs {@link buildEnv} needs that are not part of a {@link LaunchConfig}.
 */
export interface EnvContext {
  /**
   * Ephemeral `CLAUDE_CONFIG_DIR` for the run. Forced into the result last and
   * cannot be overridden: redirecting the config dir is what makes a run bare.
   */
  ephemeralClaudeHomePath: string,

  /**
   * Ambient environment to inherit, minus {@link parentSessionMarkers}.
   * Defaults to `process.env`. Ignored entirely when `noProcessEnv` is set.
   * Pass an explicit value to keep the call pure.
   */
  processEnv?: Record<string, string | undefined>,

  /**
   * The caller's `spawnOptions.env`, layered above the inherited environment
   * and below `extraEnv`. Taken as given — parent-session markers are not
   * stripped from it, since a caller naming one means it.
   */
  spawnEnv?: Record<string, string | undefined>,
}

/**
 * Builds the environment of the Claude *process*.
 *
 * Distinct from the `env` block {@link buildSettings} writes into
 * `settings.json`: this one is what the child is exec'd with, that one is what
 * Claude Code applies to itself once it has read its settings.
 *
 * Layered, later wins: inherited process environment (unless `noProcessEnv`,
 * and always minus the parent-session markers), then `spawnEnv`, then
 * `extraEnv`, then `CLAUDE_CONFIG_DIR`.
 * @param config - The resolved launch configuration
 * @param context - Run-specific values the config does not carry
 * @returns The environment to spawn the child with
 */
export function buildEnv(
  config: LaunchConfig,
  context: EnvContext
): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = {};
  if (!config.noProcessEnv) {
    Object.assign(inherited, context.processEnv ?? process.env);
    for (const marker of parentSessionMarkers) {
      delete inherited[marker];
    }
  }

  return {
    ...inherited,
    ...context.spawnEnv,
    ...config.extraEnv,
    CLAUDE_CONFIG_DIR: context.ephemeralClaudeHomePath,
  };
}

/**
 * Builds the `settings.json` written into the ephemeral Claude home.
 *
 * Pure: no filesystem, no clock, no environment. Claude Code ignores unknown
 * settings keys silently, so nesting matters more than it looks — every key
 * here is present in `https://json.schemastore.org/claude-code-settings.json`,
 * and that property must hold for anything added later.
 *
 * `extraSettings` is deep-merged last and therefore wins over everything
 * below, including the `env` block.
 * @param config - The resolved launch configuration
 * @returns The settings object, ready to serialize
 */
export function buildSettings(config: LaunchConfig): JsonObject {
  const env: JsonObject = {
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1', // Less confusing for models.
  };

  const settings: JsonObject = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',

    // TODO: Shouldn't we have flags for these too?
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // Verified 2026-07-26 against the settings schema and claude 2.1.220:
      // `failIfUnavailable` defaults to false, which means a host missing the
      // sandbox dependencies only logs a warning and then runs commands
      // *unsandboxed*. `autoAllowBashIfSandboxed` explicitly "only applies to
      // commands that will run sandboxed", so it evaporates in that case and
      // every Bash call falls back to a permission decision that headless
      // `--print` cannot prompt for. Failing at startup is the honest
      // outcome; Claude Code's own programmatic sandbox option does the same,
      // defaulting failIfUnavailable to true whenever enabled is true.
      failIfUnavailable: true,
    },
  };

  if (config.model) {
    settings.model = config.model;
  }

  settings.effortLevel = config.effortLevel;

  // Both of these live under `permissions`, and disableBypassPermissionsMode
  // is the string 'disable', not a boolean. At the settings root they are
  // unknown keys, which Claude Code drops without a word.
  settings.permissions = {
    defaultMode: config.permissionMode,
    disableBypassPermissionsMode: 'disable',
  };

  if (config.noInstructionFiles) {
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  }

  if (config.noMemory) {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }

  if (config.noSkills) {
    env.CLAUDE_CODE_DISABLE_CRON = '1';
    env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1';
  }

  if (config.noHooks) {
    settings.disableAllHooks = true;
  }

  if (config.noPlugins) {
    settings.enabledPlugins = {};
  }

  if (config.noMcp) {
    settings.enableAllProjectMcpServers = false;
    settings.enabledMcpjsonServers = [];
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  }

  if (config.noAgents) {
    env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = '1';
  }

  if (config.noTasks) {
    env.CLAUDE_CODE_ENABLE_TASKS = '0';
  }

  if (config.noCompact) {
    env.DISABLE_COMPACT = '1';
  }

  if (config.noIntegrations) {
    settings.disableDeepLinkRegistration = 'disable';
    // The IDE toggles are *not* settings keys. Verified 2026-07-26 against
    // 2.1.220: `autoConnectIde` and `autoInstallIdeExtension` are absent from
    // the settings schema and are read out of the global config store
    // (`.claude.json`, written by the /config panel), where they default to
    // false and true respectively. Writing them into settings.json did
    // nothing, and left extension auto-install on. These two env vars are the
    // documented route and are the values Claude Code actually checks:
    // auto-connect short-circuits on CLAUDE_CODE_AUTO_CONNECT_IDE === false,
    // and auto-install is skipped when CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is
    // one of 1/true/yes/on.
    env.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';
    env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1';
  }

  if (config.noHousekeeping) {
    settings.cleanupPeriodDays = 99999;
    env.DISABLE_AUTOUPDATER = '1';
    env.DISABLE_INSTALLATION_CHECKS = '1';
  }

  if (config.noBashEditDiff) {
    // Read from claude 2.1.280 on 2026-09-23 (functions U2t, qGr, X2t). When
    // the diff is enabled (by default only in `auto` and `bypassPermissions`
    // modes, behind a server-side cohort flag), each process keeps one private
    // Git store per repository it runs Bash in, under
    // `$TMPDIR/claude-<uid>/bash-edit-diff/<session>-<repo>-<random>/`. The
    // store is seeded from a copy of the repository index and updated around
    // every Bash command. Where that baseline cannot be created (observed: one
    // tracked path containing a TAB failed the index validation), the store
    // re-hashes every tracked file into new loose objects and is abandoned.
    // The reason was not recorded; a time limit is the inferred cause. A second
    // store is made, and the process stops after two failures. Abandoned
    // stores remain until Claude's own sweep removes those older than
    // min(cleanupPeriodDays, 2) days. Headless runs on one repository
    // accumulated tens of gigabytes. The diff is also cohort-dependent,
    // which makes a run less reproducible.
    //
    // The `bashEditDiffEnabled: false` settings key has the same effect but is
    // not in the schemastore schema yet, and this variable is checked before
    // it (a tri-state: 0/false/no/off), so the variable is the route used.
    env.CLAUDE_CODE_BASH_EDIT_DIFF = '0';
  }

  // If using with Anthropic models, best set to false.
  if (config.noMothership) {
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'; // May kill caching on some vendors if enabled.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'; // May kill caching with Antropic if enabled.
    env.CLAUDE_CODE_ENABLE_TELEMETRY = '0'; // May kill caching with Antropic if disabled.
  }

  if (config.maxOutputLength !== null) {
    env.TASK_MAX_OUTPUT_LENGTH = String(config.maxOutputLength);
    env.BASH_MAX_OUTPUT_LENGTH = String(config.maxOutputLength);
    env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = String(config.maxOutputLength);
  }

  if (config.maxTokens !== null) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(config.maxTokens);
  }

  settings.env = env;

  return mergeJson(settings, config.extraSettings);
}

/**
 * Represents a spawned Claude subprocess with associated metadata.
 * @template In - The type of writable stdin stream
 * @template Out - The type of readable stdout stream
 * @template Err - The type of readable stderr stream
 */
interface ClaudeSubprocess<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
> {
  /** The spawned Bun subprocess */
  subprocess: Bun.Subprocess<In, Out, Err>,
  /** Absolute path to the Claude home directory, the caller's or a temporary one */
  ephemeralClaudeHomePath: string,
  /** Unique identifier for the Claude session */
  sessionId: string,
  /** Path to the project home directory within Claude home */
  projectHomePath: string,
  /** Path to the JSONL session file */
  sessionJsonlPath: string,
  /**
   * The process group the spawned process leads — its own PID — when it was
   * spawned with `spawnOptions.detached: true` on macOS or Linux; null
   * otherwise. Pass the whole value to `stopClaude` from
   * `@agladysh/bare-claude/lifecycle` to end the run and its descendants.
   */
  processGroup: number | null,
  /**
   * Removes the ephemeral Claude home directory, but only when spawnClaude
   * created it: a caller-supplied `ephemeralClaudeHomePath` is left alone.
   * Idempotent. Without this every spawn leaks a temporary directory.
   */
  dispose: () => Promise<void>,
};

/** Narrows a thrown value to the errno `code` a Node system error carries. */
function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

/**
 * Creates the journal for an in-memory seed, exclusively and mode 0600, and
 * returns its identity. The identity is taken from the descriptor that
 * created the file, before a byte is written, so a failed write can still be
 * taken back.
 */
async function writeNewJournal(filePath: string, value: string): Promise<PublishedFile> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(`session journal ${filePath} already exists; a seed never overwrites one`);
    }
    throw error;
  }
  const stats = await handle.stat({ bigint: true });
  const published: PublishedFile = { path: filePath, dev: stats.dev, ino: stats.ino };
  try {
    await handle.writeFile(value);
  } catch (error) {
    await handle.close();
    await removeIfUnchanged(published);
    throw error;
  }
  await handle.close();
  return published;
}

/**
 * Removes a file this call published, but only while the path still names
 * that file. Resolves true when it is gone, false when something else is at
 * the path now and was left alone. Between the check and the unlink there is
 * a window no POSIX call closes; one live run per Claude home is what keeps
 * anything from using it.
 */
async function removeIfUnchanged(file: PublishedFile): Promise<boolean> {
  let now: BigIntStats;
  try {
    now = await fs.lstat(file.path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return true;
    }
    throw error;
  }
  if (!now.isFile() || now.dev !== file.dev || now.ino !== file.ino) {
    return false;
  }
  await fs.unlink(file.path);
  return true;
}

/**
 * Replaces `filePath` with `text` atomically: written to a new private file
 * in the same directory, mode 0600, then renamed over the old one. A reader
 * sees the old file or the new one, never a partial write.
 */
async function replaceFile(filePath: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${Bun.randomUUIDv7()}`);
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/** One line this call appended, and the means to take exactly that line back. */
interface HistoryLine {
  /** The file appended to. */
  path: string,

  /**
   * Truncates the file back to its length before the append, but only when
   * the append landed whole at the end and nothing was appended after it.
   * Returns whether the line is gone.
   */
  retract(): boolean,

  /** Releases the descriptor. Idempotent. */
  close(): void,
}

/**
 * Appends `line` to `filePath`, keeping the descriptor so the line can be
 * retracted through the very file it went into, whatever has been renamed
 * since. Never rewrites what was there before.
 */
function appendHistoryLine(filePath: string, line: string): HistoryLine {
  const fd = openSync(filePath, 'a', 0o600);
  let open = true;
  const close = () => {
    if (open) {
      open = false;
      closeSync(fd);
    }
  };
  try {
    const bytes = Buffer.from(line);
    const before = fstatSync(fd, { bigint: true }).size;
    const written = writeSync(fd, bytes);
    const after = fstatSync(fd, { bigint: true }).size;
    // Only a whole line, alone at the end, is provably ours to take back.
    const whole = written === bytes.length && after === before + BigInt(bytes.length);
    return {
      path: filePath,
      retract: () => {
        if (!whole || !open || fstatSync(fd, { bigint: true }).size !== after) {
          return false;
        }
        ftruncateSync(fd, Number(before));
        return true;
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Spawns a Claude subprocess with the given launch options.
 *
 * The construction is factored out into {@link buildArgv}, {@link buildEnv}
 * and {@link buildSettings}, which are pure and individually testable; this
 * function resolves the config, calls them, does the filesystem work and
 * spawns. Anything that decides *what* claude is invoked with belongs in a
 * builder, not here.
 *
 * `spawnOptions` is forwarded to `Bun.spawn` except for two fields this
 * function resolves rather than passes through:
 *
 * - `cwd` — `launchOptions.cwd ?? spawnOptions.cwd ?? process.cwd()`, made
 *   absolute. The winner is also what the ephemeral project directory is
 *   keyed on, so the spawn cwd and the session transcript path can never
 *   disagree.
 * - `env` — layered, later wins: the inherited process environment (unless
 *   `noProcessEnv`, and always minus the parent-session markers), then
 *   `spawnOptions.env`, then `launchOptions.extraEnv`, then
 *   `CLAUDE_CONFIG_DIR`. The last is forced and not overridable: pointing the
 *   child at the ephemeral config dir is what makes the run bare.
 *
 * Before spawning, in this order: the project directory is created, the
 * credential file linked (`linkAuth`), the token file read, the session seed
 * published, `settings.json` replaced atomically (written to a private file
 * beside it, mode 0600, then renamed over it), and, for a seeded run, one
 * line appended to `history.jsonl`. If any of that or the spawn itself fails, the call
 * rejects and takes back what it published: the journal, when the file at
 * that path is still the one it wrote; the history line, when nothing was
 * appended after it; and the whole home, when this call created it. A file
 * that was replaced meanwhile is left, and the error says so.
 *
 * The spawned process is not supervised. Ending it, and anything it started,
 * is the caller's: pass `detached: true` in `spawnOptions` to give it a
 * process group of its own, and `stopClaude` from
 * `@agladysh/bare-claude/lifecycle` to end that group. Its exit code is the
 * spawned process's own and nothing more: it does not say whether the task
 * was done, nor that anyone has read the result.
 * @template In - The type of writable stdin stream
 * @template Out - The type of readable stdout stream
 * @template Err - The type of readable stderr stream
 * @param launchOptions - Configuration options for launching Claude
 * @param spawnOptions - Optional Bun spawn options for customizing the subprocess
 * @returns A Promise that resolves to a ClaudeSubprocess containing the spawned process and metadata
 */
export async function spawnClaude<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
>(
  launchOptions: LaunchOptions,
  spawnOptions: Bun.Spawn.SpawnOptions<In, Out, Err> = {}
): Promise<ClaudeSubprocess<In, Out, Err>> {
  const c = LaunchConfig(launchOptions);

  assertSafeCallToAction(c.callToAction); // Before any filesystem work, so a refusal leaves nothing behind.

  // Absolute, because the winner keys the project directory and a relative
  // path would key it differently from what the child sees as its cwd.
  const cwd = path.resolve(c.cwd ?? spawnOptions.cwd ?? process.cwd());
  const sessionId = c.customSessionData?.sessionId ?? Bun.randomUUIDv7();

  // Built before the filesystem work below for the same reason
  // assertSafeCallToAction runs first: an unknown launcher must not leave a
  // temporary directory behind.
  const cmd = buildArgv(c, sessionId);
  const settings = buildSettings(c);

  // An empty path would resolve to the working directory and turn it into a
  // Claude home.
  if (c.ephemeralClaudeHomePath === '') {
    throw new Error('ephemeralClaudeHomePath is empty; give a directory, or null for a temporary one');
  }

  // A caller's home is resolved here because the child resolves a relative
  // CLAUDE_CONFIG_DIR against its own cwd, not against ours.
  const ownsClaudeHome = c.ephemeralClaudeHomePath === null;
  const ephemeralClaudeHomePath = c.ephemeralClaudeHomePath === null
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-home-'))
    : path.resolve(c.ephemeralClaudeHomePath);

  const projectHomePath = path.join(ephemeralClaudeHomePath, 'projects', pathToFilename(cwd));
  const sessionJsonlPath = path.join(projectHomePath, `${sessionId}.jsonl`)

  // What this call has published so far, so a failure can take back exactly
  // that and nothing else.
  let journal: PublishedFile | null = null;
  let history: HistoryLine | null = null;

  let subprocess: Bun.Subprocess<In, Out, Err>;
  try {
    // Creating unconditionally to simplify watch() logic. Must complete before
    // the credential link and the session file below, and before the child
    // is spawned.
    await fs.mkdir(projectHomePath, { recursive: true, mode: 0o700 });

    // The ephemeral CLAUDE_CONFIG_DIR below leaves the child logged out. Symlink
    // — not copy — the credential file from the real config dir so no secret is
    // duplicated on disk and a refresh writes straight back through the link.
    // Only the credential file, never .claude.json.
    if (c.linkAuth && c.launcher === 'claude') {
      const realConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
      for (const name of [ '.credentials.json', 'auth.json', 'credentials.json' ]) {
        const source = path.join(realConfigDir, name);
        if (await Bun.file(source).exists()) {
          try {
            await fs.symlink(source, path.join(ephemeralClaudeHomePath, name));
          } catch { /* Already linked, or something is there; either way, leave it. */ }
        }
      }
    }

    const env = buildEnv(c, { ephemeralClaudeHomePath, spawnEnv: spawnOptions.env });

    // The token file is the last resort and the last step: after buildEnv has
    // had its say, so an explicit token in any layer wins, and only here, so
    // the value exists in this process for exactly as long as the spawn takes
    // and never reaches a preset, a --debug dump or a log. Not for the ollama
    // launcher, and not beside an alternate credential: both mean the run is
    // about to talk to something other than Anthropic. Not under auth
    // 'caller' either: the caller has said where the credential comes from.
    if (c.auth === 'fallback' && c.launcher === 'claude' && !hasCredential(env)) {
      const token = await readTokenFile(resolveTokenFile(c.tokenFile, env));
      if (token !== null) {
        env[tokenVariable] = token;
      }
    }

    const seed = c.customSessionData;
    if (seed !== null) {
      if ('sourcePath' in seed) {
        // The types forbid both; a deep merge of two presets can produce it.
        if ('value' in seed) {
          throw new Error('customSessionData names both a value and a sourcePath; give one');
        }
        journal = cloneSessionSeed(seed.sourcePath, sessionJsonlPath, seed.sourceSha256);
      } else {
        journal = await writeNewJournal(sessionJsonlPath, seed.value);
      }
    }

    // Replaced, never rewritten in place: a run still using this home would
    // otherwise read a half-written file, and Claude Code drops a settings
    // file that fails validation whole and silently.
    await replaceFile(
      path.join(ephemeralClaudeHomePath, 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`
    );

    if (seed !== null) {
      // Last before the spawn, so a refused seed or settings write leaves no
      // history behind, and appended, not written: a caller's home may already
      // hold history Claude Code wrote for earlier sessions.
      history = appendHistoryLine(path.join(ephemeralClaudeHomePath, 'history.jsonl'), `${JSON.stringify({
        display: 'bare-claude',
        pastedContents: {},
        timestamp: Date.now(),
        project: cwd,
        sessionId: seed.sessionId,
      })}\n`);
    }

    const o: Bun.Spawn.SpawnOptions<In, Out, Err> & { cmd: string[] } = {
      ...spawnOptions,
      cwd,
      cmd,
      env,
    };
    subprocess = Bun.spawn(o);
  } catch (error) {
    // Nothing was spawned, so nothing can need what this call published.
    const left: string[] = [];
    if (history !== null && !history.retract()) {
      left.push(`a line in ${history.path}, which was appended to after it`);
    }
    if (journal !== null && !await removeIfUnchanged(journal)) {
      left.push(`${journal.path}, which is no longer the file this call wrote`);
    }
    // A caller's home is theirs, whatever state this left it in.
    if (ownsClaudeHome) {
      await fs.rm(ephemeralClaudeHomePath, { recursive: true, force: true });
    }
    if (left.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; left in place: ${left.join('; ')}`, { cause: error });
    }
    throw error;
  } finally {
    history?.close();
  }

  // setsid() makes the spawned process lead a group whose id is its PID.
  const processGroup = spawnOptions.detached === true && process.platform !== 'win32' ? subprocess.pid : null;

  let disposed = false;

  return {
    subprocess,
    ephemeralClaudeHomePath,
    sessionId,
    projectHomePath,
    sessionJsonlPath,
    processGroup,
    dispose: async () => {
      if (disposed || !ownsClaudeHome) {
        return;
      }
      disposed = true;
      await fs.rm(ephemeralClaudeHomePath, { recursive: true, force: true });
    },
  }
}
