/**
 * Stopping a run `spawnClaude` started, and how far a stop reaches.
 *
 * `spawnClaude` spawns one process: `claude`, or whatever `claudePath` names.
 * That process may be a launcher that starts the native Claude Code process
 * as a child of its own and supervises it. A signal sent to the spawned PID
 * reaches that process only; whether anything it started stops as well is up
 * to the launcher.
 *
 * Spawned with `spawnOptions.detached: true` on macOS or Linux, the process
 * calls `setsid()` before it executes (bun-types 1.3.13, `detached`). It then
 * leads a session and a process group of its own, whose id is its PID, and
 * every descendant is in that group unless it starts a session of its own.
 * A signal to the group reaches all of them. That group is the boundary
 * {@link stopClaude} works within: it signals the process Bun spawned through
 * Bun's own handle, and that process group. It never signals a PID it read
 * from anywhere else, and never a group it did not create.
 *
 * What a stop does not reach: a descendant that called `setsid()` itself,
 * anything the run asked another service to do, and requests already sent to
 * a model provider. A stop also cannot undo what the run already wrote, in
 * its working directory or its session journal.
 */

/** Whether a process group still has members this process may signal. */
export type ProcessGroupState = 'empty' | 'occupied' | 'not-permitted';

/** The part of a spawned run that {@link stopClaude} needs. */
export interface StoppableRun {
  /** The process `spawnClaude` spawned; a `Bun.Subprocess` satisfies this. */
  subprocess: {
    readonly pid: number,
    readonly exitCode: number | null,
    readonly signalCode: NodeJS.Signals | null,
    readonly exited: Promise<number>,
    kill(signal?: number | NodeJS.Signals): void,
  },

  /**
   * The process group the spawned process leads, or null when it was not
   * spawned detached (or on Windows, where there is no such group).
   */
  processGroup: number | null,
}

/** How {@link stopClaude} asks a run to end. */
export interface StopOptions {
  /** Sent first, to the spawned process alone. */
  signal: NodeJS.Signals,

  /**
   * How long the run gets, from the first signal, before every process left
   * in its group is sent `SIGKILL`.
   */
  graceMs: number,

  /** Aborting it cuts the grace short and sends `SIGKILL` at once. */
  escalate?: AbortSignal,
}

/** What {@link stopClaude} did, and what it found afterwards. */
export interface StopReport {
  /** The signal sent first. */
  signal: NodeJS.Signals,

  /** Whether `SIGKILL` was sent. */
  escalated: boolean,

  /** The spawned process's exit code, null when it ended by a signal or has not ended. */
  exitCode: number | null,

  /** The signal that ended the spawned process, if one did. */
  signalCode: NodeJS.Signals | null,

  /** The process group signalled, null when the run has none. */
  processGroup: number | null,

  /**
   * The group's state at the end: `empty` when nothing is left in it,
   * `occupied` when something outlived even `SIGKILL` within the wait, and
   * `not-permitted` when what is left there is not this process's to signal.
   * Null when the run has no group.
   */
  groupState: ProcessGroupState | null,
}

/** How often a group is polled for members while waiting for it to empty. */
const pollMs = 50;

/** How long to wait for `SIGKILL` to take effect before reporting what is left. */
const killWaitMs = 2_000;

/** Narrows a thrown value to the errno `code` a Node system error carries. */
function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

/**
 * Refuses a process group id this module must never signal. 0 and negative
 * ids, and 1, have broadcast meanings to `kill(2)`; this process's own PID
 * would be its own group if it leads one.
 */
function assertOwnGroup(pgid: number): void {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    throw new Error(`refusing to signal process group ${pgid}: not a group a spawned run leads`);
  }
}

/**
 * Whether anything is left in process group `pgid`, probed with signal 0,
 * which checks without delivering anything.
 * @param pgid - A group a run spawned with `detached: true` leads
 */
export function processGroupState(pgid: number): ProcessGroupState {
  assertOwnGroup(pgid);
  try {
    process.kill(-pgid, 0);
    return 'occupied';
  } catch (error) {
    switch (errorCode(error)) {
      case 'ESRCH':
        return 'empty';
      case 'EPERM':
        return 'not-permitted';
      default:
        throw error;
    }
  }
}

/** Sends `signal` to every process in `pgid`; a group that emptied meanwhile is not an error. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  assertOwnGroup(pgid);
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ESRCH' && code !== 'EPERM') {
      throw error;
    }
  }
}

function isRunning(subprocess: StoppableRun['subprocess']): boolean {
  return subprocess.exitCode === null && subprocess.signalCode === null;
}

/**
 * Resolves when `waitFor` settles, `ms` pass, or `abort` fires, whichever is
 * first, and leaves no timer or listener behind: a pending timer would keep
 * the process alive for the rest of the grace after the run has ended.
 */
async function settle(waitFor: Promise<number> | null, ms: number, abort: AbortSignal | undefined): Promise<void> {
  const cleanup: (() => void)[] = [];
  try {
    await Promise.race([
      ...(waitFor === null ? [] : [ waitFor ]),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(0, ms));
        cleanup.push(() => clearTimeout(timer));
      }),
      new Promise<void>(resolve => {
        if (abort === undefined) {
          return;
        }
        if (abort.aborted) {
          resolve();
          return;
        }
        const onAbort = () => resolve();
        abort.addEventListener('abort', onAbort, { once: true });
        cleanup.push(() => abort.removeEventListener('abort', onAbort));
      }),
    ]);
  } finally {
    for (const release of cleanup) {
      release();
    }
  }
}

/**
 * Ends a run in three steps, each bounded:
 *
 * 1. `options.signal` goes to the spawned process alone, so a supervising
 *    launcher can shut down what it started in its own order.
 * 2. Once that process has ended, whatever it left in its process group is
 *    sent `options.signal` once, and given the rest of the grace.
 * 3. If anything is still running when the grace ends or `options.escalate`
 *    is aborted, the whole group is sent `SIGKILL` — or the spawned process
 *    alone, when the run has no group.
 *
 * Resolves with what was done and what was left; it does not throw for a
 * process that ended on its own meanwhile. The spawned process's exit is
 * reported as it happened. Whether the run's task was done, and what it
 * changed before it stopped, are not things a stop can tell.
 * @param run - The value `spawnClaude` returned, or anything shaped like it
 * @param options - See {@link StopOptions}
 * @throws When `run.processGroup` is not the spawned process's own PID
 */
export async function stopClaude(run: StoppableRun, options: StopOptions): Promise<StopReport> {
  const { subprocess, processGroup } = run;
  if (processGroup !== null) {
    assertOwnGroup(processGroup);
    // setsid() makes the spawned process lead a group whose id is its PID;
    // any other id was not created by this run.
    if (processGroup !== subprocess.pid) {
      throw new Error(`refusing to signal process group ${processGroup}: the run's process is ${subprocess.pid}`);
    }
  }

  const deadline = Date.now() + Math.max(0, options.graceMs);
  const remaining = () => deadline - Date.now();
  const cutShort = () => options.escalate?.aborted === true || remaining() <= 0;

  if (isRunning(subprocess)) {
    subprocess.kill(options.signal);
  }

  let groupSignalled = false;
  while (!cutShort()) {
    if (isRunning(subprocess)) {
      await settle(subprocess.exited, remaining(), options.escalate);
      continue;
    }
    if (processGroup === null || processGroupState(processGroup) !== 'occupied') {
      break;
    }
    if (!groupSignalled) {
      signalGroup(processGroup, options.signal);
      groupSignalled = true;
    }
    await settle(null, Math.min(pollMs, remaining()), options.escalate);
  }

  const leftovers = isRunning(subprocess)
    || (processGroup !== null && processGroupState(processGroup) === 'occupied');
  if (leftovers) {
    if (processGroup === null) {
      subprocess.kill('SIGKILL');
    } else {
      signalGroup(processGroup, 'SIGKILL');
    }
    // SIGKILL cannot be caught, but a process blocked in the kernel dies
    // only when the call returns, so the wait is bounded rather than assumed.
    await settle(subprocess.exited, killWaitMs, undefined);
    const until = Date.now() + killWaitMs;
    while (processGroup !== null && Date.now() < until && processGroupState(processGroup) === 'occupied') {
      await settle(null, pollMs, undefined);
    }
  }

  return {
    signal: options.signal,
    escalated: leftovers,
    exitCode: subprocess.exitCode,
    signalCode: subprocess.signalCode,
    processGroup,
    groupState: processGroup === null ? null : processGroupState(processGroup),
  };
}
