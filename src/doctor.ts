import fs from 'node:fs/promises';
import path from 'node:path';

import { buildEnv, LaunchConfig, type AuthMode } from '@agladysh/bare-claude';
import {
  configFileName, loadConfig, locateConfig, parseConfig, type Config, type ConfigSource
} from '@agladysh/bare-claude/config';
import { commandName, commandSource, defaultBinDir, status } from '@agladysh/bare-claude/install';
import { mergeInvocation, type DynamicPreset } from '@agladysh/bare-claude/preset';
import {
  alternateCredentialsIn, formatMode, hasToken, inspectTokenFile, resolveTokenFile, tokenVariable
} from '@agladysh/bare-claude/token';

import pkg from '../package.json';

/**
 * `bare-claude --doctor`: what a run needs, and which of it is missing.
 *
 * One item per assumption the README makes — the runtime, the `claude` and
 * `git` executables, a credential the bare subprocess can authenticate with,
 * the command on `PATH`, and the configuration file a run from here would
 * load. Each item says what was found; a failing one says what to do. The
 * doctor observes and never repairs, and it never prints a secret: the
 * credential item reports presence, or the token file's path and mode, and
 * never a value.
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
 *
 * The doctor checks the invocation a run with the same options would make:
 * the configuration `config` selects, `overrides` on top of it and `use`
 * folded in, exactly as the CLI merges them. The `claude` and `auth` items
 * then look at that invocation's `claudePath`, `cwd`, `auth`, `tokenFile`,
 * and at the environment its child would get — `env` filtered by
 * `noProcessEnv`, plus its `extraEnv`.
 */
export interface DoctorOptions {
  /**
   * Claude Code executable, as `--claude-path`; wins over the invocation's.
   * Defaults to the invocation's, else `claude` on `PATH`.
   */
  claudePath?: string,

  /**
   * The environment the doctor runs in, which a run would inherit unless it
   * sets `noProcessEnv`. Defaults to the process environment.
   */
  env?: Record<string, string | undefined>,

  /**
   * Directory the doctor runs in: where the configuration file is located
   * from, and what a relative `cwd` in it is resolved against. Defaults to
   * the process cwd.
   */
  cwd?: string,

  /** Where the command is expected on `PATH`. Defaults to `~/.local/bin`. */
  binDir?: string,

  /**
   * Token file to inspect, as `--token-file`; wins over the invocation's.
   * Defaults to the invocation's, else `BARE_CLAUDE_TOKEN_FILE`, then the XDG
   * config location.
   */
  tokenFile?: string,

  /**
   * Who supplies the credential, as `--auth`; wins over the invocation's.
   * Under `'caller'` the auth item inspects nothing and says so.
   */
  auth?: AuthMode,

  /**
   * Which configuration to read, as `--config`/`--no-config`. Defaults to
   * the located `bare-claude.yaml`.
   */
  config?: ConfigSource,

  /** The preset id `--use` names, replacing the configuration's root `use`. */
  use?: string,

  /** Fields the command line sets, merged over the configuration as a run merges them. */
  overrides?: DynamicPreset,
}

/**
 * The README's authentication guidance, verbatim: an ephemeral
 * `CLAUDE_CONFIG_DIR` loses the ambient login session (measured 2026-07-26 on
 * 2.1.220), and this is the route that restores it.
 */
function setupTokenHint(tokenFile: string): string[] {
  return [
    'A bare run does not inherit the ambient login session:',
    '  claude setup-token                          # once; prints a long-lived OAuth token',
    '  export CLAUDE_CODE_OAUTH_TOKEN=<the token>  # inherited by the subprocess',
    `or write the bare token, nothing else, to ${tokenFile} (chmod 600)`,
  ];
}

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

/**
 * Never the value. Presence in the environment, else the token file — its
 * path, its mode, whether it is blank — else what to do.
 */
async function checkAuth(
  env: Record<string, string | undefined>,
  tokenFile: string | undefined,
  auth: AuthMode
): Promise<DoctorItem> {
  const name = 'auth';

  // A warning, not ok: the caller's route may well work, but nothing here
  // has looked at it, and a variable's mere presence would prove nothing.
  if (auth === 'caller') {
    return {
      name,
      status: 'warn',
      detail: `caller-managed: ${commandName} supplies no credential, and this does not check the caller's`,
      hint: [],
    };
  }

  if (hasToken(env)) {
    return { name, status: 'ok', detail: `${tokenVariable} present`, hint: [] };
  }

  const filePath = resolveTokenFile(tokenFile, env);
  const file = await inspectTokenFile(filePath);

  switch (file.state) {
    case 'present':
      return file.exposed
        ? {
          name,
          status: 'warn',
          detail: `token file ${filePath} is mode ${formatMode(file.mode)}, readable beyond its owner`,
          hint: [ `chmod 600 ${filePath}` ],
        }
        : { name, status: 'ok', detail: `token file ${filePath}`, hint: [] };

    case 'empty':
      return { name, status: 'fail', detail: `token file ${filePath} is empty`, hint: setupTokenHint(filePath) };

    case 'unreadable':
      return { name, status: 'fail', detail: `token file ${filePath}: ${file.reason}`, hint: [] };

    case 'absent': {
      const alternates = alternateCredentialsIn(env);
      if (alternates.length > 0) {
        return {
          name,
          status: 'warn',
          detail: `${tokenVariable} absent, no token file at ${filePath}; ${alternates.join(' and ')} present, so runs do not use the subscription`,
          hint: setupTokenHint(filePath),
        };
      }
      return {
        name,
        status: 'fail',
        detail: `${tokenVariable} absent, no token file at ${filePath}`,
        hint: setupTokenHint(filePath),
      };
    }
  }
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

    case 'foreign': {
      const foreign = `${current.path} is ${current.detail}, not this checkout's ${commandName}`;
      const replace = current.detail === 'a directory'
        ? `Remove ${current.path}, then: ${installCommand}`
        : `${installCommand} --force   # replaces it`;
      // As for an absent entry: any bare-claude on PATH satisfies this item,
      // whatever it is. A warning, not ok, because the entry in the bin
      // directory is not this checkout's and someone may have expected it to
      // be; nothing here says that command can run a given invocation.
      if (onPath !== null) {
        const resolved = await sameFile(onPath, commandSource)
          ? `${onPath} -> ${commandSource}, this checkout's`
          : `${onPath}, not an install of this checkout`;
        return {
          name,
          status: 'warn',
          detail: `${foreign}; PATH resolves ${commandName} to ${resolved}`,
          hint: [ `To install this checkout's instead: ${replace}` ],
        };
      }
      return {
        name,
        status: 'fail',
        detail: `${foreign}, and ${commandName} is not on PATH`,
        hint: [ replace ],
      };
    }

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

async function checkPreset(cwd: string, source: ConfigSource): Promise<DoctorItem> {
  const name = 'preset';

  if (source.kind === 'none') {
    return { name, status: 'ok', detail: 'no configuration file is read (--no-config)', hint: [] };
  }

  let configPath: string | null;
  if (source.kind === 'file') {
    configPath = source.path;
  } else {
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
  }

  if (configPath === null) {
    return {
      name,
      status: 'warn',
      detail: `${cwd} is not inside a Git working copy; ${commandName} reads ${configFileName} at the root of one`,
      hint: [ 'Name a configuration file with --config, or read none with --no-config' ],
    };
  }

  const file = Bun.file(configPath);
  if (!await file.exists()) {
    return source.kind === 'file'
      ? { name, status: 'fail', detail: `configuration file ${configPath} does not exist`, hint: [] }
      : {
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
 * An invocation resolved as a run would resolve it, or why it cannot be.
 *
 * - `resolved`: what a run would do.
 * - `command-line`: there is no configuration to read (outside a Git working
 *   copy, with the located one asked for), so `launch` is the command line
 *   alone. Checked as such, as the doctor always has.
 * - `refused`: a run would be refused. `launch` is the command line alone,
 *   good enough to look for an executable but not to judge a credential: the
 *   configuration it misses may declare `auth: caller`, under which no token
 *   file may be read.
 */
type ResolvedRun =
  | { kind: 'resolved', launch: LaunchConfig }
  | { kind: 'command-line', launch: LaunchConfig, error: string }
  | { kind: 'refused', launch: LaunchConfig, error: string };

/**
 * Resolves the invocation: configuration, overrides, `use`, then
 * `LaunchConfig`, the same steps and refusals as a run.
 */
async function resolveRun(
  source: ConfigSource,
  cwd: string,
  overrides: DynamicPreset,
  use: string | undefined
): Promise<ResolvedRun> {
  const commandLine = (): LaunchConfig => {
    try {
      const { use: _ignored, read: _read, ...fields } = overrides;
      return LaunchConfig({ ...fields, callToAction: '' });
    } catch {
      return LaunchConfig({ callToAction: '' });
    }
  };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);

  let config: Config;
  try {
    config = await loadConfig(source, cwd);
  } catch (error) {
    // Outside a Git working copy there is no configuration to read at all, so
    // the command line is the whole of what is known — as before there was a
    // configuration to resolve. Any other failure means a configuration that
    // could not be read, which may say anything, `auth: caller` included.
    const noConfiguration = source.kind === 'located' && await locateConfig(cwd) === null;
    return { kind: noConfiguration ? 'command-line' : 'refused', launch: commandLine(), error: message(error) };
  }

  try {
    const merged = mergeInvocation(config, overrides, use);
    return { kind: 'resolved', launch: LaunchConfig({ ...merged, callToAction: '' }) };
  } catch (error) {
    return { kind: 'refused', launch: commandLine(), error: message(error) };
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
  const source = options.config ?? { kind: 'located' };

  const overrides: DynamicPreset = { ...options.overrides };
  if (options.claudePath !== undefined) {
    overrides.claudePath = options.claudePath;
  }
  if (options.tokenFile !== undefined) {
    overrides.tokenFile = options.tokenFile;
  }
  if (options.auth !== undefined) {
    overrides.auth = options.auth;
  }

  const run = await resolveRun(source, cwd, overrides, options.use);
  const { launch } = run;

  // The child's environment, as buildEnv would give it; CLAUDE_CONFIG_DIR is
  // the run's temporary home, which does not exist yet and matters to neither
  // check below.
  const runEnv = buildEnv(launch, { ephemeralClaudeHomePath: '', processEnv: env });
  delete runEnv.CLAUDE_CONFIG_DIR;
  const runCwd = path.resolve(cwd, launch.cwd ?? cwd);

  // With no PATH in the child's environment, which PATH the spawn would
  // search was not established; this doctor's own is used, and says so.
  const claudeEnv = runEnv.PATH === undefined ? { ...runEnv, PATH: env.PATH } : runEnv;
  const claude = await checkClaude(launch.claudePath, claudeEnv, runCwd);
  if (runEnv.PATH === undefined) {
    claude.detail += ' (the run\'s environment sets no PATH; resolved with the doctor\'s)';
  }
  if (run.kind === 'refused') {
    claude.detail += ' (from the command line alone: the invocation does not resolve)';
  }

  let preset = await checkPreset(cwd, source);
  if (run.kind === 'refused' && preset.status !== 'fail') {
    preset = {
      name: 'preset',
      status: 'fail',
      detail: 'the invocation does not resolve; a run with these options would be refused',
      hint: run.error.split('\n').map(line => line.trim()).filter(line => line !== ''),
    };
  }

  // A refused invocation's auth mode is unknown, so no token file is opened:
  // the configuration that failed may be the one that says not to.
  const auth: DoctorItem = run.kind === 'refused'
    ? {
      name: 'auth',
      status: 'warn',
      detail: 'not checked: the invocation does not resolve (see preset), so which credential it would use is unknown',
      hint: [],
    }
    : await checkAuth(runEnv, launch.tokenFile ?? undefined, launch.auth);

  const items: DoctorItem[] = [
    checkBun(),
    claude,
    await checkGit(env, cwd),
    auth,
    await checkInstall(env, options.binDir),
    preset,
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
