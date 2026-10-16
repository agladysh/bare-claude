#!/usr/bin/env bun

import { $ } from 'bun';

import { parseArgs } from 'node:util';
import path from 'node:path';
import { watch } from 'node:fs/promises';

import TailFile from '@logdna/tail-file';
import { type } from 'arktype';

import {
  LaunchConfig, Launchers, physicalCwd, spawnClaude, type Json, type Launcher
} from '@agladysh/bare-claude';
import { TranscriptRenderer } from '@agladysh/bare-claude/display';
import {
  defaultMaxContentBytes, emitPreload, glob, type PreloadEntry
} from '@agladysh/bare-claude/preload';
import { SessionBuilder } from '@agladysh/bare-claude/SessionBuilder';

import pkg from '../package.json';
import {
  authMode, effortLevel, loadConfig, type ConfigSource, type EffortLevel
} from '@agladysh/bare-claude/config';
import type { AuthMode } from '@agladysh/bare-claude';
import { resolveInvocation, type DynamicPreset, type Preset } from '@agladysh/bare-claude/preset';
import { formatDoctorReport, runDoctor } from '@agladysh/bare-claude/doctor';
import {
  notPermittedRecheckMs, readProcessGroup, signalExitStatus, superviseSignals, type StopReport, type SupervisorEvent
} from '@agladysh/bare-claude/lifecycle';
import { alternateCredentialVariables, tokenVariable } from '@agladysh/bare-claude/token';
import { readUsage } from '@agladysh/bare-claude/usage';

///////////////////////////////////////////////////////////////////////////////

function displayHelp() {
  process.stdout.write([
    `Usage: ${Object.keys(pkg.bin)[0]} [options] -- "call to action"`,
    '',
    'Options:',
    '  -u, --use <preset>     Use configuration preset from bare-claude.yaml',
    '      --config <file>    Read this configuration file instead of bare-claude.yaml',
    '                         at the Git root; it must exist',
    '      --no-config        Read no configuration file at all',
    '  -l, --launcher <name>  claude (default) or ollama',
    '  -m, --model <model>    Model to use',
    '  -r, --read <pathspec>  Preload a file into a synthetic session (repeatable,',
    '                         accepts Git pathspec patterns)',
    '  -q, --quiet            Do not print the transcript',
    '  -p, --print            Print what `claude --print` printed',
    '',
    '      --effort <level>   low, medium, high (default), xhigh or max',
    '      --tools <list>     Comma-separated tools to allow; empty for none',
    '      --disallowed-tools <list>',
    '                         Comma-separated tools to deny; "*" for all',
    '      --add-dir <dir>    Allow reads outside cwd (repeatable)',
    '      --max-budget-usd <n>  Stop the run once it has spent this much',
    '      --max-tokens <n>   Cap model output (errors the turn, not truncates)',
    '      --max-output-length <n>',
    '                         Cap tool output going into context',
    '      --claude-path <path>  Claude Code executable to run (default: claude on PATH)',
    '      --claude-arg <arg> Forward a flag to claude verbatim (repeatable)',
    '      --token-file <path>',
    '                         File holding the OAuth token, used when the environment',
    '                         has none (default: $BARE_CLAUDE_TOKEN_FILE, then',
    '                         ~/.config/bare-claude/oauth)',
    '      --auth <mode>      fallback (default): the environment\'s credential, else',
    '                         the token file; caller: the caller\'s environment or',
    '                         launcher alone, with no token file and no credential link',
    '      --claude-home <dir>',
    '                         Claude home for the run, created if missing and kept',
    '                         whatever the outcome (default: a temporary directory)',
    '      --stop-grace-ms <n>',
    '                         After SIGTERM, SIGINT or SIGHUP, how long the run gets',
    '                         before its process group is sent SIGKILL (default 10000)',
    '',
    '      --verbose          Print more events in the transcript',
    '      --debug            Print the resolved configuration and unrecognized events',
    '      --display <file>   Render an existing session JSONL and exit',
    '      --usage            Report subscription usage as JSON and exit',
    '      --doctor           Check bun, claude, git, the credential, the PATH install',
    '                         and the preset file; exit 1 when something required is missing',
    '  -v, --version          Print the version and exit',
    '  -h, --help             Print this help and exit',
    '',
    'The call to action is read from stdin when no positional one is given.',
    'Exits with the exit code of the `claude` subprocess, which says the process',
    'ended, not that the task was done; after a stop signal, with 128 plus its number.',
    'SIGTERM, SIGINT and SIGHUP go to claude first; a second one sends SIGKILL at once.',
    'SIGKILL to bare-claude itself cannot be forwarded: signal the process group it',
    'reports instead.',
    '',
    'A bare run does not inherit the ambient login session: set CLAUDE_CODE_OAUTH_TOKEN',
    'from `claude setup-token`, or write the bare token to ~/.config/bare-claude/oauth',
    '(chmod 600). Put bare-claude on PATH from a checkout with',
    '`bun run install:user`; `bun run install:status` and `bun run install:uninstall`',
    'inspect and remove it.',
    '',
  ].join('\n'));
}

/**
 * `--config` and `--no-config` as a {@link ConfigSource}. Neither means the
 * located `bare-claude.yaml`; both is a contradiction, refused.
 */
function configSource(file: string | undefined, none: boolean | undefined): ConfigSource {
  if (file !== undefined && none) {
    throw new Error('--config and --no-config cannot be given together');
  }
  if (none) {
    return { kind: 'none' };
  }
  if (file === undefined) {
    return { kind: 'located' };
  }
  if (file === '') {
    throw new Error('--config needs a file');
  }
  return { kind: 'file', path: path.resolve(file) };
}

/**
 * Either a resolved preset to run, or an exit code for a mode that has already
 * done its work and produced its own output.
 */
type Startup = { kind: 'run', preset: Preset } | { kind: 'done', exitCode: number };

async function loadPreset(): Promise<Startup> {
  const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
      use: {
        type: 'string',
        short: 'u',
      },
      config: {
        type: 'string',
      },
      'no-config': {
        type: 'boolean',
      },
      launcher: {
        type: 'string',
        short: 'l',
      },
      'claude-path': {
        type: 'string',
      },
      'token-file': {
        type: 'string',
      },
      auth: {
        type: 'string',
      },
      'claude-home': {
        type: 'string',
      },
      model: {
        type: 'string',
        short: 'm',
      },
      verbose: {
        type: 'boolean',
      },
      read: {
        type: 'string',
        short: 'r',
        multiple: true
      },
      // TODO: support emitBash() as well?
      debug: {
        type: 'boolean',
      },
      quiet: {
        type: 'boolean',
        short: 'q',
      },
      print: {
        type: 'boolean',
        short: 'p',
      },
      version: {
        type: 'boolean',
        short: 'v',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
      display: {
        type: 'string',
      },
      usage: {
        type: 'boolean',
      },
      doctor: {
        type: 'boolean',
      },
      effort: {
        type: 'string',
      },
      tools: {
        type: 'string',
      },
      'disallowed-tools': {
        type: 'string',
      },
      'add-dir': {
        type: 'string',
        multiple: true,
      },
      'max-budget-usd': {
        type: 'string',
      },
      'max-tokens': {
        type: 'string',
      },
      'max-output-length': {
        type: 'string',
      },
      // Everything claude accepts that this CLI has no opinion about. `--` is
      // already spoken for as the call-to-action separator, so forwarding gets
      // its own repeatable flag rather than a second meaning for `--`.
      'claude-arg': {
        type: 'string',
        multiple: true,
      },
      'stop-grace-ms': {
        type: 'string',
      },
    },
    strict: true,
    allowPositionals: true,
  });

  positionals.shift(); // Bun
  positionals.shift(); // Script name

  if (values.help) {
    displayHelp();
    return { kind: 'done', exitCode: 0 };
  }

  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return { kind: 'done', exitCode: 0 };
  }

  if (values.display) {
    const result = Bun.JSONL.parse(await Bun.file(values.display).text());
    // One renderer for the whole file: it is what remembers which tool a
    // tool_result answers, and that pairing spans events.
    const renderer = new TranscriptRenderer({
      // TODO: These probably should also come from the preset?
      debug: Boolean(values.debug),
      verbose: Boolean(values.verbose)
    });
    for (const event of result) {
      process.stdout.write(renderer.display(event));
    }
    return { kind: 'done', exitCode: 0 };
  }

  if (values.usage) {
    const report = await readUsage({ claudePath: values['claude-path'] });
    if (report === null) {
      process.stderr.write('No usable subscription usage data: not a subscription session,'
        + ' or Claude Code reported nothing recent enough to trust\n');
      return { kind: 'done', exitCode: 1 };
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return { kind: 'done', exitCode: 0 };
  }

  const source = configSource(values.config, values['no-config']);

  const fromCli: DynamicPreset = {};
  const set = <K extends keyof DynamicPreset>(key: K, value: DynamicPreset[K] | undefined) => {
    if (value !== undefined) {
      fromCli[key] = value;
    }
  };

  set('launcher', parseLauncher(values.launcher));
  set('claudePath', values['claude-path']);
  set('tokenFile', values['token-file']);
  set('auth', parseAuth(values.auth));
  set('ephemeralClaudeHomePath', values['claude-home']);
  set('model', values.model);
  set('read', values.read);
  set('verbose', values.verbose);
  set('debug', values.debug);
  set('quiet', values.quiet);
  set('print', values.print);
  set('effortLevel', parseEffort(values.effort));
  set('tools', parseToolList(values.tools));
  set('disallowedTools', parseToolList(values['disallowed-tools']));
  set('addDirs', values['add-dir']);
  set('maxBudgetUsd', parseNumber('max-budget-usd', values['max-budget-usd']));
  set('maxTokens', parseNumber('max-tokens', values['max-tokens']));
  set('maxOutputLength', parseNumber('max-output-length', values['max-output-length']));
  set('extraArgs', values['claude-arg']);
  set('stopGraceMs', parseGrace(values['stop-grace-ms']));

  if (values.doctor) {
    // The same configuration, overrides and `use` a run would merge, so the
    // doctor checks the invocation a run would make, not the shell around it.
    const report = await runDoctor({ config: source, use: values.use, overrides: fromCli });
    process.stdout.write(formatDoctorReport(report));
    return { kind: 'done', exitCode: report.ok ? 0 : 1 };
  }

  // No positional call to action: take it from stdin when piped into. Guarded
  // on isTTY, or an interactive `bare-claude --use=x` would block on a
  // terminal read instead of reporting the missing callToAction.
  set('callToAction', positionals.length > 0
    ? positionals.join(' ')
    : (process.stdin.isTTY ? undefined : (await Bun.stdin.text()).trim() || undefined));

  return { kind: 'run', preset: resolveInvocation(await loadConfig(source), fromCli, values.use) };
}

function isLauncher(value: string): value is Launcher {
  return value in Launchers;
}

function parseLauncher(value: string | undefined): Launcher | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isLauncher(value)) {
    throw new Error(
      `Unknown launcher "${value}", known launchers are ${Object.keys(Launchers).join(', ')}`
    );
  }
  return value;
}

function parseAuth(value: string | undefined): AuthMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const mode = authMode(value);
  if (mode instanceof type.errors) {
    throw new Error(`--auth ${mode.summary}`);
  }
  return mode;
}

/**
 * An unknown effort level reaches both `--effort` and the generated
 * `settings.json`, where an invalid value invalidates the file and Claude Code
 * drops the whole thing without a word in `--print` mode. Refuse it here.
 */
function parseEffort(value: string | undefined): EffortLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const level = effortLevel(value);
  if (level instanceof type.errors) {
    throw new Error(`--effort ${level.summary}`);
  }
  return level;
}

/** Comma-separated tool names; the empty string means "none", not "unset". */
function parseToolList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === '' ? [] : value.split(',');
}

function parseGrace(value: string | undefined): number | undefined {
  const parsed = parseNumber('stop-grace-ms', value);
  if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 0)) {
    throw new Error(`--stop-grace-ms expects a whole number of milliseconds, got "${value}"`);
  }
  return parsed;
}

function parseNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} expects a number, got "${value}"`);
  }
  return parsed;
}

/** Credential variables, whose values a `--debug` dump of the preset must not print. */
const credentialVariables = new Set([ tokenVariable, ...alternateCredentialVariables ]);

/**
 * `JSON.stringify` replacer hiding the value of any credential variable, at
 * any depth of the dump — beyond the environment blocks {@link debugView}
 * already withholds. By name only: a secret under any other name, outside
 * those blocks, is printed.
 */
function redactCredentials(key: string, value: unknown): unknown {
  return credentialVariables.has(key) && typeof value === 'string' ? '<redacted>' : value;
}

/** How `--debug` shows a value it does not print. */
function withheld(value: Json): string {
  return typeof value === 'string' ? `<${value.length} characters, not printed>` : '<not printed>';
}

/** An environment block with its names kept and every value withheld. */
function withheldEnv(env: Record<string, Json>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([ name, value ]) => [ name, withheld(value) ]));
}

/**
 * The preset as `--debug` prints it. Withheld, by where they sit rather than
 * by what they are called: every value of `extraEnv` and `extraSettings.env`
 * — the two places a credential is passed, under whatever name — and an
 * in-memory session journal, a prior conversation that may hold anything
 * anyone typed or any tool read. Names and sizes are kept, so the dump still
 * shows what was set. Everything else is printed as given: `extraArgs`, the
 * rest of `extraSettings`, the prompt, paths.
 */
function debugView(preset: Preset): Preset {
  const view: Preset = { ...preset };
  if (preset.extraEnv !== undefined) {
    view.extraEnv = withheldEnv(preset.extraEnv);
  }
  const settingsEnv = preset.extraSettings?.env;
  if (preset.extraSettings !== undefined && typeof settingsEnv === 'object'
    && settingsEnv !== null && !Array.isArray(settingsEnv)) {
    view.extraSettings = { ...preset.extraSettings, env: withheldEnv(settingsEnv) };
  }
  const seed = preset.customSessionData;
  if (seed !== undefined && seed !== null && 'value' in seed) {
    view.customSessionData = { ...seed, value: withheld(seed.value) };
  }
  return view;
}

async function main() {
  const startup = await loadPreset();
  if (startup.kind === 'done') {
    return startup.exitCode;
  }
  const { preset } = startup;

  if (preset.debug) {
    process.stdout.write(`Configuration:\n${JSON.stringify(debugView(preset), redactCredentials, 2)}\n`);
  }

  // Resolved now for its refusals alone — an unknown or contradictory auth
  // mode, a session id that cannot name a file — so they land before a
  // preload has run anybody's shell command.
  LaunchConfig(preset);

  // The run's own directory, resolved exactly as spawnClaude will resolve it:
  // what the child runs in, and so what preloads resolve against and the
  // synthetic records claim. A cwd that does not exist is refused here,
  // before any preload has run.
  const cwd = await physicalCwd(preset.cwd ?? process.cwd());

  // `--read` is preload's file/glob case; both routes go through the same
  // resolver so they share one byte budget and one set of skip rules.
  const entries: PreloadEntry[] = [
    ...(preset.read ?? []).map(pattern => glob(pattern)),
    ...(preset.preload ?? []),
  ];

  if (entries.length > 0) {
    const seed = preset.customSessionData;
    if (seed !== undefined && seed !== null && 'sourcePath' in seed) {
      // A file seed is cloned, never read into memory, and preloads would
      // have to be appended to a journal that does not exist until spawn.
      throw new Error(
        'read and preload cannot extend a file session seed (customSessionData.sourcePath): '
        + 'it is cloned, never byte-copied; give the prior journal as customSessionData.value '
        + 'to rebuild it in memory instead'
      );
    }

    const sessionId = seed?.sessionId ?? Bun.randomUUIDv7();

    const claudePath = preset.claudePath ?? 'claude';

    // TODO: Load Claude Code version and git branch from preset,
    //       make sure they are filled with defaults there.
    const builder = new SessionBuilder(
      sessionId,
      (await $ `${claudePath} --version`.text()).replace(' (Claude Code)', '').trim(),
      cwd,
      (await $`git branch --show-current`.cwd(cwd).text()).trim(),
      // Not '<synthetic>': Claude Code reserves that marker for API-error
      // messages, and every assistant display rule excludes it, so preloaded
      // tool calls would render as raw JSON or not at all.
      preset.model ?? '<bare-claude>',
      preset.effortLevel // undefined selects the builder's own default
    );

    const spent = { bytes: 0 };
    for (const entry of entries) {
      await emitPreload(builder, entry, { cwd }, spent);
    }

    // TODO: Weirdly convoluted. Redesign?
    // Every record, including the last, must end in a newline: Claude Code
    // appends to this file, and without it the child's first record lands on
    // the same physical line as ours, where JSONL parsing silently loses one
    // of the two.
    const previous = seed?.value ?? '';
    const prefix = (previous === '' || previous.endsWith('\n')) ? previous : `${previous}\n`;
    preset.customSessionData = {
      sessionId,
      value: `${prefix}${builder.commit(defaultMaxContentBytes).map(e => JSON.stringify(e)).join('\n')}\n`,
    };
  }

  preset.permissionMode ??= 'acceptEdits';

  // The library's own supervision, installed before the spawn so a signal
  // that arrives meanwhile is held rather than ending this process and
  // orphaning a child about to exist.
  const supervisor = superviseSignals({
    graceMs: preset.stopGraceMs ?? defaultStopGraceMs,
    onEvent: event => process.stderr.write(describeSupervisorEvent(event)),
  });

  // A process group of its own, so a stop reaches what the spawned process
  // starts — a launcher's native child included — and a terminal's Ctrl-C
  // reaches the run only through the supervisor, in order.
  const claude = await spawnClaude(preset, {
    stdout: preset.print ? 'inherit' : 'pipe',
    detached: process.platform !== 'win32',
  }).catch((error: unknown) => {
    supervisor.release();
    throw error;
  });

  // Attached before anything else can throw — a write to a closed stdout or
  // stderr included — and everything after it is inside the try whose
  // finally finishes supervision: a detached child is never left running
  // with nobody to stop it.
  supervisor.attach(claude);

  // A failed or inspected run keeps its ephemeral home: disposing it would
  // delete the very transcript the path above points at. A home the caller
  // named is theirs and is always kept; dispose() would not touch it anyway,
  // but the report below should say where it is.
  const callerHome = typeof preset.ephemeralClaudeHomePath === 'string';
  const keepDeclared = callerHome || preset.verbose || preset.debug;
  let keepHome = keepDeclared;
  let capture: Capture | null = null;

  try {
    // An unread pipe eventually fills and blocks the child, so drain it even
    // when --print did not ask for it. What it says is the only diagnostic a
    // failed launch produces — Claude Code reports "Not logged in" here and
    // then exits 1, sometimes without writing a session file at all.
    const stdout = claude.subprocess.stdout;
    capture = stdout instanceof ReadableStream ? captureTail(stdout) : null;

    if (preset.verbose || preset.debug) {
      process.stdout.write(`${claude.sessionJsonlPath}\n`);
    }

    // Reported as soon as the child exists, not at the end only: a runner that
    // has to kill this process outright still knows which process group to end
    // — for every run, since the child is outside this process's own group and
    // a kill aimed there no longer reaches it — and, for a kept home, where the
    // session journal is (the child creates it, so it may not exist yet).
    if (keepDeclared) {
      process.stderr.write(`Claude session journal at ${claude.sessionJsonlPath}\n`);
    }
    process.stderr.write(claude.processGroup === null
      ? `Claude process ${claude.subprocess.pid}\n`
      : `Claude process group ${claude.processGroup}\n`);

    if (!preset.quiet) {
      await renderTranscript(claude, preset);
    }

    const exitCode = await claude.subprocess.exited;
    // What the spawned process left in its group, when a stop is under way.
    await supervisor.finish();
    const stoppedBy = supervisor.stoppedBy;

    if (exitCode !== 0 || stoppedBy !== null) {
      keepHome = true;

      if (capture !== null) {
        // Bounded: a descendant can hold the pipe open long after the child
        // has gone.
        const tail = (await within(capture.tail, capturedWaitMs, '')).trim();
        if (tail !== '') {
          process.stderr.write(`${tail}\n`);
        }
      }
    }

    // The shell convention for a command ended by a signal, whatever the
    // child's own exit was: a runner must not read a stopped run as a
    // completed one.
    return stoppedBy === null ? exitCode : signalExitStatus(stoppedBy);
  } finally {
    // Never rm a live config directory out from under a running child: a
    // failure above still ends the run in order before anything is removed.
    // Idempotent, so on the ordinary path this is the report awaited above.
    const report = await supervisor.finish();

    // The pipe is this process's own, made for this run. Something the run
    // left behind can hold it open indefinitely, and a read still pending on
    // it would keep this process from exiting; nothing more is wanted from it.
    capture?.stop();

    // Something the run started may have outlived it. Reported, not acted on:
    // nobody asked for a stop, and it may be work the run deliberately left
    // running. Nor is the home removed under it, since it may still be using
    // it. A group that answers EPERM throughout the recheck is not known to
    // be empty, so it keeps the home too.
    const groupState = report === null && claude.processGroup !== null
      ? (await readProcessGroup(claude.processGroup)).state
      : null;
    if (groupState !== null && groupState !== 'empty') {
      keepHome = true;
    }

    if (report !== null || keepHome) {
      process.stderr.write(`Claude process ended: ${describeEnd(claude.subprocess)}\n`);
    }
    if (report !== null) {
      process.stderr.write(`${describeStop(report)}\n`);
    } else if (groupState === 'occupied') {
      process.stderr.write(
        `bare-claude: claude exited, but process group ${claude.processGroup} still has processes; `
        + 'they were not signalled and may still be running\n'
      );
    } else if (groupState === 'not-permitted') {
      process.stderr.write(
        `bare-claude: claude exited, but process group ${claude.processGroup} was ${notShownEmpty}; `
        + 'nothing in it was signalled\n'
      );
    }

    if (keepHome) {
      process.stderr.write(`Claude home kept at ${claude.ephemeralClaudeHomePath}\n`);
      // A fresh handle: the child created this file after any earlier check.
      if (!keepDeclared && await Bun.file(claude.sessionJsonlPath).exists()) {
        process.stderr.write(`Claude session journal at ${claude.sessionJsonlPath}\n`);
      }
    } else {
      await claude.dispose();
    }
  }
}

/** One stderr line for each thing the supervisor did. */
function describeSupervisorEvent(event: SupervisorEvent): string {
  switch (event.kind) {
    case 'held':
      return `bare-claude: received ${event.signal} while starting claude; stopping it once started\n`;
    case 'stopping': {
      const target = event.processGroup === null ? 'it' : `process group ${event.processGroup}`;
      const why = event.cause === 'finish'
        ? `bare-claude: claude is still running; sent SIGTERM to it (pid ${event.pid})`
        : `bare-claude: received ${event.cause}; sent it to claude (pid ${event.pid})`;
      return `${why}, SIGKILL to ${target} after ${event.graceMs} ms\n`;
    }
    case 'escalating':
      return `bare-claude: received ${event.signal} again; sending SIGKILL now\n`;
    case 'after-exit':
      return `bare-claude: received ${event.signal} after claude had exited; nothing to stop\n`;
  }
}

/**
 * How long a stopped run gets before SIGKILL, unless `--stop-grace-ms` says
 * otherwise. Chosen, not measured: how long Claude Code takes to shut down
 * on SIGTERM has not been observed.
 */
const defaultStopGraceMs = 10_000;

/** How long to wait for the child's stdout to close once the child has exited. */
const capturedWaitMs = 1_000;

/** `promise`'s value, or `fallback` once `ms` have passed; no timer is left behind. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    return await Promise.race([
      promise,
      new Promise<T>(resolve => {
        timers.push(setTimeout(() => resolve(fallback), ms));
      }),
    ]);
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  }
}

/** How the spawned process ended, as Bun reports it. */
function describeEnd(subprocess: { exitCode: number | null, signalCode: NodeJS.Signals | null }): string {
  if (subprocess.signalCode !== null) {
    return `signal ${subprocess.signalCode}`;
  }
  return subprocess.exitCode === null ? 'not observed' : `exit code ${subprocess.exitCode}`;
}

/**
 * What a group that read `not-permitted` to the end of {@link readProcessGroup}'s
 * recheck shows, and what it does not.
 */
const notShownEmpty = `not shown empty: signal 0 failed with EPERM for ${notPermittedRecheckMs} ms, which shows neither what is left nor whose it is`;

/** One line saying how a stop went, and what it left. */
function describeStop(report: StopReport): string {
  const sent = report.escalated ? `${report.signal}, then SIGKILL` : report.signal;
  if (report.processGroup === null) {
    return `Claude stop: ${sent}; no process group, so descendants of the spawned process were not signalled`;
  }
  const left = {
    'empty': 'empty',
    'occupied': report.escalated ? 'still occupied after SIGKILL' : 'occupied; it was not sent SIGKILL',
    'not-permitted': notShownEmpty,
  } satisfies Record<NonNullable<StopReport['groupState']>, string>;
  return `Claude stop: ${sent}; process group ${report.processGroup} ${left[report.groupState ?? 'empty']}`;
}

/** Longest run of child stdout kept for a failure diagnostic. */
const maxCapturedStdout = 4096;

/** A drain of the child's stdout, and the means to stop reading it. */
interface Capture {
  /** The last {@link maxCapturedStdout} characters, once the stream ends or reading stops. */
  tail: Promise<string>,

  /** Stops reading; the stream is cancelled and `tail` resolves with what was read. */
  stop(): void,
}

/** Drains a stream, keeping only its last {@link maxCapturedStdout} characters. */
function captureTail(stream: ReadableStream<Uint8Array>): Capture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  const read = async (): Promise<string> => {
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-maxCapturedStdout);
      }
    } catch {
      // A cancelled or broken pipe ends the capture; what was read stands.
    }
    return (tail + decoder.decode()).slice(-maxCapturedStdout);
  };
  return {
    tail: read(),
    stop: () => {
      reader.cancel().catch(() => { /* Already closed. */ });
    },
  };
}

/**
 * Streams the session transcript to stdout until the child exits.
 * Returns without output when the child dies before creating a session file.
 */
async function renderTranscript(
  claude: Awaited<ReturnType<typeof spawnClaude>>,
  preset: Preset
): Promise<void> {
  // A fresh handle per check: Bun.file() caches its stat, so a handle taken
  // before the child creates the session file reports it missing forever.
  const sessionFileExists = () => Bun.file(claude.sessionJsonlPath).exists();

  if (!await sessionFileExists()) {
    // The child may exit before ever creating the session file — a crash, a
    // refused launch, a rejected flag. Aborting the watch on exit is what
    // keeps that case from hanging here forever.
    const abort = new AbortController();
    const watcher = watch(claude.projectHomePath, { signal: abort.signal });
    const basename = path.basename(claude.sessionJsonlPath);
    void claude.subprocess.exited.then(() => abort.abort());

    try {
      for await (const event of watcher) {
        if (event.filename === basename) {
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'AbortError') {
        throw error;
      }
    } finally {
      abort.abort();
    }

    if (!await sessionFileExists()) {
      return;
    }
  }

  let buffer = '';
  // How many records the live tail has already rendered, so the reconciliation
  // below can pick up exactly where it stopped.
  let rendered = 0;
  // One decoder for the whole stream: a chunk boundary can fall inside a
  // multi-byte character, and decoding each chunk on its own mangles it.
  const decoder = new TextDecoder();
  // One renderer for the whole stream, shared with the final-chunk loop below:
  // it holds the tool_use -> tool_result pairing, and a call and its result can
  // straddle that boundary.
  const renderer = new TranscriptRenderer(preset);
  const tail = new TailFile(claude.sessionJsonlPath, { startPos: 0 });
  tail
    .on('data', (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true });

      const result = Bun.JSONL.parseChunk(buffer);
      for (const event of result.values) {
        process.stdout.write(renderer.display(event));
        rendered++;
      }

      buffer = buffer.slice(result.read);
    })
    // TailFile emits on a Readable: an unhandled 'error' would take the whole
    // process down, and quit() re-emits whatever killed the tail.
    .on('error', (error: Error) => {
      process.stderr.write(`transcript tail failed: ${error.message}\n`);
    })
    .on('tail_error', (error: Error) => {
      process.stderr.write(`transcript tail failed: ${error.message}\n`);
    });

  // start() is awaited so a failure to open surfaces here rather than as an
  // unhandled rejection, and so quit() can never race an unfinished start.
  await tail.start();

  await claude.subprocess.exited;
  await tail.quit();

  // TailFile polls. A subprocess that writes its whole transcript and exits
  // between two polls delivers nothing at all, so the live stream is a fast
  // path, not the source of truth — reconcile against the file itself and
  // render whatever the tail did not reach. Counting records rather than bytes
  // keeps this immune to a chunk boundary landing inside a character.
  const final = Bun.JSONL.parseChunk(await Bun.file(claude.sessionJsonlPath).text());
  for (const event of final.values.slice(rendered)) {
    process.stdout.write(renderer.display(event));
  }
  if (final.error) {
    process.stderr.write(`unable to parse final jsonl chunk: ${final.error.message}\n`);
  }
}

// A refused call to action, an unknown preset or launcher, a malformed config:
// all of these are the user's mistake, not ours. Report the message, keep the
// stack trace for --debug.
process.exitCode = await main().catch((error: unknown) => {
  if (error instanceof Error && !Bun.argv.includes('--debug')) {
    process.stderr.write(`bare-claude: ${error.message}\n`);
    return 1;
  }
  throw error;
});
