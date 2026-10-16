import { afterEach, describe, expect, test } from 'bun:test';

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cloneBranch, cloneRequired, eventually, processGone } from '../test/helpers.ts';
import {
  completionScope, custodyFiles, custodyVersion, runInCustody,
  type CustodyEvent, type CustodyOptions, type CustodyStart,
} from './custody.ts';
import type { LaunchOptions } from './index.ts';
import { processGroupState, type SignalSource, type StopSignal } from './lifecycle.ts';

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
      custodyFiles.completion, custodyFiles.home, custodyFiles.invocation,
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
    expect(run.events.map(event => event.kind)).toEqual([ 'started', 'completed' ]);
    expect(run.events.at(-1)).toEqual({ kind: 'completed', directory: run.directory, completion });
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
    expect(run.events.at(-1)?.kind).toBe('completed');
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
    expect(run.events.map(event => event.kind)).toEqual([ 'completed' ]);
    expect(run.signals.listening).toBe(0);
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
      custodyFiles.invocation, custodyFiles.start, custodyFiles.completion, custodyFiles.stdout, custodyFiles.stderr,
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
  }, 30_000);

});
