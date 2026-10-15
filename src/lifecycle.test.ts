import { afterEach, describe, expect, test } from 'bun:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { eventually, processGone } from '../test/helpers.ts';
import {
  processGroupState, signalExitStatus, stopClaude, superviseSignals,
  type SignalSource, type StopOptions, type StopSignal, type SupervisorEvent,
} from './lifecycle.ts';

/**
 * The refusals here are what keeps a stop inside the run's own boundary:
 * group ids with a broadcast meaning to kill(2), this process's own, and any
 * id that is not the spawned process's.
 *
 * The supervisor tests deliver signals through a {@link SignalSource} of their
 * own, never to the test process, and stop real processes: `sh` spawned
 * detached, so it leads a group, often with a `sleep` of its own in that
 * group — the shape of a launcher and the native process it supervises. The
 * CLI, which uses the same supervisor, is tested end to end in
 * `test/termination.cli.test.ts`.
 */

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

  /** How many listeners are installed, over every signal. */
  get listening(): number {
    return [ ...this.listeners.values() ].reduce((total, set) => total + set.size, 0);
  }
}

const roots: string[] = [];
const spawned: number[] = [];

afterEach(async () => {
  // Only processes these tests started, and only while still alive.
  for (const pid of spawned.splice(0)) {
    if (!processGone(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* Gone in between. */ }
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-lifecycle-'));
  roots.push(dir);
  return dir;
}

/** `sh -c script`, spawned detached as `spawnClaude` spawns for the CLI: a run leading its own group. */
function detachedRun(script: string) {
  const subprocess = Bun.spawn({ cmd: [ 'sh', '-c', script ], stdout: 'ignore', stderr: 'ignore', detached: true });
  spawned.push(subprocess.pid);
  return { subprocess, processGroup: subprocess.pid };
}

/** The PID a script wrote to `file`, once it has. */
async function pidIn(file: string): Promise<number> {
  expect(await eventually(async () => (await Bun.file(file).exists()) && (await Bun.file(file).text()).trim() !== '', 10_000))
    .toBe(true);
  const pid = Number((await Bun.file(file).text()).trim());
  spawned.push(pid);
  return pid;
}

describe.if(process.platform === 'darwin' || process.platform === 'linux')('stopClaude', () => {
  test('never probes a process group that no spawned run can lead', () => {
    for (const pgid of [ 0, 1, -5, 1.5, Number.NaN, process.pid ]) {
      expect(() => processGroupState(pgid)).toThrow('refusing to signal process group');
    }
  });

  test('refuses a process group that is not the spawned process\'s own', async () => {
    const subprocess = Bun.spawn({ cmd: [ 'true' ], stdout: 'ignore', stderr: 'ignore' });
    await subprocess.exited;
    await expect(stopClaude({ subprocess, processGroup: subprocess.pid + 1 }, { signal: 'SIGTERM', graceMs: 0 }))
      .rejects.toThrow('refusing to signal process group');
  });

  test('without a group, signals the spawned process alone, and reports how it ended', async () => {
    const subprocess = Bun.spawn({ cmd: [ 'sleep', '30' ], stdout: 'ignore', stderr: 'ignore' });
    spawned.push(subprocess.pid);
    const report = await stopClaude({ subprocess, processGroup: null }, { signal: 'SIGTERM', graceMs: 5_000 });

    expect(report.signal).toBe('SIGTERM');
    expect(report.escalated).toBe(false);
    expect(report.signalCode).toBe('SIGTERM');
    expect(report.processGroup).toBeNull();
    expect(report.groupState).toBeNull();
  });

  test('a process that already ended is reported, not signalled', async () => {
    const run = detachedRun('exit 4');
    await run.subprocess.exited;
    const report = await stopClaude(run, { signal: 'SIGTERM', graceMs: 1_000 });

    expect(report.escalated).toBe(false);
    expect(report.exitCode).toBe(4);
    expect(report.groupState).toBe('empty');
  });
});

describe.if(process.platform === 'darwin' || process.platform === 'linux')('superviseSignals', () => {
  test('a signal before attach is held, then stops the run and what it started once attached', async () => {
    const signals = new TestSignals();
    const events: SupervisorEvent[] = [];
    const supervisor = superviseSignals({ graceMs: 5_000, source: signals, onEvent: event => events.push(event) });

    signals.send('SIGTERM');
    expect(events).toEqual([ { kind: 'held', signal: 'SIGTERM' } ]);
    expect(supervisor.stoppedBy).toBeNull();

    // The spawn the signal arrived during: a launcher with a child of its own.
    const childFile = path.join(await tempDir(), 'child.pid');
    const run = detachedRun(`sleep 30 & echo $! > '${childFile}'; wait`);
    const child = await pidIn(childFile);
    supervisor.attach(run);

    const report = await supervisor.finish();
    expect(report?.signal).toBe('SIGTERM');
    expect(report?.groupState).toBe('empty');
    expect(supervisor.stoppedBy).toBe('SIGTERM');
    expect(signalExitStatus('SIGTERM')).toBe(143);
    expect(events[1]).toEqual({ kind: 'stopping', cause: 'SIGTERM', pid: run.subprocess.pid, processGroup: run.processGroup, graceMs: 5_000 });
    expect(await eventually(() => processGone(run.subprocess.pid) && processGone(child), 5_000)).toBe(true);
    expect(signals.listening).toBe(0);
  }, 20_000);

  test('a second signal during a stop sends SIGKILL at once, and the first still names the stop', async () => {
    const signals = new TestSignals();
    const events: SupervisorEvent[] = [];
    const supervisor = superviseSignals({ graceMs: 60_000, source: signals, onEvent: event => events.push(event) });
    const readyFile = path.join(await tempDir(), 'ready');
    // Ignored dispositions survive exec, so the sleep ignores SIGTERM too.
    const run = detachedRun(`trap '' TERM; echo ready > '${readyFile}'; sleep 30`);
    expect(await eventually(() => Bun.file(readyFile).exists(), 10_000)).toBe(true);
    supervisor.attach(run);

    const startedAt = Date.now();
    signals.send('SIGTERM');
    signals.send('SIGHUP');
    const report = await supervisor.finish();

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(report?.escalated).toBe(true);
    expect(report?.signal).toBe('SIGTERM');
    expect(supervisor.stoppedBy).toBe('SIGTERM');
    expect(events.map(event => event.kind)).toEqual([ 'stopping', 'escalating' ]);
    expect(await eventually(() => processGone(run.subprocess.pid), 5_000)).toBe(true);
  }, 20_000);

  test('a signal after the run ended on its own stops nothing and is not the run\'s outcome', async () => {
    const signals = new TestSignals();
    const events: SupervisorEvent[] = [];
    const supervisor = superviseSignals({ graceMs: 5_000, source: signals, onEvent: event => events.push(event) });
    const run = detachedRun('exit 3');
    supervisor.attach(run);
    expect(await run.subprocess.exited).toBe(3);

    signals.send('SIGINT');

    expect(await supervisor.finish()).toBeNull();
    expect(supervisor.stoppedBy).toBeNull();
    expect(events).toEqual([ { kind: 'after-exit', signal: 'SIGINT' } ]);
  });

  test('finish() ends a run still going with SIGTERM, which is not a signal stop', async () => {
    const signals = new TestSignals();
    const events: SupervisorEvent[] = [];
    const supervisor = superviseSignals({ graceMs: 5_000, source: signals, onEvent: event => events.push(event) });
    const run = detachedRun('sleep 30');
    supervisor.attach(run);

    const report = await supervisor.finish();

    expect(report?.signal).toBe('SIGTERM');
    expect(report?.signalCode).toBe('SIGTERM');
    expect(supervisor.stoppedBy).toBeNull();
    expect(events.map(event => event.kind === 'stopping' ? event.cause : event.kind)).toEqual([ 'finish' ]);
    expect(await supervisor.finish()).toBe(report);
    expect(processGone(run.subprocess.pid)).toBe(true);
  }, 20_000);

  test('a signal during a finish() stop hurries that stop: one stop, SIGKILL at once, no stoppedBy', async () => {
    const signals = new TestSignals();
    const events: SupervisorEvent[] = [];
    const supervisor = superviseSignals({ graceMs: 60_000, source: signals, onEvent: event => events.push(event) });
    const dir = await tempDir();
    const readyFile = path.join(dir, 'ready');
    const childFile = path.join(dir, 'child.pid');
    // Neither the launcher nor its child will go on SIGTERM; only SIGKILL
    // ends them inside the 60-second grace.
    const run = detachedRun(`trap '' TERM; sleep 30 & echo $! > '${childFile}'; echo ready > '${readyFile}'; wait`);
    expect(await eventually(() => Bun.file(readyFile).exists(), 10_000)).toBe(true);
    const child = await pidIn(childFile);
    supervisor.attach(run);

    const startedAt = Date.now();
    const finishing = supervisor.finish();
    signals.send('SIGINT');
    const report = await finishing;

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(events.map(event => event.kind)).toEqual([ 'stopping', 'escalating' ]);
    expect(events[0]).toMatchObject({ kind: 'stopping', cause: 'finish' });
    expect(report?.signal).toBe('SIGTERM');
    expect(report?.escalated).toBe(true);
    expect(report?.groupState).toBe('empty');
    expect(supervisor.stoppedBy).toBeNull();
    expect(await eventually(() => processGone(run.subprocess.pid) && processGone(child), 5_000)).toBe(true);
    expect(signals.listening).toBe(0);
  }, 20_000);

  test('a grace that cannot bound a stop is refused, and no handler is left installed', async () => {
    const signals = new TestSignals();
    for (const graceMs of [ Number.NaN, Number.POSITIVE_INFINITY, -1, undefined, '10' ]) {
      const options = { graceMs: 0, source: signals };
      Object.assign(options, { graceMs });
      expect(() => superviseSignals(options)).toThrow('graceMs must be a finite number');
    }
    expect(signals.listening).toBe(0);

    // stopClaude refuses it before signalling anything: the process lives on.
    const run = detachedRun('sleep 30');
    const options: StopOptions = { signal: 'SIGTERM', graceMs: 0 };
    Object.assign(options, { graceMs: undefined });
    await expect(stopClaude(run, options)).rejects.toThrow('graceMs must be a finite number');
    expect(processGone(run.subprocess.pid)).toBe(false);
  });

  test('signal names that cannot stop a run are refused before any handler is installed', () => {
    const signals = new TestSignals();
    for (const requested of [ [ 'SIGTERM', 'SIGKILL' ], [ 'SIGUSR1' ], [ 'SIGINT', 15 ], 'SIGTERM' ]) {
      const options = { graceMs: 1_000, source: signals };
      Object.assign(options, { signals: requested });
      expect(() => superviseSignals(options)).toThrow();
      expect(signals.listening).toBe(0);
    }
  });

  test('a signal named twice is listened for once, so release removes every handler', () => {
    const signals = new TestSignals();
    const supervisor = superviseSignals({ graceMs: 1_000, source: signals, signals: [ 'SIGTERM', 'SIGTERM', 'SIGINT' ] });
    expect(signals.listening).toBe(2);
    supervisor.release();
    expect(signals.listening).toBe(0);
  });

  test('release() is refused once a run is attached, and the handlers stay until finish()', async () => {
    const signals = new TestSignals();
    const supervisor = superviseSignals({ graceMs: 5_000, source: signals });
    const run = detachedRun('sleep 30');
    supervisor.attach(run);

    expect(() => supervisor.release()).toThrow('a run is attached');
    expect(signals.listening).toBe(3);

    await supervisor.finish();
    expect(signals.listening).toBe(0);
    expect(processGone(run.subprocess.pid)).toBe(true);
    expect(() => supervisor.release()).not.toThrow();
  }, 20_000);

  test('listens for the signals asked for, until released, and supervises one run', async () => {
    const signals = new TestSignals();
    const supervisor = superviseSignals({ graceMs: 5_000, source: signals, signals: [ 'SIGTERM' ] });
    expect(signals.listening).toBe(1);
    signals.send('SIGINT'); // Not asked for: nothing is held.

    const run = detachedRun('exit 0');
    supervisor.attach(run);
    expect(() => supervisor.attach(run)).toThrow('one is already attached');
    await run.subprocess.exited;
    expect(await supervisor.finish()).toBeNull();
    expect(supervisor.stoppedBy).toBeNull();

    const failedSpawn = superviseSignals({ graceMs: 5_000, source: signals });
    expect(signals.listening).toBe(3);
    failedSpawn.release();
    expect(signals.listening).toBe(0);
    expect(() => failedSpawn.attach(run)).toThrow('has ended');
  });
});
