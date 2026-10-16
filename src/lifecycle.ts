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
 *
 * {@link superviseSignals} is the policy around a stop — which signals start
 * one, holding one that arrives before there is a run, escalating on a second,
 * and waiting for the stop before anything is cleaned up. The CLI uses it as
 * is; a library caller should too, rather than rebuilding it.
 */

/**
 * What signal 0 to a process group answered: `occupied` when it succeeded,
 * so some member could be signalled; `empty` on ESRCH, when there is no such
 * group; `not-permitted` on EPERM, when this process may signal none of the
 * members `kill(2)` found. EPERM does not say whether any of them is still
 * running, whose it is, or whether it will go: it is not `empty`, and it is
 * not evidence of anyone's ownership.
 */
export type ProcessGroupState = 'empty' | 'occupied' | 'not-permitted';

/** One signal-0 reading of a process group, `elapsedMs` after the first. */
export interface ProcessGroupObservation {
  elapsedMs: number,
  state: ProcessGroupState,
}

/** A process group's state, with every reading it was decided from. */
export interface ProcessGroupReading {
  /** The last reading's state. */
  state: ProcessGroupState,

  /** Every reading, in order; the first at 0 ms. */
  observations: ProcessGroupObservation[],
}

/** The part of a spawned run that {@link stopClaude} needs. */
export interface StoppableRun {
  /** The process `spawnClaude` spawned; a `Bun.Subprocess` satisfies this. */
  subprocess: {
    readonly pid: number,
    readonly exitCode: number | null,
    readonly signalCode: number | NodeJS.Signals | null,
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

  /** The signal that ended the spawned process, as Bun reports it (name or number), if one did. */
  signalCode: number | NodeJS.Signals | null,

  /** The process group signalled, null when the run has none. */
  processGroup: number | null,

  /**
   * The group's state at the end, read by {@link readProcessGroup}: `empty`
   * when nothing is left in it, `occupied` when something in it could still
   * be signalled (after `SIGKILL` and its wait when `escalated`; otherwise
   * the group had not read `occupied` when `SIGKILL` was decided against),
   * and `not-permitted` when signal 0 failed with EPERM throughout the
   * recheck, which shows neither that something is left nor whose it would
   * be. Null when the run has no group.
   */
  groupState: ProcessGroupState | null,

  /** Every reading `groupState` was decided from, in order; empty when the run has no group. */
  groupObservations: ProcessGroupObservation[],
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

/**
 * How long {@link readProcessGroup} goes on reading a group that reads
 * `not-permitted`. Observed on macOS on 16 October 2026: signal 0 to the
 * group of a stopped run whose processes had exited failed with EPERM, and a
 * later reading of the same group with ESRCH. It happened repeatedly in this
 * module's own tests, and in a 37-case native Claude Code probe, which
 * completed once it read again for up to 1 s. Why the kernel answers EPERM
 * there was not established.
 */
export const notPermittedRecheckMs = 1_000;

/**
 * Reads process group `pgid` with {@link processGroupState}, and while it
 * reads `not-permitted`, reads it again every 50 ms for up to
 * {@link notPermittedRecheckMs}. Resolves with the last state and every
 * reading; a `not-permitted` that persists is reported as it is, never as
 * `empty`. Delivers no signal, and resolves within the recheck plus one poll.
 * @param pgid - A group a run spawned with `detached: true` leads
 * @throws What {@link processGroupState} throws
 */
export async function readProcessGroup(pgid: number): Promise<ProcessGroupReading> {
  const started = performance.now();
  let state = processGroupState(pgid);
  const observations: ProcessGroupObservation[] = [ { elapsedMs: 0, state } ];
  while (state === 'not-permitted' && performance.now() - started < notPermittedRecheckMs) {
    await settle(null, Math.min(pollMs, notPermittedRecheckMs - (performance.now() - started)), undefined);
    state = processGroupState(pgid);
    observations.push({ elapsedMs: performance.now() - started, state });
  }
  return { state, observations };
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

/**
 * Refuses a grace that would not bound a stop. Checked at run time because a
 * JavaScript caller is not held to the type: an absent one made the deadline
 * NaN, which never passes, so SIGKILL was never sent.
 */
function assertGrace(graceMs: unknown): void {
  if (typeof graceMs !== 'number' || !Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(`graceMs must be a finite number of milliseconds, 0 or more, got ${String(graceMs)}`);
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
 * reported as it happened, and the group's state as {@link readProcessGroup}
 * reads it, so a `not-permitted` reading is read again for up to
 * {@link notPermittedRecheckMs} first. Whether the run's task was done, and
 * what it changed before it stopped, are not things a stop can tell.
 * @param run - The value `spawnClaude` returned, or anything shaped like it
 * @param options - See {@link StopOptions}
 * @throws When `run.processGroup` is not the spawned process's own PID, or
 *   `options.graceMs` is not a finite number of milliseconds from 0 up;
 *   either before anything is signalled
 */
export async function stopClaude(run: StoppableRun, options: StopOptions): Promise<StopReport> {
  assertGrace(options.graceMs);
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

  const group = processGroup === null ? null : await readProcessGroup(processGroup);
  return {
    signal: options.signal,
    escalated: leftovers,
    exitCode: subprocess.exitCode,
    signalCode: subprocess.signalCode,
    processGroup,
    groupState: group?.state ?? null,
    groupObservations: group?.observations ?? [],
  };
}

/** POSIX numbers of the signals a supervisor stops a run on; the same on macOS and Linux. */
export const stopSignalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/** A signal {@link superviseSignals} turns into a stop. */
export type StopSignal = keyof typeof stopSignalNumbers;

/** Every {@link StopSignal}, the default set a supervisor listens for. */
export const stopSignals: readonly StopSignal[] = [ 'SIGHUP', 'SIGINT', 'SIGTERM' ];

/**
 * The shell's exit status for a command ended by `signal`: 128 plus its
 * number, so 129, 130 and 143. A runner reading it cannot mistake a stopped
 * run for a completed one.
 */
export function signalExitStatus(signal: StopSignal): number {
  return 128 + stopSignalNumbers[signal];
}

/** Narrows a value from untyped code to a {@link StopSignal}. */
function isStopSignal(value: unknown): value is StopSignal {
  return stopSignals.some(signal => signal === value);
}

/**
 * The signals a supervisor will listen for, each once, or a refusal. All of
 * this happens before a single handler is installed, so a refusal leaves
 * none behind; and each signal is listened for once, so release removes
 * every handler it installed.
 */
function signalsToSupervise(requested: unknown): StopSignal[] {
  if (requested === undefined) {
    return [ ...stopSignals ];
  }
  if (!Array.isArray(requested)) {
    throw new Error('signals must be an array of signal names');
  }
  const names: readonly unknown[] = requested;
  const unique = new Set<StopSignal>();
  for (const signal of names) {
    if (!isStopSignal(signal)) {
      throw new Error(`cannot supervise ${String(signal)}: only ${stopSignals.join(', ')} stop a run`);
    }
    unique.add(signal);
  }
  return [ ...unique ];
}

/**
 * Where a supervisor's signals come from. The default is this process's own
 * signal handlers; anything else with the same two methods can deliver them,
 * which is how the tests deliver signals without sending any to themselves.
 */
export interface SignalSource {
  on(signal: StopSignal, listener: () => void): void,
  off(signal: StopSignal, listener: () => void): void,
}

const processSignals: SignalSource = {
  on: (signal, listener) => {
    process.on(signal, listener);
  },
  off: (signal, listener) => {
    process.off(signal, listener);
  },
};

/** Something a supervisor did, for its caller to report. */
export type SupervisorEvent =
  /** A signal arrived before {@link Supervisor.attach}; the run is stopped once attached. */
  | { kind: 'held', signal: StopSignal }
  /**
   * A stop began: `cause` is the signal that started it, or `'finish'` when
   * {@link Supervisor.finish} found the run still going and sent `SIGTERM`.
   */
  | { kind: 'stopping', cause: StopSignal | 'finish', pid: number, processGroup: number | null, graceMs: number }
  /** A further signal during a stop: `SIGKILL` goes out now. */
  | { kind: 'escalating', signal: StopSignal }
  /** A signal arrived after the run had ended on its own; nothing was stopped. */
  | { kind: 'after-exit', signal: StopSignal };

/** How {@link superviseSignals} supervises. */
export interface SupervisorOptions {
  /** Passed to {@link stopClaude}: how long a stopped run gets before `SIGKILL`. */
  graceMs: number,

  /** Which signals start a stop. Defaults to {@link stopSignals}, all three. */
  signals?: readonly StopSignal[],

  /**
   * Told of every {@link SupervisorEvent}, synchronously, just before the
   * effect it reports. Best-effort reporting, not proof of delivery: an
   * exception it throws is ignored, so a failing reporter cannot keep a run
   * from being stopped or a stop from escalating. Anything it starts
   * asynchronously, a stream write's later error included, is its own.
   */
  onEvent?: (event: SupervisorEvent) => void,

  /** Where signals come from. Defaults to this process. */
  source?: SignalSource,
}

/** One run's supervision, from before it is spawned until it is cleaned up. */
export interface Supervisor {
  /**
   * Hands over the run `spawnClaude` returned. A signal held since
   * {@link superviseSignals} was called starts its stop now.
   * @throws When a run was already attached, or supervision has ended
   */
  attach(run: StoppableRun): void,

  /** The signal that started a stop of a running run; null when none did. */
  readonly stoppedBy: StopSignal | null,

  /**
   * Ends supervision. If the attached run is still going and nothing stopped
   * it, stops it with `SIGTERM`; waits for any stop, with the handlers still
   * in place so a further signal still escalates; then removes them. Resolves
   * with the stop's report, or null when there was no stop. Idempotent. Call
   * it before removing the run's home.
   */
  finish(): Promise<StopReport | null>,

  /**
   * Removes the handlers without stopping anything, for when the spawn
   * failed and there is no run to attach. Once a run is attached it is
   * refused: removing the handlers then would let the next signal end this
   * process and orphan the detached run, or cut a stop short. Use
   * {@link finish}, which stops what is still running first. A no-op after
   * `finish` or an earlier `release`.
   * @throws When a run is attached and supervision has not finished
   */
  release(): void,
}

/**
 * Starts supervising one run, before it is spawned: from this call on, the
 * signals in `options.signals` no longer end this process, they stop the run.
 *
 * - The first signal stops the attached run with {@link stopClaude}: that
 *   signal to the spawned process, then once to its process group, then
 *   `SIGKILL` to the group once `options.graceMs` has passed.
 * - A signal before {@link Supervisor.attach} is held and acted on at attach.
 * - Any further signal during a stop — one a signal started, or one
 *   {@link Supervisor.finish} started — sends `SIGKILL` at once, to that same
 *   stop. It never starts a second stop, and a signal that only hurried a
 *   `finish` stop is not recorded as {@link Supervisor.stoppedBy}.
 * - A signal after the run has ended on its own stops nothing and is not
 *   recorded as {@link Supervisor.stoppedBy}.
 *
 * Call {@link Supervisor.attach} as soon as the spawn returns, before
 * anything else that could throw, and {@link Supervisor.finish} once the run
 * has ended, or to end it, and only then dispose of its home. Until `finish`
 * or `release`, this process cannot be ended by those signals; it must end
 * itself.
 * @param options - See {@link SupervisorOptions}
 * @returns The supervision of the run about to be spawned
 * @throws When `options.graceMs` is not a finite number from 0 up, or
 *   `options.signals` names anything but SIGHUP, SIGINT and SIGTERM; before
 *   any handler is installed
 */
export function superviseSignals(options: SupervisorOptions): Supervisor {
  assertGrace(options.graceMs);
  const supervised = signalsToSupervise(options.signals);
  const source = options.source ?? processSignals;
  const escalate = new AbortController();
  const emit = (event: SupervisorEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A reporter that fails must not keep a run from being stopped: every
      // emit comes before the effect it reports.
    }
  };

  let run: StoppableRun | null = null;
  let requested: StopSignal | null = null;
  let stoppedBy: StopSignal | null = null;
  let report: Promise<StopReport> | null = null;
  let finishing: Promise<StopReport | null> | null = null;
  let released = false;

  const startStop = (attached: StoppableRun, cause: StopSignal | 'finish') => {
    emit({
      kind: 'stopping',
      cause,
      pid: attached.subprocess.pid,
      processGroup: attached.processGroup,
      graceMs: options.graceMs,
    });
    report = stopClaude(attached, {
      signal: cause === 'finish' ? 'SIGTERM' : cause,
      graceMs: options.graceMs,
      escalate: escalate.signal,
    });
    if (cause !== 'finish') {
      stoppedBy = cause;
    }
  };

  const onSignal = (signal: StopSignal) => {
    // A stop under way, whoever started it, is hurried, never doubled.
    if (requested !== null || report !== null) {
      if (!escalate.signal.aborted) {
        emit({ kind: 'escalating', signal });
        escalate.abort();
      }
      return;
    }
    if (run !== null && !isRunning(run.subprocess)) {
      emit({ kind: 'after-exit', signal });
      return;
    }
    requested = signal;
    if (run === null) {
      emit({ kind: 'held', signal });
    } else {
      startStop(run, signal);
    }
  };

  const listeners = new Map<StopSignal, () => void>();
  for (const signal of supervised) {
    const listener = () => onSignal(signal);
    listeners.set(signal, listener);
    source.on(signal, listener);
  }

  const removeHandlers = () => {
    if (released) {
      return;
    }
    released = true;
    for (const [ signal, listener ] of listeners) {
      source.off(signal, listener);
    }
  };

  const release = () => {
    if (released) {
      return;
    }
    if (run !== null) {
      throw new Error('a run is attached; finish() stops it if need be and then releases the handlers');
    }
    removeHandlers();
  };

  return {
    attach: (attached) => {
      if (run !== null) {
        throw new Error('a supervisor supervises one run, and one is already attached');
      }
      if (released) {
        throw new Error('this supervision has ended; start a new one for a new run');
      }
      run = attached;
      if (requested !== null) {
        startStop(attached, requested);
      }
    },
    get stoppedBy() {
      return stoppedBy;
    },
    finish: () => {
      finishing ??= (async () => {
        if (run !== null && report === null && isRunning(run.subprocess)) {
          startStop(run, 'finish');
        }
        try {
          return report === null ? null : await report;
        } finally {
          removeHandlers();
        }
      })();
      return finishing;
    },
    release,
  };
}
