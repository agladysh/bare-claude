import { describe, expect, test } from 'bun:test';

import { processGroupState, stopClaude } from './lifecycle.ts';

/**
 * The refusals here are what keeps a stop inside the run's own boundary:
 * group ids with a broadcast meaning to kill(2), this process's own, and any
 * id that is not the spawned process's. How a stop ends a real process tree
 * is tested through the CLI, in `test/termination.cli.test.ts`.
 */
describe.if(process.platform === 'darwin' || process.platform === 'linux')('lifecycle', () => {
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
    const report = await stopClaude({ subprocess, processGroup: null }, { signal: 'SIGTERM', graceMs: 5_000 });

    expect(report.signal).toBe('SIGTERM');
    expect(report.escalated).toBe(false);
    expect(report.signalCode).toBe('SIGTERM');
    expect(report.processGroup).toBeNull();
    expect(report.groupState).toBeNull();
  });

  test('a process that already ended is reported, not signalled', async () => {
    const subprocess = Bun.spawn({ cmd: [ 'sh', '-c', 'exit 4' ], stdout: 'ignore', stderr: 'ignore', detached: true });
    await subprocess.exited;
    const report = await stopClaude({ subprocess, processGroup: subprocess.pid }, { signal: 'SIGTERM', graceMs: 1_000 });

    expect(report.escalated).toBe(false);
    expect(report.exitCode).toBe(4);
    expect(report.groupState).toBe('empty');
  });
});
