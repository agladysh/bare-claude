import { afterEach, describe, expect, test } from 'bun:test';

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cloneBranch, cloneRequired, eventually, processGone } from '../test/helpers.ts';
import {
  completionScope, configurationScope, custodyFiles, custodyReadingScope, custodyReadingVersion, custodyVersion,
  readCustody, runInCustody, stdoutProvenance,
  type CustodyConfiguration, type CustodyEvent, type CustodyOptions, type CustodyReading, type CustodyStart,
} from './custody.ts';
import type { LaunchOptions } from './index.ts';
import { processGroupState, type SignalSource, type StopSignal } from './lifecycle.ts';
import { processScope } from './outcome.ts';

/**
 * Custody of real processes: the fake `claude` under test/, run with
 * `noProcessEnv` and a PATH holding only Bun, so no credential of this
 * process reaches it, and a few lines of `sh` or Bun where a launcher is
 * needed. Signals are delivered through a {@link SignalSource} of the test's
 * own, never to the test process. The CLI's custody mode is tested end to end
 * in `test/custody.cli.test.ts`.
 */

const posix = process.platform === 'darwin' || process.platform === 'linux';
const fakeClaude = path.join(import.meta.dir, '..', 'test', 'fake-claude', 'claude');
const bunDir = path.dirname(process.execPath);

/** Signals delivered by the test, to whoever is listening. */
class TestSignals implements SignalSource {
  private readonly listeners = new Map<StopSignal, Set<() => void>>();

  on(signal: StopSignal, listener: () => void): void {
    const set = this.listeners.get(signal) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(signal, set);
  }

  off(signal: StopSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  send(signal: StopSignal): void {
    for (const listener of [ ...this.listeners.get(signal) ?? [] ]) {
      listener();
    }
  }

  get listening(): number {
    return [ ...this.listeners.values() ].reduce((total, set) => total + set.size, 0);
  }
}

const roots: string[] = [];
const groups: number[] = [];

afterEach(async () => {
  // Only groups these tests' runs led, and only while something is in them.
  for (const group of groups.splice(0)) {
    if (processGroupState(group) === 'occupied') {
      try {
        process.kill(-group, 'SIGKILL');
      } catch { /* Emptied in between. */ }
    }
  }
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-custody-')));
  roots.push(dir);
  return dir;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function digestOf(file: string): Promise<string> {
  return createHash('sha256').update(new Uint8Array(await Bun.file(file).arrayBuffer())).digest('hex');
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await Bun.file(file).text());
}

/** A file's text, or null while it does not exist; a fresh handle every time (CLAUDE.md). */
async function textOf(file: string): Promise<string | null> {
  try {
    return await Bun.file(file).text();
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

function startsIn(events: CustodyEvent[]): CustodyStart[] {
  return events.flatMap(event => event.kind === 'started' ? [ event.start ] : []);
}

type Observed = Extract<CustodyEvent, { kind: 'observed' }>;

function observedIn(events: CustodyEvent[]): Observed | null {
  const found = events.flatMap(event => event.kind === 'observed' ? [ event ] : []);
  expect(found).toHaveLength(1);
  return found[0] ?? null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every object key anywhere in `value`. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysIn);
  }
  return isRecordValue(value) ? Object.entries(value).flatMap(([ key, inner ]) => [ key, ...keysIn(inner) ]) : [];
}

/** A record's JSON text with `change` made to it. */
function edited(text: string, change: (record: Record<string, unknown>) => void): string {
  const parsed: unknown = JSON.parse(text);
  if (!isRecordValue(parsed)) {
    throw new Error('not a JSON object');
  }
  change(parsed);
  return JSON.stringify(parsed);
}

/** A result in the shape `--output-format json` writes, every value constructed. */
const constructedResult = JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, terminal_reason: 'blocking_limit', result: 'Prompt is too long',
  stop_reason: 'constructed_stop', session_id: 'constructed-session', total_cost_usd: 1.5, duration_api_ms: 100,
  duration_ms: 50,
  usage: {
    input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4,
    iterations: [ { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } ],
  },
});

const readingKeys = [
  'format', 'version', 'scope', 'reader', 'directory', 'read', 'state', 'basis', 'problems', 'entries',
  'writtenIn', 'invocation', 'start', 'completion', 'stdout', 'stderr', 'journal', 'join',
];

/** A seed whose history holds an earlier process's context-limit record; every value constructed. */
const priorSession = 'prior-session';
const priorJournal = [
  { type: 'user', sessionId: priorSession, message: { role: 'user', content: 'earlier' } },
  {
    type: 'assistant', sessionId: priorSession, isApiErrorMessage: true, error: 'invalid_request',
    message: { model: '<synthetic>', role: 'assistant', content: [ { type: 'text', text: 'Prompt is too long' } ] },
  },
].map(record => JSON.stringify(record)).join('\n') + '\n';

/** Whether any segment of a journal reading holds a context-limit API error. */
function holdsContextLimit(reading: { segments: { apiErrors: { contextLimit: boolean }[] }[] } | null | undefined): boolean {
  return (reading?.segments ?? []).some(segment => segment.apiErrors.some(error => error.contextLimit));
}

const stdoutKeys = [
  'path', 'file', 'why', 'atCompletion', 'changedSinceCompletion', 'writtenBy', 'provenance', 'outputFormat', 'result',
];

/** A run in custody under a temporary root, its events collected, not yet awaited. */
async function begin(
  launch: Partial<LaunchOptions> = {},
  env: Record<string, string> = {},
  options: Partial<CustodyOptions> = {},
) {
  const root = await tempDir();
  const directory = path.join(root, 'run');
  const signals = new TestSignals();
  const events: CustodyEvent[] = [];
  const completion = runInCustody({
    callToAction: '# do the thing',
    claudePath: fakeClaude,
    noProcessEnv: true,
    auth: 'caller',
    cwd: root,
    ...launch,
  }, {
    directory,
    graceMs: 5_000,
    source: signals,
    onEvent: event => {
      events.push(event);
      if (event.kind === 'started' && event.start.processGroup !== null) {
        groups.push(event.start.processGroup);
      }
    },
    env: { PATH: bunDir, ...env },
    ...options,
  });
  return { root, directory, signals, events, completion };
}

const completionKeys = [
  'format', 'version', 'scope', 'ended', 'outcome', 'notStarted', 'exitStatus', 'exitCode', 'signalCode',
  'stoppedBy', 'stop', 'processGroupAfter', 'custodyError', 'stdout', 'stderr', 'journal',
];

describe.if(posix)('runInCustody', () => {
  test('a run that ends on its own: its records, its raw output byte for byte, and its journal as read', async () => {
    const run = await begin({}, { FAKE_CLAUDE_STDOUT: 'raw out\n', FAKE_CLAUDE_STDERR: 'raw err\n' });
    const completion = await run.completion;
    const at = (name: string) => path.join(run.directory, name);

    expect((await fs.readdir(run.directory)).sort()).toEqual([
      custodyFiles.completion, custodyFiles.home, custodyFiles.invocation, custodyFiles.observation,
      custodyFiles.start, custodyFiles.stderr, custodyFiles.stdout,
    ].sort());
    expect((await fs.stat(run.directory)).mode & 0o777).toBe(0o700);

    expect(await readJson(at(custodyFiles.invocation))).toMatchObject({
      format: 'bare-claude/run-invocation',
      version: custodyVersion,
      launcher: 'claude',
      executable: fakeClaude,
      model: null,
      effortLevel: 'high',
      tools: null,
      auth: 'caller',
      linkAuth: false,
      noProcessEnv: true,
      extraArgs: [],
      cwd: run.root,
      claudeHome: at(custodyFiles.home),
      session: { kind: 'fresh' },
      callToAction: { bytes: Buffer.byteLength('# do the thing'), sha256: sha256('# do the thing'), kept: null },
    });

    const starts = startsIn(run.events);
    expect(starts).toHaveLength(1);
    const [ start ] = starts;
    expect(await readJson(at(custodyFiles.start))).toEqual(start);
    expect(start?.processGroup).toBe(start?.pid ?? -1);
    expect(start?.identity).toBeNull();
    expect(start?.sessionJsonlPath.startsWith(`${at(custodyFiles.home)}/`)).toBe(true);

    expect(completion).toMatchObject({
      format: 'bare-claude/run-completion',
      version: custodyVersion,
      scope: completionScope,
      outcome: 'exited',
      notStarted: null,
      exitStatus: 0,
      exitCode: 0,
      stoppedBy: null,
      stop: null,
      processGroupAfter: { state: 'empty' },
      custodyError: null,
      stdout: { file: at(custodyFiles.stdout), bytes: 8, sha256: sha256('raw out\n') },
      stderr: { file: at(custodyFiles.stderr), bytes: 8, sha256: sha256('raw err\n') },
    });
    expect(await Bun.file(at(custodyFiles.stdout)).text()).toBe('raw out\n');
    expect(await Bun.file(at(custodyFiles.stderr)).text()).toBe('raw err\n');

    const journal = start?.sessionJsonlPath ?? '';
    expect(completion.journal).toEqual({
      path: journal,
      sessionId: start?.sessionId ?? '',
      exists: true,
      bytes: (await fs.stat(journal)).size,
      sha256: await digestOf(journal),
    });

    expect(await readJson(at(custodyFiles.completion))).toEqual(completion);
    expect(run.events.map(event => event.kind)).toEqual([ 'started', 'completed', 'observed' ]);
    expect(run.events.at(1)).toEqual({ kind: 'completed', directory: run.directory, completion });
    expect(run.signals.listening).toBe(0);
  }, 20_000);

  test('a failed run is the child\'s own exit, and nothing in its output is read', async () => {
    const run = await begin({ extraArgs: [ '--output-format', 'json' ] }, {
      FAKE_CLAUDE_EXIT_CODE: '7',
      FAKE_CLAUDE_STDOUT: 'Not logged in · Please run /login\n',
    });
    const completion = await run.completion;

    expect(completion).toMatchObject({ outcome: 'exited', exitStatus: 7, exitCode: 7, stop: null });
    expect(Object.keys(completion).sort()).toEqual([ ...completionKeys ].sort());
    expect(await readJson(path.join(run.directory, custodyFiles.invocation)))
      .toMatchObject({ extraArgs: [ '--output-format', 'json' ] });
  }, 20_000);

  test.each([
    [ 'no result at all', '' ],
    [ 'a result cut short', '{"type":"result","is_err' ],
  ])('%s is kept as bytes, and judged by nobody here', async (_, written) => {
    const run = await begin({ extraArgs: [ '--output-format', 'json' ] }, { FAKE_CLAUDE_STDOUT: written });
    const completion = await run.completion;
    const stdout = path.join(run.directory, custodyFiles.stdout);

    expect(completion).toMatchObject({ outcome: 'exited', exitCode: 0, custodyError: null });
    expect(completion.stdout).toEqual({ file: stdout, bytes: Buffer.byteLength(written), sha256: sha256(written) });
    expect(await Bun.file(stdout).text()).toBe(written);
  }, 20_000);

  test('a signal stops the run: the output so far is kept, and the stop names the signal', async () => {
    const run = await begin({}, { FAKE_CLAUDE_STDOUT_FIRST: 'partial\n', FAKE_CLAUDE_SLEEP_MS: '30000' });
    const stdout = path.join(run.directory, custodyFiles.stdout);
    expect(await eventually(async () => await exists(path.join(run.directory, custodyFiles.start))
      && await textOf(stdout) === 'partial\n', 10_000)).toBe(true);

    run.signals.send('SIGTERM');
    const completion = await run.completion;

    expect(completion).toMatchObject({ outcome: 'stopped', stoppedBy: 'SIGTERM', processGroupAfter: { state: 'empty' } });
    expect(completion.stop?.cause).toBe('SIGTERM');
    expect(completion.stop?.report).toMatchObject({ signal: 'SIGTERM', groupState: 'empty' });
    expect(completion.processGroupAfter?.observations).toEqual(completion.stop?.report?.groupObservations ?? []);
    expect(completion.signalCode).toBe(completion.stop?.report?.signalCode ?? null);
    expect(completion.stdout).toMatchObject({ bytes: 8, sha256: sha256('partial\n') });
    expect(run.events.at(0)?.kind).toBe('started');
    expect(run.events.map(event => event.kind)).toContain('supervisor');
    expect(run.events.slice(-2).map(event => event.kind)).toEqual([ 'completed', 'observed' ]);
    const [ start ] = startsIn(run.events);
    expect(await eventually(() => processGone(start?.pid ?? 0), 5_000)).toBe(true);
  }, 30_000);

  test('cancelling stops the run, and is recorded as cancelled, not as a signal', async () => {
    const controller = new AbortController();
    const run = await begin({}, { FAKE_CLAUDE_STDOUT_FIRST: 'partial\n', FAKE_CLAUDE_SLEEP_MS: '30000' }, {
      signal: controller.signal,
    });
    expect(await eventually(async () => await textOf(path.join(run.directory, custodyFiles.stdout)) === 'partial\n', 10_000))
      .toBe(true);

    controller.abort();
    const completion = await run.completion;

    expect(completion).toMatchObject({ outcome: 'stopped', stoppedBy: null });
    expect(completion.stop?.cause).toBe('cancelled');
    expect(completion.stop?.report?.signal).toBe('SIGTERM');
    expect(completion.stdout?.bytes).toBe(8);
  }, 30_000);

  test('custody begins in a fresh directory: an existing one is refused and left as it was', async () => {
    const root = await tempDir();
    const directory = path.join(root, 'run');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'marker'), 'mine');
    const signals = new TestSignals();
    const launch: Omit<LaunchOptions, 'callToAction'> = { claudePath: fakeClaude, noProcessEnv: true, auth: 'caller', cwd: root };
    const custody = { graceMs: 1_000, source: signals, env: { PATH: bunDir } };

    await expect(runInCustody({ ...launch, callToAction: '# x' }, { ...custody, directory }))
      .rejects.toThrow('already exists');
    expect(await fs.readdir(directory)).toEqual([ 'marker' ]);
    expect(signals.listening).toBe(0);

    const orphan = path.join(root, 'missing', 'run');
    await expect(runInCustody({ ...launch, callToAction: '# x' }, { ...custody, directory: orphan }))
      .rejects.toThrow('its parent does not exist');
    expect(await exists(path.join(root, 'missing'))).toBe(false);
    expect(signals.listening).toBe(0);

    // Refusals that need nothing on disk leave nothing.
    const other = path.join(root, 'other');
    await expect(runInCustody({ ...launch, callToAction: '-x' }, { ...custody, directory: other }))
      .rejects.toThrow('starts with "-"');
    await expect(runInCustody({ ...launch, callToAction: '# x' }, { ...custody, directory: other, graceMs: Number.NaN }))
      .rejects.toThrow('graceMs must be a finite number');
    expect(await exists(other)).toBe(false);
    expect(signals.listening).toBe(0);
  });

  test('a spawn that fails is a completion saying the run never started', async () => {
    const run = await begin({ claudePath: '/nonexistent-bare-claude-test/claude' });
    const completion = await run.completion;

    expect(completion).toMatchObject({ outcome: 'not-started', exitCode: null, stop: null, stdout: null, journal: null });
    expect(typeof completion.notStarted === 'string' && completion.notStarted !== '').toBe(true);
    expect(await exists(path.join(run.directory, custodyFiles.invocation))).toBe(true);
    expect(await exists(path.join(run.directory, custodyFiles.start))).toBe(false);
    expect(await readJson(path.join(run.directory, custodyFiles.completion))).toEqual(completion);
    expect(run.events.map(event => event.kind)).toEqual([ 'completed', 'observed' ]);
    expect(run.signals.listening).toBe(0);
    // The descriptors were opened before the spawn failed: an empty stdout, read as such.
    expect(await readJson(path.join(run.directory, custodyFiles.observation))).toMatchObject({
      state: 'not-started',
      start: { status: 'absent' },
      journal: null,
      stdout: { file: { bytes: 0 }, atCompletion: null, changedSinceCompletion: null, result: { status: 'not-read' } },
    });
    // Not "nothing but whitespace was written": nothing was spawned to write.
    expect(await readJson(path.join(run.directory, custodyFiles.observation))).toMatchObject({
      stdout: { result: { why: 'the run never started: no process was spawned to write this stdout' } },
    });
  });

  test('custody\'s records hold no environment, settings, token or call to action; extraArgs as given; the home holds what a home holds', async () => {
    const token = 'sk-ant-oat01-custody-token-file-sentinel';
    const envValue = 'custody-extra-env-sentinel';
    const settingValue = 'custody-settings-env-sentinel';
    const argValue = 'custody-extra-arg-sentinel';
    const callToAction = '# the commission text itself';
    const tokenFile = path.join(await tempDir(), 'oauth');
    await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });

    // auth 'fallback' with no credential in the child's environment:
    // spawnClaude reads the token file into the child, as it always has.
    const run = await begin({
      callToAction,
      auth: 'fallback',
      linkAuth: false,
      extraEnv: { CUSTODY_TEST_VALUE: envValue },
      extraSettings: { env: { CUSTODY_TEST_SETTING: settingValue } },
      extraArgs: [ '--custody-test-flag', argValue ],
    }, { BARE_CLAUDE_TOKEN_FILE: tokenFile, FAKE_CLAUDE_STDOUT: 'ok\n' });
    const completion = await run.completion;
    expect(completion.outcome).toBe('exited');

    for (const name of [
      custodyFiles.invocation, custodyFiles.start, custodyFiles.completion, custodyFiles.observation,
      custodyFiles.stdout, custodyFiles.stderr,
    ]) {
      const text = await Bun.file(path.join(run.directory, name)).text();
      for (const secret of [ token, envValue, settingValue, callToAction ]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(await exists(path.join(run.directory, custodyFiles.callToAction))).toBe(false);

    // Recorded as given, a secret in them included: the README says so.
    expect(await Bun.file(path.join(run.directory, custodyFiles.invocation)).text()).toContain(argValue);
    // The home is a Claude home: settings.json holds extraSettings, env block
    // included, and the journal holds the call to action.
    expect(await Bun.file(path.join(run.directory, custodyFiles.home, 'settings.json')).text()).toContain(settingValue);
    expect(await Bun.file(completion.journal?.path ?? '').text()).toContain(callToAction);
  }, 20_000);

  test('the call to action is kept, exactly, only when the caller asks', async () => {
    const callToAction = '# keep these words\nverbatim, ünïcode included';
    const run = await begin({ callToAction }, {}, { keepCallToAction: true });
    await run.completion;
    const kept = path.join(run.directory, custodyFiles.callToAction);

    expect(await Bun.file(kept).text()).toBe(callToAction);
    expect(await readJson(path.join(run.directory, custodyFiles.invocation))).toMatchObject({
      callToAction: { bytes: Buffer.byteLength(callToAction), sha256: sha256(callToAction), kept },
    });
  }, 20_000);

  test('an in-memory seed is recorded by its session id, never its contents', async () => {
    const value = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'private prior turn' } })}\n`;
    const run = await begin({ customSessionData: { sessionId: 'prior-session', value } });
    await run.completion;
    const text = await Bun.file(path.join(run.directory, custodyFiles.invocation)).text();

    expect(JSON.parse(text)).toMatchObject({ session: { kind: 'memory', sessionId: 'prior-session' } });
    expect(text).not.toContain('private prior turn');
  }, 20_000);

  test(`a caller that chooses to continue builds the seed from the completion's journal [${cloneBranch} branch]`, async () => {
    if (cloneRequired) {
      expect(cloneBranch).toBe('clone');
    }
    const { journal } = await (await begin()).completion;
    expect(journal?.exists).toBe(true);
    if (journal === null || journal.sha256 === null) {
      return;
    }
    const seed = { sessionId: journal.sessionId, sourcePath: journal.path, sourceSha256: journal.sha256 };

    const next = await begin({ customSessionData: seed });
    const completion = await next.completion;

    expect(await readJson(path.join(next.directory, custodyFiles.invocation))).toMatchObject({
      session: { kind: 'file', sessionId: seed.sessionId, sourcePath: seed.sourcePath, sourceSha256: seed.sourceSha256 },
    });
    if (cloneBranch === 'clone') {
      expect(completion.outcome).toBe('exited');
      expect(completion.journal?.exists).toBe(true);
      expect(completion.journal?.path).not.toBe(seed.sourcePath);
      expect(await digestOf(seed.sourcePath)).toBe(seed.sourceSha256);
    } else {
      expect(completion.outcome).toBe('not-started');
    }
  }, 30_000);

  test('a reporter that throws changes neither the run nor its records', async () => {
    const run = await begin({}, {}, {
      onEvent: () => {
        throw new Error('reporter failed');
      },
    });
    const completion = await run.completion;

    expect(completion.outcome).toBe('exited');
    expect(await readJson(path.join(run.directory, custodyFiles.completion))).toEqual(completion);
    expect(await readJson(path.join(run.directory, custodyFiles.observation))).toMatchObject({ state: 'exited' });
  }, 20_000);

  test('a launcher that leaves a process behind: custody does not wait for it, and says its group is occupied', async () => {
    const root = await tempDir();
    const launcher = path.join(root, 'launcher');
    // The sleep inherits the custody stdout file and keeps it open.
    await fs.writeFile(launcher, [ '#!/bin/sh', '"$FAKE_CLAUDE" "$@"', 'sleep 30 &', 'exit 0', '' ].join('\n'), { mode: 0o755 });
    await fs.chmod(launcher, 0o755);
    const startedAt = Date.now();

    const run = await begin({ claudePath: launcher }, { FAKE_CLAUDE: fakeClaude, PATH: `${bunDir}:/usr/bin:/bin` });
    const completion = await run.completion;

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(completion).toMatchObject({
      outcome: 'exited', exitCode: 0, stop: null, processGroupAfter: { state: 'occupied' },
    });
    expect(completion.journal?.exists).toBe(true);
    expect(await readJson(path.join(run.directory, custodyFiles.invocation))).toMatchObject({ executable: launcher });
  }, 20_000);

  test('an empty group is not an end of writers: a process in a session of its own goes on writing the journal', async () => {
    const root = await tempDir();
    const launcher = path.join(root, 'launcher');
    const pidFile = path.join(root, 'escaped.pid');
    // Starts the fake in a session of its own, outside the group custody
    // reads, as a launcher's native child may be, and exits once it has had
    // time to start writing its journal.
    await fs.writeFile(launcher, [
      '#!/usr/bin/env bun',
      'Bun.spawn({ cmd: [ process.env.FAKE_CLAUDE ?? "", ...process.argv.slice(2) ], detached: true,',
      '  stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();',
      'await Bun.sleep(1_000);',
      '',
    ].join('\n'), { mode: 0o755 });
    await fs.chmod(launcher, 0o755);

    const run = await begin({ claudePath: launcher }, {
      FAKE_CLAUDE: fakeClaude, FAKE_CLAUDE_PID_FILE: pidFile,
      FAKE_CLAUDE_SLEEP_MS: '15000', FAKE_CLAUDE_APPEND_EVERY_MS: '100',
    });
    const completion = await run.completion;
    expect(await eventually(async () => (await textOf(pidFile) ?? '') !== '', 5_000)).toBe(true);
    const escaped = Number(await Bun.file(pidFile).text());
    // It leads a group of its own, by setsid(); afterEach ends it if this test does not.
    groups.push(escaped);

    expect(completion).toMatchObject({ outcome: 'exited', exitCode: 0, processGroupAfter: { state: 'empty' } });
    expect(processGone(escaped)).toBe(false);
    const { journal } = completion;
    expect(journal?.exists).toBe(true);
    if (journal === null || journal.sha256 === null) {
      return;
    }
    const recorded = journal.sha256;
    expect(await eventually(async () => await digestOf(journal.path) !== recorded, 5_000)).toBe(true);
    process.kill(-escaped, 'SIGKILL');
    expect(await eventually(() => processGone(escaped), 5_000)).toBe(true);

    // The digest is the boundary: a seed built from this completion is refused.
    const next = await begin({
      customSessionData: { sessionId: journal.sessionId, sourcePath: journal.path, sourceSha256: recorded },
    });
    const refused = await next.completion;
    expect(refused.outcome).toBe('not-started');
    expect(refused.notStarted).toContain('does not match the expected SHA-256');
  }, 40_000);

  test('an identity is the caller\'s own reading, three fields only; one that fails says so', async () => {
    const pids: number[] = [];
    const run = await begin({}, {}, {
      identify: pid => {
        pids.push(pid);
        const reading = { method: 'test reader', start: `began-${pid}`, boot: null, extra: 'not recorded' };
        return reading;
      },
    });
    await run.completion;
    const [ start ] = startsIn(run.events);
    expect(pids).toEqual([ start?.pid ?? -1 ]);
    expect(start?.identity).toEqual({ observed: { method: 'test reader', start: `began-${start?.pid ?? -1}`, boot: null } });
    expect(await readJson(path.join(run.directory, custodyFiles.start))).toEqual(start);

    const failed = await begin({}, {}, {
      identify: () => {
        throw new Error('no reading');
      },
    });
    expect((await failed.completion).outcome).toBe('exited');
    expect(await readJson(path.join(failed.directory, custodyFiles.start))).toMatchObject({ identity: { failed: 'no reading' } });
  }, 20_000);
  test('Bun leaves a numeric stdout descriptor open, naming its file, for custody to close', async () => {
    const file = path.join(await tempDir(), 'out');
    const descriptor = openSync(file, 'wx', 0o600);
    try {
      const child = Bun.spawn({
        cmd: [ process.execPath, '-e', 'process.stdout.write("x")' ], stdin: 'ignore', stdout: descriptor, stderr: 'ignore',
      });
      const named = statSync(file);
      const atSpawn = fstatSync(descriptor);
      expect(await child.exited).toBe(0);
      const atExit = fstatSync(descriptor);
      expect([ atSpawn.ino, atExit.ino ]).toEqual([ named.ino, named.ino ]);
      expect([ atSpawn.dev, atExit.dev ]).toEqual([ named.dev, named.dev ]);
    } finally {
      closeSync(descriptor);
    }
    expect(await Bun.file(file).text()).toBe('x');
  });

  test('a start custody cannot record is stopped as custody-error, not passed off as an exit', async () => {
    const root = await tempDir();
    const directory = path.join(root, 'run');
    const completion = await runInCustody({
      callToAction: '# x', claudePath: fakeClaude, noProcessEnv: true, auth: 'caller', cwd: root,
    }, {
      directory, graceMs: 5_000, source: new TestSignals(), env: { PATH: bunDir, FAKE_CLAUDE_SLEEP_MS: '30000' },
      // Called before start.json is created, so custody's exclusive create fails.
      identify: pid => {
        groups.push(pid);
        writeFileSync(path.join(directory, custodyFiles.start), '');
        return { method: 'test', start: '', boot: null };
      },
    });

    expect(completion).toMatchObject({ outcome: 'stopped', stoppedBy: null, stop: { cause: 'custody-error' } });
    expect(completion.stop?.report).toMatchObject({ signal: 'SIGTERM' });
    expect(completion.custodyError).toContain(`${custodyFiles.start} was not written`);
    expect(await readJson(path.join(directory, custodyFiles.completion))).toEqual(completion);

    // The empty start.json is someone else's, and unreadable as a start; the
    // state rests on the completion, which says custody failed.
    const reading = await readCustody(directory);
    expect(reading).toMatchObject({ state: 'custody-error', start: { status: 'unreadable', file: { bytes: 0 } } });
    expect(reading.basis).toContain(`${custodyFiles.start} was not written`);
    expect(reading.problems.some(problem => problem.startsWith(path.join(directory, custodyFiles.start)))).toBe(true);
    expect(await readJson(path.join(directory, custodyFiles.observation))).toMatchObject({ state: 'custody-error' });
  }, 30_000);

});

describe.if(posix)('readCustody and the observation', () => {
  test('the observation is the directory as readCustody read it at the end, and a later reading agrees', async () => {
    const run = await begin({ extraArgs: [ '--output-format', 'json' ] }, { FAKE_CLAUDE_STDOUT: constructedResult });
    const completion = await run.completion;
    const at = (name: string) => path.join(run.directory, name);
    const observed = observedIn(run.events);
    const observation = observed?.observation ?? null;

    expect(observed).toMatchObject({ directory: run.directory, file: at(custodyFiles.observation), error: null });
    expect(await readJson(at(custodyFiles.observation))).toEqual(observation);
    expect(Object.keys(observation ?? {}).sort()).toEqual([ ...readingKeys ].sort());
    expect(observation).toMatchObject({
      format: 'bare-claude/custody-reading',
      version: custodyReadingVersion,
      scope: custodyReadingScope,
      directory: run.directory,
      state: 'exited',
      writtenIn: { directory: run.directory, from: 'invocation.directory', sameAsRead: true },
      invocation: { status: 'read', record: { executable: fakeClaude, directory: run.directory, configuration: null } },
      start: { status: 'read', record: { seededJournal: null } },
      completion: { status: 'read', record: completion },
      stdout: {
        writtenBy: { launcher: 'claude', executable: fakeClaude },
        provenance: stdoutProvenance,
        outputFormat: 'json',
        atCompletion: { bytes: Buffer.byteLength(constructedResult), sha256: sha256(constructedResult) },
        changedSinceCompletion: false,
        // Verbatim facts of the result, each in its own scope.
        result: {
          status: 'read',
          basis: 'json-requested',
          reading: {
            file: 'result', status: 'error', stopReason: 'constructed_stop',
            contextLimit: { terminalReason: true, text: true }, process: { scope: processScope },
          },
        },
      },
      journal: {
        namedBy: 'completion.journal', path: completion.journal?.path ?? '', changedSinceCompletion: false, reading: { lines: 2 },
        // Nothing was seeded: the whole journal is this run's.
        appended: { status: 'read', boundary: { bytes: 0, sha256: null, basis: 'nothing seeded' }, lineOffset: 0, reading: { lines: 2 } },
      },
      // The constructed result names a session the journal never does.
      join: { kind: 'no-match' },
    });
    // Not this run's session: said, without changing the state, which rests on custody's records.
    const [ start ] = startsIn(run.events);
    expect(observation?.problems).toEqual([
      `the stdout result names session constructed-session, ${custodyFiles.start} session ${start?.sessionId ?? ''}: it may be another session's result`,
    ]);
    expect(Object.keys(observation?.stdout ?? {}).sort()).toEqual([ ...stdoutKeys ].sort());
    expect(observation?.entries).not.toContain(custodyFiles.observation);

    const later = await readCustody(run.directory);
    expect(later.entries).toContain(custodyFiles.observation);
    expect(later).toMatchObject({
      state: 'exited',
      stdout: { file: { sha256: sha256(constructedResult) }, changedSinceCompletion: false },
      journal: { changedSinceCompletion: false },
    });
  }, 20_000);

  test('a launcher\'s stdout is the launcher\'s: a result that looks native says nothing of who wrote it', async () => {
    const launcher = path.join(await tempDir(), 'claude');
    // Named `claude`, writing a native-looking result, and not Claude Code.
    await fs.writeFile(launcher, [ '#!/bin/sh', 'printf \'%s\' "$NATIVE_LOOKING"', 'exit 0', '' ].join('\n'), { mode: 0o755 });
    await fs.chmod(launcher, 0o755);
    const run = await begin({ claudePath: launcher, extraArgs: [ '--output-format', 'json' ] }, {
      NATIVE_LOOKING: constructedResult, PATH: `${bunDir}:/usr/bin:/bin`,
    });
    await run.completion;
    const observation = observedIn(run.events)?.observation ?? null;

    expect(observation).toMatchObject({
      state: 'exited',
      stdout: {
        writtenBy: { launcher: 'claude', executable: launcher }, provenance: stdoutProvenance,
        result: { status: 'read', basis: 'json-requested', reading: { file: 'result' } },
      },
    });
    expect(Object.keys(observation?.stdout ?? {}).sort()).toEqual([ ...stdoutKeys ].sort());
    expect(keysIn(observation).filter(key => /native/i.test(key))).toEqual([]);

    // A launcher that asks for JSON itself: no flag in the invocation, a result on stdout.
    const unasked = await begin({ claudePath: launcher }, { NATIVE_LOOKING: constructedResult, PATH: `${bunDir}:/usr/bin:/bin` });
    await unasked.completion;
    expect(observedIn(unasked.events)?.observation).toMatchObject({
      stdout: { outputFormat: null, result: { status: 'read', basis: 'parsed-as-result', reading: { file: 'result' } } },
    });
  }, 20_000);

  test('text, the default format, is not read as a result, broken or otherwise', async () => {
    for (const written of [ 'raw reply\n', '42\n' ]) {
      const run = await begin({}, { FAKE_CLAUDE_STDOUT: written });
      await run.completion;
      const observation = observedIn(run.events)?.observation ?? null;
      expect(observation).toMatchObject({
        state: 'exited',
        stdout: {
          outputFormat: null,
          file: { bytes: Buffer.byteLength(written) },
          result: {
            status: 'not-read',
            why: 'the invocation asked for no --output-format, and claude --print writes text by default; the bytes are not a result',
          },
        },
        join: null,
      });
    }
  }, 20_000);

  test('output and journal changed since the completion are facts, and nothing in them offers a continuation', async () => {
    const run = await begin({}, { FAKE_CLAUDE_STDOUT: 'first\n' });
    await run.completion;
    const observation = observedIn(run.events)?.observation ?? null;
    expect(observation?.stdout.changedSinceCompletion).toBe(false);
    expect(observation?.journal?.changedSinceCompletion).toBe(false);
    const journal = observation?.journal?.path ?? '';

    // Whoever writes after the completion, the reading sees bytes, not writers.
    await fs.appendFile(path.join(run.directory, custodyFiles.stdout), 'later\n');
    await fs.appendFile(journal, `${JSON.stringify({ type: 'progress' })}\n`);
    const changed = await readCustody(run.directory);
    expect(changed).toMatchObject({
      state: 'exited',
      stdout: { changedSinceCompletion: true, file: { bytes: Buffer.byteLength('first\nlater\n') } },
      journal: { changedSinceCompletion: true, reading: { lines: 3 } },
    });
    expect(keysIn(changed).filter(key => /continu|resum/i.test(key))).toEqual([]);

    await fs.rm(journal);
    expect((await readCustody(run.directory)).journal).toMatchObject({
      changedSinceCompletion: true, file: null, why: 'no file at that path', reading: null,
    });
  }, 20_000);

  test('an observation that cannot be written is the event\'s error, and changes nothing of the run', async () => {
    const seen: CustodyEvent[] = [];
    const run = await begin({}, {}, {
      onEvent: event => {
        seen.push(event);
        // Someone else's file where the observation would go.
        if (event.kind === 'completed') {
          writeFileSync(path.join(event.directory, custodyFiles.observation), 'theirs');
        }
      },
    });
    const completion = await run.completion;
    const observed = observedIn(seen);

    expect(completion).toMatchObject({ outcome: 'exited', exitCode: 0, custodyError: null });
    expect(await readJson(path.join(run.directory, custodyFiles.completion))).toEqual(completion);
    expect(observed?.file).toBeNull();
    expect(observed?.error).toContain(`${custodyFiles.observation} was not written`);
    expect(observed?.observation?.state).toBe('exited');
    expect(await Bun.file(path.join(run.directory, custodyFiles.observation)).text()).toBe('theirs');
  }, 20_000);

  test('the stated configuration is recorded field by field, with its scope; none stated is null', async () => {
    const stated: CustodyConfiguration = {
      source: 'files',
      files: [ { path: '/profiles/worker.yaml', realPath: '/profiles/worker.yaml', bytes: 10, sha256: 'a'.repeat(64) } ],
      use: [ 'worker' ],
      useFrom: 'configuration',
    };
    // An untyped caller's extra fields stay out of the record.
    const withExtra = { ...stated, contents: 'stated-configuration-sentinel' };
    const run = await begin({}, {}, { configuration: withExtra });
    await run.completion;
    const text = await Bun.file(path.join(run.directory, custodyFiles.invocation)).text();

    expect(JSON.parse(text)).toMatchObject({ configuration: { ...stated, scope: configurationScope } });
    expect(text).not.toContain('stated-configuration-sentinel');
  }, 20_000);

  /** A finished run's directory, and variants of it made by copying some of its files and writing others. */
  async function variants() {
    const run = await begin({}, { FAKE_CLAUDE_STDOUT: 'out\n' });
    await run.completion;
    const text = async (name: string) => Bun.file(path.join(run.directory, name)).text();
    const variant = async (copy: string[], write: Record<string, string> = {}): Promise<string> => {
      const directory = path.join(await tempDir(), 'variant');
      await fs.mkdir(directory);
      for (const name of copy) {
        await fs.copyFile(path.join(run.directory, name), path.join(directory, name));
      }
      for (const [ name, written ] of Object.entries(write)) {
        await fs.writeFile(path.join(directory, name), written);
      }
      return directory;
    };
    return { run, text, variant };
  }

  test('a directory whose end was not recorded is unknown by what it holds, never read as an end', async () => {
    const { variant } = await variants();

    const invocationOnly = await readCustody(await variant([ custodyFiles.invocation ]));
    expect(invocationOnly).toMatchObject({
      state: 'invocation-only', journal: null, join: null,
      stdout: {
        file: null, why: 'no file at that path', changedSinceCompletion: null,
        result: { status: 'not-read', why: 'no file at that path' },
      },
    });
    expect(invocationOnly.basis).toContain('spawned just before its runner died');

    const startOnly = await readCustody(await variant([ custodyFiles.invocation, custodyFiles.start, custodyFiles.stdout ]));
    expect(startOnly).toMatchObject({
      state: 'start-only',
      completion: { status: 'absent' },
      // A copy: the journal its start names is the original directory's, and is not read as this one's.
      writtenIn: { sameAsRead: false, from: 'invocation.directory' },
      journal: { namedBy: 'start.sessionJsonlPath', atCompletion: null, changedSinceCompletion: null, reading: null, appended: { status: 'not-read' } },
      stdout: { atCompletion: null, changedSinceCompletion: null },
    });
    expect(startOnly.basis).toContain('custody did not record an end');
  }, 20_000);

  test('a moved directory does not read the original\'s journal as its own; an alias of the same one does', async () => {
    const { run } = await variants();
    const alias = path.join(await tempDir(), 'alias');
    await fs.symlink(run.directory, alias);
    expect(await readCustody(alias)).toMatchObject({
      state: 'exited', problems: [], writtenIn: { directory: run.directory, sameAsRead: true }, journal: { reading: { lines: 2 } },
    });

    const moved = path.join(await tempDir(), 'moved');
    await fs.rename(run.directory, moved);
    const reading = await readCustody(moved);
    expect(reading).toMatchObject({
      state: 'exited',
      writtenIn: { directory: run.directory, from: 'invocation.directory', sameAsRead: false },
      stdout: { changedSinceCompletion: false },
      journal: { file: null, reading: null, changedSinceCompletion: null, appended: { status: 'not-read' } },
    });
    expect(reading.journal?.why).toContain('where these records were written');
    // Said once, not once per output.
    expect(reading.problems).toHaveLength(1);
    expect(reading.problems[0]).toContain(`these records were written in ${run.directory}`);
  }, 20_000);

  test('a continued session\'s inherited records are read apart from what this run appended', async () => {
    const run = await begin({ customSessionData: { sessionId: priorSession, value: priorJournal } });
    await run.completion;
    const observation = observedIn(run.events)?.observation ?? null;
    const seeded = { bytes: Buffer.byteLength(priorJournal), sha256: sha256(priorJournal) };

    expect(observation).toMatchObject({
      state: 'exited',
      problems: [],
      start: { record: { sessionId: priorSession, seededJournal: seeded } },
      journal: { appended: { status: 'read', boundary: { ...seeded, basis: 'seeded' }, lineOffset: 2, reading: { lines: 2 } } },
    });
    // The earlier process's context limit is in the journal, and not in what this run appended.
    expect(holdsContextLimit(observation?.journal?.reading)).toBe(true);
    const appended = observation?.journal?.appended;
    expect(appended?.status).toBe('read');
    expect(holdsContextLimit(appended?.status === 'read' ? appended.reading : null)).toBe(false);

    // A journal no longer beginning with what was seeded has no known boundary.
    const journal = observation?.journal?.path ?? '';
    const bytes = await Bun.file(journal).text();
    await fs.writeFile(journal, `x${bytes.slice(1)}`);
    expect((await readCustody(run.directory)).journal?.appended).toMatchObject({
      status: 'not-read', why: `its first ${seeded.bytes} bytes are no longer the bytes seeded, so where this run's records begin is not known`,
    });
  }, 20_000);

  test('a start from before the seed was recorded: a fresh session has a boundary at 0, a continued one has none', async () => {
    const fresh = await begin();
    await fresh.completion;
    const continued = await begin({ customSessionData: { sessionId: priorSession, value: priorJournal } });
    await continued.completion;
    // Rewritten in place, as 0.12.0 wrote them; custody itself never rewrites a record.
    for (const run of [ fresh, continued ]) {
      const start = path.join(run.directory, custodyFiles.start);
      await fs.writeFile(start, edited(await Bun.file(start).text(), record => { delete record.seededJournal; }));
    }

    expect((await readCustody(fresh.directory)).journal?.appended).toMatchObject({
      status: 'read', boundary: { bytes: 0, sha256: null, basis: 'fresh session' },
    });
    const inherited = (await readCustody(continued.directory)).journal?.appended;
    expect(inherited).toMatchObject({ status: 'not-read' });
    expect(inherited?.status === 'not-read' ? inherited.why : '').toContain('inherited records cannot be told from this run\'s');
  }, 20_000);

  test('a completion naming another journal, or a start and completion with no invocation, are unknown', async () => {
    const { text, variant } = await variants();
    const completion = await text(custodyFiles.completion);

    const elsewhere = await readCustody(await variant([ custodyFiles.invocation, custodyFiles.start ], {
      [custodyFiles.completion]: edited(completion, record => {
        const journal = record.journal;
        if (isRecordValue(journal)) {
          journal.path = '/elsewhere/another-run.jsonl';
        }
      }),
    }));
    expect(elsewhere.state).toBe('unknown');
    expect(elsewhere.basis).toContain(`${custodyFiles.completion} /elsewhere/another-run.jsonl`);

    const noInvocation = await readCustody(await variant([ custodyFiles.start, custodyFiles.completion ]));
    expect(noInvocation.state).toBe('unknown');
    expect(noInvocation.basis).toContain(`there is no ${custodyFiles.invocation}`);
  }, 20_000);

  test('a signal name another platform reports is read; one no platform names is not', async () => {
    const { run } = await variants();
    const completion = path.join(run.directory, custodyFiles.completion);
    const original = await Bun.file(completion).text();

    await fs.writeFile(completion, edited(original, record => { record.exitCode = null; record.signalCode = 'SIGPWR'; }));
    expect(await readCustody(run.directory)).toMatchObject({ state: 'exited', completion: { status: 'read' } });

    await fs.writeFile(completion, edited(original, record => { record.exitCode = null; record.signalCode = 'SIGNOTONE'; }));
    expect(await readCustody(run.directory)).toMatchObject({ state: 'unreadable', completion: { status: 'unreadable' } });
  }, 20_000);

  test('a record that is cut short, of another version or format, or not as its version writes it, is unreadable', async () => {
    const { text, variant } = await variants();
    const kept = [ custodyFiles.invocation, custodyFiles.start ];
    const completion = await text(custodyFiles.completion);
    const cases: [ string, string ][] = [
      [ completion.slice(0, 40), 'possibly cut short' ],
      [ edited(completion, record => { record.version = 2; }), 'version 2; this reader knows version 1' ],
      [ edited(completion, record => { record.exitCode = '0'; }), 'fields are not as that version writes them' ],
      [ await text(custodyFiles.invocation), 'not a bare-claude/run-completion record' ],
    ];
    for (const [ written, why ] of cases) {
      const directory = await variant(kept, { [custodyFiles.completion]: written });
      const reading = await readCustody(directory);
      expect(reading).toMatchObject({ state: 'unreadable', completion: { status: 'unreadable', file: { bytes: Buffer.byteLength(written) } } });
      expect(reading.completion.status === 'unreadable' ? reading.completion.why : '').toContain(why);
      expect(reading.problems.some(problem => problem.startsWith(path.join(directory, custodyFiles.completion)))).toBe(true);
    }
  }, 20_000);

  test('records custody never writes together, or that disagree, are unknown; a 0.12 invocation is read as it was', async () => {
    const { text, variant } = await variants();
    const start = await text(custodyFiles.start);
    const completion = await text(custodyFiles.completion);

    const disagreeing = await readCustody(await variant([ custodyFiles.invocation, custodyFiles.completion ], {
      [custodyFiles.start]: edited(start, record => { record.sessionId = 'another-session'; }),
    }));
    expect(disagreeing.state).toBe('unknown');
    expect(disagreeing.basis).toContain('the records disagree');

    const noStart = await readCustody(await variant([ custodyFiles.invocation, custodyFiles.completion ]));
    expect(noStart.state).toBe('unknown');
    expect(noStart.basis).toContain(`there is no ${custodyFiles.start}`);

    // Without the fields 0.13 added; the directory it was written in is then told by the completion's outputs.
    const before = await readCustody(await variant([ custodyFiles.stdout, custodyFiles.stderr ], {
      [custodyFiles.invocation]: edited(await text(custodyFiles.invocation), record => {
        delete record.configuration;
        delete record.directory;
      }),
      [custodyFiles.start]: edited(start, record => { delete record.seededJournal; }),
      [custodyFiles.completion]: completion,
    }));
    expect(before).toMatchObject({
      state: 'exited',
      invocation: { status: 'read' },
      start: { status: 'read' },
      writtenIn: { from: 'completion outputs', sameAsRead: false },
    });
    expect(before.invocation.status === 'read' ? before.invocation.record.configuration : null).toBeUndefined();
  }, 20_000);

  test('an empty directory, someone else\'s files, and no directory at all', async () => {
    const root = await tempDir();
    const empty = path.join(root, 'empty');
    await fs.mkdir(empty);
    expect(await readCustody(empty)).toMatchObject({ state: 'unknown', entries: [], journal: null });

    await fs.writeFile(path.join(empty, 'notes.txt'), 'theirs');
    expect(await readCustody(empty)).toMatchObject({ state: 'unknown', entries: [ 'notes.txt' ] });

    const missing: CustodyReading = await readCustody(path.join(root, 'missing'));
    expect(missing).toMatchObject({ state: 'unreadable', entries: null, invocation: { status: 'absent' } });
    expect(missing.basis).toContain('could not be listed');
  });
});
