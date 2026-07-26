#!/usr/bin/env bun

import { $ } from 'bun';

import { parseArgs } from 'node:util';
import path from 'node:path';
import { watch } from 'node:fs/promises';

import TailFile from '@logdna/tail-file';
import { type } from 'arktype';

import { Launchers, spawnClaude, type Launcher } from '@agladysh/bare-claude';
import { TranscriptRenderer } from '@agladysh/bare-claude/display';
import {
  defaultMaxContentBytes, emitPreload, glob, type PreloadEntry
} from '@agladysh/bare-claude/preload';
import { SessionBuilder } from '@agladysh/bare-claude/SessionBuilder';

import pkg from '../package.json';
import {
  effortLevel, emptyConfig, parseConfig, type Config, type EffortLevel
} from '@agladysh/bare-claude/config';
import { resolvePreset, type DynamicPreset, type Preset } from '@agladysh/bare-claude/preset';
import { readUsage } from '@agladysh/bare-claude/usage';
import { deepmerge } from 'deepmerge-ts';

///////////////////////////////////////////////////////////////////////////////

function displayHelp() {
  process.stdout.write([
    `Usage: ${Object.keys(pkg.bin)[0]} [options] -- "call to action"`,
    '',
    'Options:',
    '  -u, --use <preset>     Use configuration preset from bare-claude.yaml',
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
    '',
    '      --verbose          Print more events in the transcript',
    '      --debug            Print the resolved configuration and unrecognized events',
    '      --display <file>   Render an existing session JSONL and exit',
    '      --usage            Report subscription usage as JSON and exit',
    '  -v, --version          Print the version and exit',
    '  -h, --help             Print this help and exit',
    '',
    'The call to action is read from stdin when no positional one is given.',
    'Exits with the exit code of the `claude` subprocess.',
    '',
  ].join('\n'));
}

async function loadConfig(): Promise<Config> {
  // TODO: Use cosmiconfig instead?
  // TODO: Verify this handles git submodules and git worktrees correctly.
  const rootDir = (await $ `git rev-parse --show-toplevel`.text()).trim();
  const configPath = path.join(rootDir, 'bare-claude.yaml');
  const configFile = Bun.file(configPath);
  if (!await configFile.exists()) {
    return emptyConfig();
  }

  return parseConfig(await configFile.text(), configPath);
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
      launcher: {
        type: 'string',
        short: 'l',
      },
      'claude-path': {
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

  // No positional call to action: take it from stdin when piped into. Guarded
  // on isTTY, or an interactive `bare-claude --use=x` would block on a
  // terminal read instead of reporting the missing callToAction.
  const callToAction = positionals.length > 0
    ? positionals.join(' ')
    : (process.stdin.isTTY ? undefined : (await Bun.stdin.text()).trim() || undefined);

  const fromCli: DynamicPreset = {};
  const set = <K extends keyof DynamicPreset>(key: K, value: DynamicPreset[K] | undefined) => {
    if (value !== undefined) {
      fromCli[key] = value;
    }
  };

  set('callToAction', callToAction);
  set('launcher', parseLauncher(values.launcher));
  set('claudePath', values['claude-path']);
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

  const { configPreset, presets } = await loadConfig();
  const preset = deepmerge(configPreset, fromCli);
  if (values.use) {
    preset.use = values.use; // The use field is not merged.
  }

  return { kind: 'run', preset: resolvePreset(preset, presets) };
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

async function main() {
  const startup = await loadPreset();
  if (startup.kind === 'done') {
    return startup.exitCode;
  }
  const { preset } = startup;

  if (preset.debug) {
    process.stdout.write(`Configuration:\n${JSON.stringify(preset, null, 2)}\n`);
  }

  // `--read` is preload's file/glob case; both routes go through the same
  // resolver so they share one byte budget and one set of skip rules.
  const entries: PreloadEntry[] = [
    ...(preset.read ?? []).map(pattern => glob(pattern)),
    ...(preset.preload ?? []),
  ];

  if (entries.length > 0) {
    const sessionId = preset.customSessionData?.sessionId ?? Bun.randomUUIDv7();

    const claudePath = preset.claudePath ?? 'claude';

    // TODO: Load Claude Code version and git branch from preset,
    //       make sure they are filled with defaults there.
    const builder = new SessionBuilder(
      sessionId,
      (await $ `${claudePath} --version`.text()).replace(' (Claude Code)', '').trim(),
      process.cwd(),
      (await $`git branch --show-current`.text()).trim(),
      // Not '<synthetic>': Claude Code reserves that marker for API-error
      // messages, and every assistant display rule excludes it, so preloaded
      // tool calls would render as raw JSON or not at all.
      preset.model ?? '<bare-claude>',
      preset.effortLevel // undefined selects the builder's own default
    );

    const spent = { bytes: 0 };
    for (const entry of entries) {
      await emitPreload(builder, entry, { cwd: process.cwd() }, spent);
    }

    // TODO: Weirdly convoluted. Redesign?
    // Every record, including the last, must end in a newline: Claude Code
    // appends to this file, and without it the child's first record lands on
    // the same physical line as ours, where JSONL parsing silently loses one
    // of the two.
    const previous = preset.customSessionData?.value ?? '';
    const prefix = (previous === '' || previous.endsWith('\n')) ? previous : `${previous}\n`;
    preset.customSessionData = {
      sessionId,
      value: `${prefix}${builder.commit(defaultMaxContentBytes).map(e => JSON.stringify(e)).join('\n')}\n`,
    };
  }

  preset.permissionMode ??= 'acceptEdits';

  const claude = await spawnClaude(preset, { stdout: preset.print ? 'inherit' : 'pipe' });

  // An unread pipe eventually fills and blocks the child, so drain it even
  // when --print did not ask for it. What it says is the only diagnostic a
  // failed launch produces — Claude Code reports "Not logged in" here and
  // then exits 1, sometimes without writing a session file at all.
  const stdout = claude.subprocess.stdout;
  const captured = stdout instanceof ReadableStream ? captureTail(stdout) : null;

  if (preset.verbose || preset.debug) {
    process.stdout.write(`${claude.sessionJsonlPath}\n`);
  }

  // A failed or inspected run keeps its ephemeral home: disposing it would
  // delete the very transcript the path above points at.
  let keepHome = preset.verbose || preset.debug;

  try {
    if (!preset.quiet) {
      await renderTranscript(claude, preset);
    }

    const exitCode = await claude.subprocess.exited;

    if (exitCode !== 0) {
      keepHome = true;

      if (captured !== null) {
        const tail = (await captured).trim();
        if (tail !== '') {
          process.stderr.write(`${tail}\n`);
        }
      }
    }

    return exitCode;
  } finally {
    // Never rm a live config directory out from under a running child.
    if (claude.subprocess.exitCode === null) {
      claude.subprocess.kill();
      await claude.subprocess.exited;
    }

    if (keepHome) {
      process.stderr.write(`Claude home kept at ${claude.ephemeralClaudeHomePath}\n`);
    } else {
      await claude.dispose();
    }
  }
}

/** Longest run of child stdout kept for a failure diagnostic. */
const maxCapturedStdout = 4096;

/** Drains a stream, keeping only its last {@link maxCapturedStdout} characters. */
async function captureTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let tail = '';
  for await (const chunk of stream) {
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-maxCapturedStdout);
  }
  return (tail + decoder.decode()).slice(-maxCapturedStdout);
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
