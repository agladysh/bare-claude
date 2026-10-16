/**
 * Run custody: one run of `spawnClaude`, kept in a directory made for it
 * alone, from before the spawn until the spawned process has been seen to
 * end, and handed to the caller's code as it goes.
 *
 * The directory must not exist; its parent must. It is created mode 0700, and
 * every file custody writes there is created exclusively and never rewritten:
 *
 * - `invocation.json`, before the spawn: launcher, executable, model, effort,
 *   permission mode, tool and read scope, budget and token caps, auth mode,
 *   `linkAuth`, `noProcessEnv`, `extraArgs`, the physical cwd, the Claude
 *   home, and whether the session is fresh or continued, and from what. No
 *   environment value, no settings document, no token custody read. The call
 *   to action as its length and digest, and its text in `call-to-action.txt`
 *   only when the caller asks. `extraArgs` are recorded verbatim, so a secret
 *   passed there is recorded with them.
 * - `stdout` and `stderr`: the spawned process's standard output and error,
 *   byte for byte. They are the child's own descriptors, so it writes them
 *   itself as it runs: nothing is buffered or interpreted here, and nothing
 *   the run leaves behind can hold this process up by keeping a pipe open.
 * - `start.json`, after the spawn returned: the PID, process group, session id
 *   and journal path, when the record was written, and the caller's own
 *   reading of the process's identity when `identify` was given.
 * - `completion.json`, once the spawned process has been seen to end or
 *   never started, or once custody, unable to record its start, has stopped
 *   it within the stop's bounded waits: how it ended, whether and why
 *   custody stopped it, how its process group read, and the size and digest
 *   of each output and of the journal. Otherwise custody waits for the
 *   spawned process's exit without a bound, as an ordinary run does.
 * - `home/`, the Claude home, unless the caller names another. It holds what
 *   any kept home holds: `settings.json`, with `extraSettings` merged in and
 *   its `env` block included; the session journal, which holds the call to
 *   action and whatever tools read, whatever `keepCallToAction` says; under
 *   `linkAuth`, a link to the real credential file where one was found; and
 *   Claude Code's own state.
 *
 * The directory is therefore not free of sensitive material, and custody does
 * not make it so. Files anyone else puts there are theirs; custody neither
 * reads nor removes them.
 *
 * Everything recorded is about processes. The spawned process is whatever
 * `claudePath` names — a launcher, perhaps, not native Claude Code — and how
 * it ended is not how native ended, nor whether the task was done, delivered,
 * received or accepted. A directory with `invocation.json` and no
 * `start.json` may hold a run spawned just before its runner died, since the
 * start is recorded after the spawn; `start.json` without `completion.json` is
 * a run whose end custody did not record: its runner may have died before
 * or after the spawned process ended. Either outcome is unknown, not failed
 * and not done. A PID in `start.json` names whatever process holds it when it is
 * read; it is no evidence that process is the run's.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertSafeCallToAction, LaunchConfig, physicalCwd, spawnClaude,
  type AuthMode, type Launcher, type LaunchOptions, type SessionSeed,
} from '@agladysh/bare-claude';
import {
  readProcessGroup, superviseSignals,
  type ProcessGroupReading, type SignalSource, type StopReport, type StopSignal, type SupervisorEvent,
} from '@agladysh/bare-claude/lifecycle';

import pkg from '../package.json';

/** Version of the records custody writes. It changes when what they mean changes. */
export const custodyVersion = 1;

/** What a completion reports, and the limit of it. */
export const completionScope = 'how the spawned process ended, as custody saw it; not how anything it started ended, nor whether the task was done, delivered, received or accepted';

/** Names of what custody keeps in its directory. */
export const custodyFiles = {
  invocation: 'invocation.json',
  callToAction: 'call-to-action.txt',
  stdout: 'stdout',
  stderr: 'stderr',
  start: 'start.json',
  completion: 'completion.json',
  home: 'home',
} as const;

/** Custody as a preset declares it. */
export interface CustodyDeclaration {
  /** The directory to keep the run in. It must not exist yet; its parent must. */
  directory: string,

  /** Keep the call to action's text as `call-to-action.txt`. Defaults to false. */
  keepCallToAction?: boolean,
}

/**
 * A process's identity as a caller read it: when it began, as the kernel
 * keeps that, and the boot it was read in. A PID alone is not one, since PIDs
 * are reused, and neither is when a record was written.
 */
export interface ProcessIdentity {
  /** How it was read, in the reader's own words. */
  method: string,

  /** When the process began, as `method` reports it; text, so no precision is lost. */
  start: string,

  /** The boot it was read in, as `method` names boots; null when it read none. */
  boot: string | null,
}

/** What `identify` gave: the three fields of its reading, or why there is none. */
export type CustodyIdentity = { observed: ProcessIdentity } | { failed: string };

/** How {@link runInCustody} keeps a run. */
export interface CustodyOptions extends CustodyDeclaration {
  /** Passed to `superviseSignals`: how long a stopped run gets before SIGKILL. */
  graceMs: number,

  /** Passed to `superviseSignals`: which signals stop the run. Defaults to all three. */
  signals?: readonly StopSignal[],

  /** Passed to `superviseSignals`: where signals come from. Defaults to this process. */
  source?: SignalSource,

  /** The spawn's own environment layer, `spawnOptions.env` to `spawnClaude`. Never recorded. */
  env?: Record<string, string | undefined>,

  /** Aborting it stops the run with SIGTERM; the completion says it was cancelled. */
  signal?: AbortSignal,

  /**
   * Called with every {@link CustodyEvent}, synchronously, as it happens.
   * Best effort: an exception it throws is ignored, and the records are
   * written whatever it does. A call hands the event to the caller's code; it
   * is not evidence that anyone received, read or acted on it. The returned
   * completion and `completion.json` are the record.
   */
  onEvent?: (event: CustodyEvent) => void,

  /**
   * Reads the spawned process's identity by the caller's own means, for
   * whoever later has only `start.json` to go on. Called once, with the PID,
   * synchronously as soon as the spawn returns and before custody awaits
   * anything; what it returns goes into `start.json` as `identity`. Whether
   * that PID still named the spawned process when it was read — by reading
   * before and after, say — is the reader's to establish, not custody's.
   * Without it, custody records the PID and no identity.
   */
  identify?: (pid: number) => ProcessIdentity,
}

/** How the run's session begins: fresh, or continued from a journal in memory or in a file. */
export type CustodySession =
  | { kind: 'fresh' }
  | { kind: 'memory', sessionId: string }
  | { kind: 'file', sessionId: string, sourcePath: string, sourceSha256: string | null };

/** `invocation.json`: what the caller chose, written before anything is spawned. */
export interface CustodyInvocation {
  format: 'bare-claude/run-invocation',
  version: typeof custodyVersion,

  /** When custody wrote this record. */
  recorded: string,

  /** The package that kept the run. */
  package: { name: string, version: string },

  launcher: Launcher,

  /** What is spawned: `claudePath`, or `ollama`. Not necessarily native Claude Code. */
  executable: string,

  model: string | null,
  effortLevel: string,
  permissionMode: string,
  tools: string[] | null,
  disallowedTools: string[] | null,
  addDirs: string[],
  maxBudgetUsd: number | null,
  maxTokens: number | null,
  maxOutputLength: number | null,
  auth: AuthMode,

  /**
   * Whether a link to the real credential file was asked for. One is made
   * only for the `claude` launcher, and only where that file exists.
   */
  linkAuth: boolean,

  noProcessEnv: boolean,

  /** As given: they reach the child's command line verbatim, and anything secret in them is recorded here. */
  extraArgs: string[],

  /** Physical, as the child runs in it. */
  cwd: string,

  claudeHome: string,
  session: CustodySession,

  /** Its length in bytes and digest; `kept` names its text's file when the caller asked for it. */
  callToAction: { bytes: number, sha256: string, kept: string | null },
}

/** `start.json`: the spawned process, as soon as custody could record it. */
export interface CustodyStart {
  format: 'bare-claude/run-start',
  version: typeof custodyVersion,

  /**
   * When custody wrote this record, after the spawn returned. Not when the
   * process began, and nothing by which to recognise it later.
   */
  recorded: string,

  pid: number,

  /** The group it leads, or null where there is none (Windows). */
  processGroup: number | null,

  sessionId: string,

  /** A path, not a file: the child creates it, and one that failed early may never have. */
  sessionJsonlPath: string,

  claudeHome: string,

  /** What `identify` read, or null when the caller gave none. */
  identity: CustodyIdentity | null,
}

/** One of the spawned process's outputs, as far as it had been written when it was read. */
export interface CustodyOutput {
  file: string,
  bytes: number,
  sha256: string,
}

/**
 * The session journal as it stood when read for the completion. Nothing here
 * says nothing still appends to it; see `CustodyCompletion.processGroupAfter`.
 */
export interface CustodyJournal {
  path: string,
  sessionId: string,
  exists: boolean,
  bytes: number | null,
  sha256: string | null,
}

/**
 * How the spawned process's custody ended: `not-started`; `exited`, seen to
 * end without custody stopping it, by its own exit or by a signal someone
 * else sent (`exitCode`, `signalCode`); or `stopped`, when custody started a
 * stop of it through the supervisor.
 */
export type CustodyOutcome = 'not-started' | 'exited' | 'stopped';

/** What started a stop: a signal to the supervisor, the caller's abort, or custody failing around the run. */
export type CustodyStopCause = StopSignal | 'cancelled' | 'custody-error';

/** `completion.json`: how the spawned process's custody ended. See {@link completionScope}. */
export interface CustodyCompletion {
  format: 'bare-claude/run-completion',
  version: typeof custodyVersion,
  scope: typeof completionScope,

  /**
   * When custody wrote this completion, after it saw the spawned process end
   * and read its group and outputs. Not when anything the run started last
   * acted: a launcher's native child may outlive it.
   */
  ended: string,

  outcome: CustodyOutcome,

  /** Why the run never started; null once it did. */
  notStarted: string | null,

  /** What Bun's `exited` resolved with; null when the end was not observed. */
  exitStatus: number | null,

  /**
   * The spawned process's exit code and the signal that ended it, as Bun
   * reports them (a name or a number). Both null after a stop means it had
   * not been seen to end when the stop's bounded waits ran out.
   */
  exitCode: number | null,
  signalCode: number | NodeJS.Signals | null,

  /** The signal that started a stop of the running run, as `Supervisor.stoppedBy`. */
  stoppedBy: StopSignal | null,

  /**
   * The stop custody started, and its report; the report is null when the
   * stop itself failed, which `custodyError` then says. Null with no stop.
   */
  stop: { cause: CustodyStopCause, report: StopReport | null } | null,

  /**
   * The spawned process's group once custody let go, as `readProcessGroup`
   * read it, every reading kept; null without a group. `empty` says signal 0
   * found nothing left in that one group. It does not say nothing the run
   * started is running: a descendant that called `setsid()`, a launcher's
   * child in a session of its own, or a service the run asked for work is
   * outside it, and may still be writing the journal or anything else.
   */
  processGroupAfter: ProcessGroupReading | null,

  /** What custody itself could not do or record, or null. */
  custodyError: string | null,

  stdout: CustodyOutput | null,
  stderr: CustodyOutput | null,

  /**
   * Whether to continue the session is the caller's to establish, with
   * whatever knows the native process; nothing here certifies it. A caller
   * that decides to passes `{ sessionId, sourcePath: path, sourceSha256:
   * sha256 }` as `customSessionData`, and the digest makes that spawn refuse
   * a journal that changed since it was read.
   */
  journal: CustodyJournal | null,
}

/** Something custody observed, in the order it did. */
export type CustodyEvent =
  | { kind: 'started', directory: string, start: CustodyStart }
  | { kind: 'supervisor', event: SupervisorEvent }
  | { kind: 'completed', directory: string, completion: CustodyCompletion };

/** Narrows a thrown value to the errno `code` a Node system error carries. */
function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Writes a record that must not exist yet, mode 0600. */
async function writeRecord(file: string, record: object): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/**
 * Size and SHA-256 of what `file` held when it was opened. Bounded by that
 * size: something the run left behind may still be appending.
 */
async function digest(file: string): Promise<CustodyOutput> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (bytes < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - bytes), bytes);
      if (bytesRead === 0) {
        break;
      }
      hash.update(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    return { file, bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function journalAt(file: string, sessionId: string): Promise<CustodyJournal> {
  try {
    const { bytes, sha256: digested } = await digest(file);
    return { path: file, sessionId, exists: true, bytes, sha256: digested };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { path: file, sessionId, exists: false, bytes: null, sha256: null };
    }
    throw error;
  }
}

function sessionOf(seed: SessionSeed | null): CustodySession {
  if (seed === null) {
    return { kind: 'fresh' };
  }
  if ('sourcePath' in seed) {
    return {
      kind: 'file',
      sessionId: seed.sessionId,
      sourcePath: path.resolve(seed.sourcePath),
      sourceSha256: seed.sourceSha256 ?? null,
    };
  }
  return { kind: 'memory', sessionId: seed.sessionId };
}

/** Narrows what an untyped `identify` returned to a {@link ProcessIdentity}. */
function isProcessIdentity(value: unknown): value is ProcessIdentity {
  return typeof value === 'object' && value !== null
    && 'method' in value && typeof value.method === 'string'
    && 'start' in value && typeof value.start === 'string'
    && 'boot' in value && (value.boot === null || typeof value.boot === 'string');
}

/** `identify`'s reading of `pid`, its three fields only, or why there is none. */
function identityOf(identify: (pid: number) => unknown, pid: number): CustodyIdentity {
  try {
    const read = identify(pid);
    return isProcessIdentity(read)
      ? { observed: { method: read.method, start: read.start, boot: read.boot } }
      : { failed: 'identify returned no { method, start, boot } of strings' };
  } catch (error) {
    return { failed: messageOf(error) };
  }
}

/** Reads the signal's current state, including changes during asynchronous preparation. */
function cancellationRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Runs `spawnClaude` in custody: see this module's documentation for what is
 * kept. Spawned detached on macOS and Linux, supervised by
 * `superviseSignals` from before the directory is made until the spawned
 * process has been seen to end, and stopped through it — by a signal, by
 * `options.signal`, or when custody cannot record the start, since a run
 * nobody could later find is not one custody keeps.
 *
 * Resolves with the completion, `not-started` included: once the directory
 * is made, a failure to spawn is the run's outcome, not an exception.
 * `ephemeralClaudeHomePath` defaults to the directory's own `home/`, kept
 * like everything else there; nothing in the directory is ever removed.
 * @param launchOptions - As for `spawnClaude`
 * @param options - See {@link CustodyOptions}
 * @returns How the run ended, as written to `completion.json` — unless that
 *   write failed, which `custodyError` then says
 * @throws Before anything is written: when the launch options or call to
 *   action are refused, the cwd does not exist, `graceMs` or `signals` are
 *   invalid, `options.signal` is already aborted, or the directory cannot be
 *   made fresh — it exists, or its parent does not
 */
export async function runInCustody(launchOptions: LaunchOptions, options: CustodyOptions): Promise<CustodyCompletion> {
  // Every refusal that needs nothing on disk comes first, so it leaves nothing.
  const config = LaunchConfig(launchOptions);
  assertSafeCallToAction(config.callToAction);
  const requested: unknown = options.directory;
  if (typeof requested !== 'string' || requested === '') {
    throw new Error('custody needs a directory to keep the run in');
  }
  if (config.ephemeralClaudeHomePath === '') {
    throw new Error('ephemeralClaudeHomePath is empty; give a directory, or null for the custody directory\'s own');
  }
  if (cancellationRequested(options.signal)) {
    throw new Error('custody was cancelled before the run started');
  }
  const cwd = await physicalCwd(config.cwd ?? process.cwd());
  const directory = path.resolve(requested);
  const file = (name: string) => path.join(directory, name);
  const claudeHome = path.resolve(config.ephemeralClaudeHomePath ?? file(custodyFiles.home));
  const keepCallToAction = options.keepCallToAction === true;

  const invocation: CustodyInvocation = {
    format: 'bare-claude/run-invocation',
    version: custodyVersion,
    recorded: new Date().toISOString(),
    package: { name: pkg.name, version: pkg.version },
    launcher: config.launcher,
    // As buildArgv names argv[0]: the ollama launcher never takes claudePath.
    executable: config.launcher === 'ollama' ? 'ollama' : config.claudePath,
    model: config.model,
    effortLevel: config.effortLevel,
    permissionMode: config.permissionMode,
    tools: config.tools,
    disallowedTools: config.disallowedTools,
    addDirs: config.addDirs,
    maxBudgetUsd: config.maxBudgetUsd,
    maxTokens: config.maxTokens,
    maxOutputLength: config.maxOutputLength,
    auth: config.auth,
    linkAuth: config.linkAuth,
    noProcessEnv: config.noProcessEnv,
    extraArgs: config.extraArgs,
    cwd,
    claudeHome,
    session: sessionOf(config.customSessionData),
    callToAction: {
      bytes: Buffer.byteLength(config.callToAction),
      sha256: sha256(config.callToAction),
      kept: keepCallToAction ? file(custodyFiles.callToAction) : null,
    },
  };

  const emit = (event: CustodyEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A reporter that fails must not change the run or what is recorded.
    }
  };

  // Whether custody started a stop, as the supervisor reports it before it
  // signals anything: a stop whose report never came is still a stop.
  let stopping = false;

  // Installed before the directory is made, so a signal from here on is held
  // until there is a run to stop, rather than ending this process.
  const supervisor = superviseSignals({
    graceMs: options.graceMs,
    signals: options.signals,
    source: options.source,
    onEvent: event => {
      if (event.kind === 'stopping') {
        stopping = true;
      }
      emit({ kind: 'supervisor', event });
    },
  });

  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    supervisor.release();
    switch (errorCode(error)) {
      case 'EEXIST':
        throw new Error(`custody directory ${directory} already exists; a run's custody begins in a fresh one`, { cause: error });
      case 'ENOENT':
        throw new Error(`custody directory ${directory} cannot be made: its parent does not exist`, { cause: error });
      default:
        throw error;
    }
  }

  const record = async (completion: CustodyCompletion): Promise<CustodyCompletion> => {
    try {
      await writeRecord(file(custodyFiles.completion), completion);
      return completion;
    } catch (error) {
      const note = `${custodyFiles.completion} was not written: ${messageOf(error)}`;
      return { ...completion, custodyError: completion.custodyError === null ? note : `${completion.custodyError}; ${note}` };
    }
  };

  const completionOf = (
    fields: Omit<CustodyCompletion, 'format' | 'version' | 'scope' | 'ended'>
  ): CustodyCompletion => ({
    format: 'bare-claude/run-completion',
    version: custodyVersion,
    scope: completionScope,
    ended: new Date().toISOString(),
    ...fields,
  });

  const spawn = async () => {
    await writeRecord(file(custodyFiles.invocation), invocation);
    if (keepCallToAction) {
      await fs.writeFile(file(custodyFiles.callToAction), config.callToAction, { flag: 'wx', mode: 0o600 });
    }
    const descriptors: number[] = [];
    try {
      const stdout = openSync(file(custodyFiles.stdout), 'wx', 0o600);
      descriptors.push(stdout);
      const stderr = openSync(file(custodyFiles.stderr), 'wx', 0o600);
      descriptors.push(stderr);
      return await spawnClaude({ ...launchOptions, cwd, ephemeralClaudeHomePath: claudeHome }, {
        env: options.env,
        stdin: 'ignore',
        stdout,
        stderr,
        // A group of its own, so a stop reaches what a launcher starts.
        detached: process.platform !== 'win32',
      });
    } finally {
      // The child has its own copies once spawned; these serve nothing after.
      // bun-types 1.3 documents a numeric descriptor as one the process
      // writes to, and says nothing of Bun closing it; one already closed is
      // tolerated here.
      for (const descriptor of descriptors) {
        try {
          closeSync(descriptor);
        } catch { /* Already closed. */ }
      }
    }
  };

  const spawned = await spawn().then(
    claude => ({ claude, error: null }),
    (error: unknown) => ({ claude: null, error }),
  );
  if (spawned.claude === null) {
    supervisor.release();
    const completion = await record(completionOf({
      outcome: 'not-started',
      notStarted: messageOf(spawned.error),
      exitStatus: null,
      exitCode: null,
      signalCode: null,
      stoppedBy: null,
      stop: null,
      processGroupAfter: null,
      custodyError: null,
      stdout: null,
      stderr: null,
      journal: null,
    }));
    emit({ kind: 'completed', directory, completion });
    return completion;
  }

  const { claude } = spawned;
  const { subprocess } = claude;
  // At once: a detached run is never left with nobody to stop it.
  supervisor.attach(claude);
  // Before custody awaits anything, so as near the spawn as custody can hand
  // a caller the PID. Bun may have reaped a child that ended at once.
  const identity = options.identify === undefined ? null : identityOf(options.identify, subprocess.pid);

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    // A stop that fails surfaces where finish() is awaited below.
    void supervisor.finish().catch(() => { /* Recorded below. */ });
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (cancellationRequested(options.signal)) {
    cancel();
  }

  const problems: string[] = [];
  let exitStatus: number | null = null;
  let recorded = true;
  try {
    const start: CustodyStart = {
      format: 'bare-claude/run-start',
      version: custodyVersion,
      recorded: new Date().toISOString(),
      pid: subprocess.pid,
      processGroup: claude.processGroup,
      sessionId: claude.sessionId,
      sessionJsonlPath: claude.sessionJsonlPath,
      claudeHome: claude.ephemeralClaudeHomePath,
      identity,
    };
    await writeRecord(file(custodyFiles.start), start);
    emit({ kind: 'started', directory, start });
  } catch (error) {
    recorded = false;
    problems.push(`${custodyFiles.start} was not written: ${messageOf(error)}`);
  }
  if (recorded) {
    exitStatus = await subprocess.exited;
  }
  options.signal?.removeEventListener('abort', cancel);

  // Stops the run if it is still going, which here means custody could not
  // record its start; otherwise waits for any stop a signal or the caller
  // started.
  const report = await supervisor.finish().catch((error: unknown) => {
    problems.push(`stop: ${messageOf(error)}`);
    return null;
  });
  if (exitStatus === null && (subprocess.exitCode !== null || subprocess.signalCode !== null)) {
    exitStatus = await subprocess.exited;
  }

  const attempt = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      problems.push(`${what}: ${messageOf(error)}`);
      return null;
    }
  };

  // The stop's own reading when there was one; otherwise one of the same
  // kind, so a transient EPERM is read again rather than recorded as final.
  const group = claude.processGroup;
  const processGroupAfter: ProcessGroupReading | null = report !== null && report.groupState !== null
    ? { state: report.groupState, observations: report.groupObservations }
    : group === null ? null : await attempt('process group', () => readProcessGroup(group));

  const stdout = await attempt(custodyFiles.stdout, () => digest(file(custodyFiles.stdout)));
  const stderr = await attempt(custodyFiles.stderr, () => digest(file(custodyFiles.stderr)));
  const journal = await attempt('journal', () => journalAt(claude.sessionJsonlPath, claude.sessionId));

  const completion = await record(completionOf({
    outcome: stopping ? 'stopped' : 'exited',
    notStarted: null,
    exitStatus,
    exitCode: subprocess.exitCode,
    signalCode: subprocess.signalCode,
    stoppedBy: supervisor.stoppedBy,
    stop: stopping
      ? { cause: supervisor.stoppedBy ?? (cancelled ? 'cancelled' : 'custody-error'), report }
      : null,
    processGroupAfter,
    custodyError: problems.length === 0 ? null : problems.join('; '),
    stdout,
    stderr,
    journal,
  }));
  emit({ kind: 'completed', directory, completion });
  return completion;
}
