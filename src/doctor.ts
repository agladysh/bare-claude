import fs from 'node:fs/promises';
import path from 'node:path';

import { configFileName, locateConfig, parseConfig } from '@agladysh/bare-claude/config';
import { commandName, commandSource, defaultBinDir, status } from '@agladysh/bare-claude/install';

import pkg from '../package.json';

/**
 * `bare-claude --doctor`: what a run needs, and which of it is missing.
 *
 * One item per assumption the README makes — the runtime, the `claude` and
 * `git` executables, a credential the bare subprocess can authenticate with,
 * the command on `PATH`, and the configuration file a run from here would
 * load. Each item says what was found; a failing one says what to do. The
 * doctor observes and never repairs, and it never prints a secret: the
 * credential item reports presence, not value.
 */

/** Outcome of one check. `fail` is what makes the doctor exit nonzero. */
export type DoctorStatus = 'ok' | 'warn' | 'fail';

/** One checked item. */
export interface DoctorItem {
  /** Short name, e.g. `claude`. */
  name: string,

  /** Whether the item is fine, tolerable, or missing. */
  status: DoctorStatus,

  /** One line: what was found. */
  detail: string,

  /** How to fix it, one line each; empty when there is nothing to fix. */
  hint: string[],
}

/** Everything the doctor checked. */
export interface DoctorReport {
  /** Items in the order they are printed. */
  items: DoctorItem[],

  /** False when any item failed. */
  ok: boolean,
}

/**
 * Options for {@link runDoctor}. Every input the checks read from the
 * outside world can be supplied, which is what makes the doctor testable
 * against a temporary home and a fake `claude` without touching the machine.
 */
export interface DoctorOptions {
  /** Claude Code executable, as `--claude-path`. Defaults to `claude` on `PATH`. */
  claudePath?: string,

  /**
   * Environment to inspect and to resolve executables in. Defaults to the
   * process environment.
   */
  env?: Record<string, string | undefined>,

  /** Directory the configuration file is resolved from. Defaults to the process cwd. */
  cwd?: string,

  /** Where the command is expected on `PATH`. Defaults to `~/.local/bin`. */
  binDir?: string,
}

/**
 * The README's authentication guidance, verbatim: an ephemeral
 * `CLAUDE_CONFIG_DIR` loses the ambient login session (measured 2026-07-26 on
 * 2.1.220), and this is the route that restores it.
 */
const setupTokenHint = [
  'A bare run does not inherit the ambient login session:',
  '  claude setup-token                          # once; prints a long-lived OAuth token',
  '  export CLAUDE_CODE_OAUTH_TOKEN=<the token>  # inherited by the subprocess',
];

/** Credentials Claude Code accepts instead of the subscription token. */
const alternateCredentials = [ 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN' ];

/**
 * Runs `command --version` and returns its trimmed stdout, or null when the
 * command could not be started, exited nonzero, or printed nothing.
 */
async function versionOf(
  command: string,
  env: Record<string, string | undefined>,
  cwd: string
): Promise<string | null> {
  let subprocess;
  try {
    subprocess = Bun.spawn({ cmd: [ command, '--version' ], cwd, env, stdout: 'pipe', stderr: 'ignore' });
  } catch {
    return null;
  }
  const [ stdout, exitCode ] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);
  const version = stdout.trim();
  return exitCode === 0 && version !== '' ? version : null;
}

/** Whether two paths resolve to the same file; false when either does not resolve. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [ x, y ] = await Promise.all([ fs.realpath(a), fs.realpath(b) ]);
    return x === y;
  } catch {
    return false;
  }
}

function checkBun(): DoctorItem {
  const required = pkg.engines.bun;
  const satisfied = Bun.semver.satisfies(Bun.version, required);
  return {
    name: 'bun',
    status: satisfied ? 'ok' : 'fail',
    detail: `${Bun.version} at ${process.execPath}${satisfied ? '' : `, but ${pkg.name} needs ${required}`}`,
    hint: satisfied ? [] : [ 'bun upgrade' ],
  };
}

async function checkClaude(
  claudePath: string,
  env: Record<string, string | undefined>,
  cwd: string
): Promise<DoctorItem> {
  const resolved = Bun.which(claudePath, { PATH: env.PATH ?? '', cwd });
  if (resolved === null) {
    return {
      name: 'claude',
      status: 'fail',
      detail: `${claudePath} not found on PATH`,
      hint: [ 'Install Claude Code, or name the executable with --claude-path' ],
    };
  }

  const version = await versionOf(resolved, env, cwd);
  if (version === null) {
    return {
      name: 'claude',
      status: 'fail',
      detail: `${resolved} did not answer --version`,
      hint: [ 'Run it by hand; a broken installation is Claude Code\'s to report' ],
    };
  }

  return {
    name: 'claude',
    status: 'ok',
    detail: `${version.replace(' (Claude Code)', '')} at ${resolved}`,
    hint: [],
  };
}

async function checkGit(env: Record<string, string | undefined>, cwd: string): Promise<DoctorItem> {
  const resolved = Bun.which('git', { PATH: env.PATH ?? '', cwd });
  if (resolved === null) {
    return {
      name: 'git',
      status: 'fail',
      detail: 'git not found on PATH',
      hint: [ `${commandName} locates ${configFileName} and resolves --read pathspecs through git` ],
    };
  }

  const version = await versionOf(resolved, env, cwd);
  return {
    name: 'git',
    status: version === null ? 'fail' : 'ok',
    detail: version === null
      ? `${resolved} did not answer --version`
      : `${version.replace(/^git version /, '')} at ${resolved}`,
    hint: [],
  };
}

function checkAuth(env: Record<string, string | undefined>): DoctorItem {
  const present = (name: string) => (env[name] ?? '') !== '';

  if (present('CLAUDE_CODE_OAUTH_TOKEN')) {
    return { name: 'auth', status: 'ok', detail: 'CLAUDE_CODE_OAUTH_TOKEN present', hint: [] };
  }

  const alternates = alternateCredentials.filter(present);
  if (alternates.length > 0) {
    return {
      name: 'auth',
      status: 'warn',
      detail: `CLAUDE_CODE_OAUTH_TOKEN absent; ${alternates.join(' and ')} present, so runs do not use the subscription`,
      hint: setupTokenHint,
    };
  }

  return { name: 'auth', status: 'fail', detail: 'CLAUDE_CODE_OAUTH_TOKEN absent', hint: setupTokenHint };
}

async function checkInstall(
  env: Record<string, string | undefined>,
  binDir: string | undefined
): Promise<DoctorItem> {
  const name = 'install';

  let directory: string;
  try {
    directory = binDir ?? defaultBinDir(env);
  } catch (error) {
    return {
      name,
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      hint: [],
    };
  }

  const current = await status(directory);
  const onPath = Bun.which(commandName, { PATH: env.PATH ?? '' });
  const checkout = path.dirname(path.dirname(commandSource));
  const installCommand = `cd ${checkout} && bun run install:user`;

  switch (current.state) {
    case 'installed': {
      if (onPath !== null && await sameFile(onPath, commandSource)) {
        return { name, status: 'ok', detail: `${current.path} -> ${current.source}`, hint: [] };
      }
      if (onPath !== null) {
        return {
          name,
          status: 'warn',
          detail: `${current.path} -> ${current.source}, but PATH resolves ${commandName} to ${onPath} first`,
          hint: [ `Put ${directory} ahead of ${path.dirname(onPath)} on PATH, or remove ${onPath}` ],
        };
      }
      return {
        name,
        status: 'fail',
        detail: `${current.path} -> ${current.source}, but ${directory} is not on PATH`,
        hint: [ `export PATH="${directory}:$PATH"` ],
      };
    }

    case 'foreign':
      return {
        name,
        status: 'fail',
        detail: `${current.path} is ${current.detail}, not this checkout's ${commandName}`,
        hint: current.detail === 'a directory'
          ? [ `Remove ${current.path}, then: ${installCommand}` ]
          : [ `${installCommand} --force   # replaces it` ],
      };

    case 'absent': {
      if (onPath !== null) {
        const ours = await sameFile(onPath, commandSource);
        return {
          name,
          status: 'ok',
          detail: ours
            ? `${onPath} -> ${commandSource} on PATH (not in ${directory})`
            : `${onPath} on PATH, not an install of this checkout`,
          hint: [],
        };
      }
      return {
        name,
        status: 'fail',
        detail: `${commandName} is not on PATH, and ${current.path} is absent`,
        hint: [ installCommand ],
      };
    }
  }
}

async function checkPreset(cwd: string): Promise<DoctorItem> {
  const name = 'preset';

  let configPath: string | null;
  try {
    configPath = await locateConfig(cwd);
  } catch (error) {
    return {
      name,
      status: 'fail',
      detail: `cannot locate ${configFileName}: ${error instanceof Error ? error.message : String(error)}`,
      hint: [],
    };
  }

  if (configPath === null) {
    return {
      name,
      status: 'warn',
      detail: `${cwd} is not inside a Git working copy; ${commandName} runs inside one and reads ${configFileName} at its root`,
      hint: [],
    };
  }

  const file = Bun.file(configPath);
  if (!await file.exists()) {
    return {
      name,
      status: 'ok',
      detail: `no ${configFileName} at ${path.dirname(configPath)} (optional)`,
      hint: [],
    };
  }

  try {
    const { presets } = parseConfig(await file.text(), configPath);
    const names = Object.keys(presets);
    return {
      name,
      status: 'ok',
      detail: names.length > 0 ? `${configPath} (presets: ${names.join(', ')})` : configPath,
      hint: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      status: 'fail',
      detail: `${configPath} is invalid`,
      hint: message.split('\n').map(line => line.trim()).filter(line => line !== '' && line !== `${configPath} is invalid:`),
    };
  }
}

/**
 * Checks everything a `bare-claude` run relies on, without repairing any of
 * it and without spawning a model: the only subprocesses are `--version`
 * probes and `git rev-parse`.
 * @param options - See {@link DoctorOptions}
 * @returns The items in print order, and whether all required ones are present
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const claudePath = options.claudePath ?? 'claude';

  const items: DoctorItem[] = [
    checkBun(),
    await checkClaude(claudePath, env, cwd),
    await checkGit(env, cwd),
    checkAuth(env),
    await checkInstall(env, options.binDir),
    await checkPreset(cwd),
  ];

  return { items, ok: items.every(item => item.status !== 'fail') };
}

/**
 * Renders a report as one `status name: detail` line per item, each hint
 * line indented beneath its item.
 * @param report - The report to render
 * @returns Text ending in a newline
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const item of report.items) {
    lines.push(`${item.status.padEnd(4)} ${item.name}: ${item.detail}`);
    for (const hint of item.hint) {
      lines.push(`       ${hint}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
