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
 * - `observation.json`, once the completion is written or has failed to be:
 *   what {@link readCustody} read of the directory then — the same reading any
 *   later reader gets, as of that moment. It is a reading, not a receipt:
 *   whoever acts on the run still has to read it.
 * - `home/`, the Claude home, unless the caller names another. It holds what
 *   any kept home holds: `settings.json`, with `extraSettings` merged in and
 *   its `env` block included; the session journal, which holds the call to
 *   action and whatever tools read, whatever `keepCallToAction` says; under
 *   `linkAuth`, a link to the real credential file where one was found; and
 *   Claude Code's own state.
 *
 * The directory is therefore not free of sensitive material, and custody does
 * not make it so. Files anyone else puts there are theirs; custody neither
 * removes them nor reads them as its own, and a reading only lists their names.
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
  assertSafeCallToAction, LaunchConfig, Launchers, physicalCwd, spawnClaude,
  type AuthMode, type Launcher, type LaunchOptions, type SessionSeed,
} from '@agladysh/bare-claude';
import type { ConfigFileRecord, ConfigProvenance } from '@agladysh/bare-claude/config';
import {
  readProcessGroup, stopSignals, superviseSignals,
  type ProcessGroupObservation, type ProcessGroupReading, type ProcessGroupState,
  type SignalSource, type StopReport, type StopSignal, type SupervisorEvent,
} from '@agladysh/bare-claude/lifecycle';
import {
  isMeasuredPrompt, joinResult, readJournal, readResult,
  type ContextLimitEvidence, type JoinKind, type JournalReading, type ResultFile, type ResultJournalJoin,
  type ResultReading, type ResultStatus, type TokenSums,
} from '@agladysh/bare-claude/outcome';

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
  observation: 'observation.json',
  home: 'home',
} as const;

/** What a recorded configuration says, and the limit of it. */
export const configurationScope = 'the configuration as runInCustody\'s caller stated it; custody read none of these files, nothing reads them again or compares them afterwards, and no content is recorded';

/**
 * Which configuration declared a run, as {@link runInCustody}'s caller states
 * it: the files read, in the order composed, each by path and the size and
 * digest of the bytes parsed (see `readConfigFiles` in
 * `@agladysh/bare-claude/config`, which produces the provenance); and the
 * presets the invocation selected at its root.
 */
export interface CustodyConfiguration extends ConfigProvenance {
  /** The presets selected at the root, in order: `--use`, else the root's own `use`; null when none. */
  use: string[] | null,

  /** Where `use` came from; null when nothing was selected. */
  useFrom: 'command-line' | 'configuration' | null,
}

/** A {@link CustodyConfiguration} as `invocation.json` records it, with its {@link configurationScope}. */
export interface RecordedConfiguration extends CustodyConfiguration {
  scope: typeof configurationScope,
}

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

  /**
   * The configuration that declared the run, recorded in `invocation.json`
   * as stated, with {@link configurationScope}: custody reads none of it.
   * Without it, the record says none was stated.
   */
  configuration?: CustodyConfiguration,
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

  /**
   * The custody directory, absolute, as custody made it, so a reader can tell
   * a directory moved or copied since. Absent from records written by 0.12.0.
   */
  directory?: string,

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

  /**
   * The configuration as the caller stated it; null when it stated none.
   * Absent from records written before this field existed (0.12.0), which
   * say nothing about configuration either way.
   */
  configuration?: RecordedConfiguration | null,
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

  /**
   * The size and SHA-256 of exactly the bytes `spawnClaude` put in the
   * journal before the spawn: the seed, and anything preloaded with it. Null
   * when nothing was seeded. Absent from records written by 0.12.0. What
   * follows those bytes was appended after the spawn; they are the boundary
   * between a continued session's inherited records and this run's.
   */
  seededJournal?: { bytes: number, sha256: string } | null,
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

/**
 * Something custody observed, in the order it did. `observed` comes last,
 * after `completed`: the directory as {@link readCustody} read it then, and
 * the path it was written to as `observation.json`, or why it was not.
 * `observation` is null only if the reading itself failed, which `error`
 * then says. Neither changes the completion or the exit status.
 */
export type CustodyEvent =
  | { kind: 'started', directory: string, start: CustodyStart }
  | { kind: 'supervisor', event: SupervisorEvent }
  | { kind: 'completed', directory: string, completion: CustodyCompletion }
  | { kind: 'observed', directory: string, observation: CustodyReading | null, file: string | null, error: string | null };

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

/**
 * The stated configuration as `invocation.json` records it: the named fields
 * only, copied, so nothing else an untyped caller attached is recorded.
 */
function recordedConfiguration(stated: CustodyConfiguration | undefined): RecordedConfiguration | null {
  if (stated === undefined) {
    return null;
  }
  return {
    scope: configurationScope,
    source: stated.source,
    files: stated.files.map(({ path: named, realPath, bytes, sha256: digested }) => ({ path: named, realPath, bytes, sha256: digested })),
    use: stated.use === null ? null : [ ...stated.use ],
    useFrom: stated.useFrom,
  };
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
 *
 * Once the completion is written, or has failed to be, the directory is read
 * by {@link readCustody}, the reading kept as `observation.json` and passed on
 * as the `observed` event. A reading or write that fails is the event's
 * `error`, and changes neither the completion nor anything resolved here.
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
    directory,
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
    configuration: recordedConfiguration(options.configuration),
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

  // After the completion, on every route that writes one: the directory read
  // as any later reader reads it, kept as observation.json and passed on.
  // Nothing here changes the completion or what the caller makes of it.
  const conclude = async (completion: CustodyCompletion): Promise<CustodyCompletion> => {
    emit({ kind: 'completed', directory, completion });
    let observation: CustodyReading | null = null;
    let error: string | null = null;
    try {
      observation = await readCustody(directory);
      await writeRecord(file(custodyFiles.observation), observation);
    } catch (failure) {
      error = observation === null
        ? `the directory could not be read: ${messageOf(failure)}`
        : `${custodyFiles.observation} was not written: ${messageOf(failure)}`;
    }
    emit({ kind: 'observed', directory, observation, file: error === null ? file(custodyFiles.observation) : null, error });
    return completion;
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
    return conclude(completion);
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
      seededJournal: claude.seededJournal,
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
  return conclude(completion);
}

///////////////////////////////////////////////////////////////////////////////
// Reading a custody directory

/** Version of the readings {@link readCustody} returns. It changes when what they mean changes. */
export const custodyReadingVersion = 1;

/** What a custody reading reports, and the limit of it. */
export const custodyReadingScope = 'what one custody directory\'s files held when they were read; not whether anything is still running, how anything the run started ended, nor whether the task was done, delivered, received or accepted';

/** Who a reading says wrote the spawned process's stdout. */
export const stdoutProvenance = 'written by invocation.executable through its own descriptor; native Claude Code\'s output only where that executable is native Claude Code, which no record here establishes';

/**
 * What a custody directory's records say, by the combinations custody
 * writes. Each is about records, never about a live process: nothing is
 * signalled or looked up to read one.
 *
 * - `invocation-only`: `invocation.json` and no start or completion. The run
 *   may have been spawned just before its runner died, since the start is
 *   recorded after the spawn. Unknown, not failed and not done.
 * - `start-only`: a start and no completion. Custody did not record an end;
 *   its runner may have died before or after the spawned process ended.
 *   Unknown, not failed and not done.
 * - `not-started`: the completion says the run never started.
 * - `exited`: the completion says the spawned process was seen to end without
 *   custody stopping it.
 * - `stopped`: the completion says custody stopped it, by a signal or the
 *   caller's abort.
 * - `custody-error`: the completion says custody failed at something of its
 *   own, or stopped the run because it could not record its start. The
 *   completion still says how the process ended, as far as it was seen.
 * - `unknown`: the records that could be read are not a combination custody
 *   writes, or disagree with each other: no custody record at all, say, or a
 *   start and a completion naming different sessions.
 * - `unreadable`: the directory could not be listed, or the record the state
 *   rests on is there but could not be read as one this reader knows.
 */
export type CustodyState =
  | 'invocation-only'
  | 'start-only'
  | 'not-started'
  | 'exited'
  | 'stopped'
  | 'custody-error'
  | 'unknown'
  | 'unreadable';

/** One file as a reading read it: whole, once, with when the read began and the digest of those bytes. */
export interface CustodyFileRead {
  path: string,
  readAt: string,
  bytes: number,
  sha256: string,
}

/**
 * One of custody's records: `absent`; `read`, a record of the format and
 * version custody writes, with every field as that version writes it; or
 * `unreadable`, with why, and what was read when something was.
 */
export type CustodyRecordReading<T> =
  | { status: 'absent', path: string }
  | { status: 'read', file: CustodyFileRead, record: T }
  | { status: 'unreadable', path: string, file: CustodyFileRead | null, why: string };

/** Size and digest, as a completion recorded them for a file. */
export interface RecordedDigest {
  bytes: number,
  sha256: string,
}

/** One of the spawned process's outputs as read, against what the completion recorded of it. */
export interface CustodyOutputReading {
  path: string,

  /** What was there when read; null when nothing was, or it could not be read (`why`). */
  file: CustodyFileRead | null,
  why: string | null,

  /** What `completion.json` recorded of it; null without a completion, or when it recorded none. */
  atCompletion: RecordedDigest | null,

  /**
   * Whether it now differs from `atCompletion`, gone included; null when
   * there is nothing to compare or it could not be read. A fact about bytes:
   * it does not say who wrote them, or that anything is still writing.
   */
  changedSinceCompletion: boolean | null,
}

/** The spawned process's stdout as read, with who wrote it and what it says as a result. */
export interface CustodyStdoutReading extends CustodyOutputReading {
  /** The launcher and executable `invocation.json` names; null when that record could not be read. */
  writtenBy: { launcher: Launcher, executable: string } | null,

  provenance: typeof stdoutProvenance,

  /**
   * The value of the last `--output-format` in the invocation's `extraArgs`,
   * or null when they hold none; bare-claude passes none of its own. What
   * was asked for, not what was written.
   */
  outputFormat: string | null,

  result: CustodyStdoutResult,
}

/**
 * Whether stdout was read as a `--output-format json` result, and why.
 * `read` when the invocation asked for that format (`json-requested`), and
 * then whatever the bytes are, since an empty or cut-short result is itself
 * a finding (see `ResultReading.file`); or when the bytes are a result though
 * it did not ask, as a launcher that adds the flag itself would make them
 * (`parsed-as-result`). `not-read` otherwise, with why: a run that never
 * started, nothing there to read, or text, which `claude --print` writes by
 * default. Text is not misread as a broken result.
 */
export type CustodyStdoutResult =
  | { status: 'read', basis: 'json-requested' | 'parsed-as-result', reading: ResultReading }
  | { status: 'not-read', why: string };

/**
 * Where the seeded bytes of the journal end, and how that is known:
 * `seeded`, the size and digest `start.json` recorded; `nothing seeded`,
 * which `start.json` recorded; or `fresh session`, for a start written before
 * the seed was recorded (0.12.0) of an invocation that seeded nothing.
 */
export interface CustodyJournalBoundary {
  bytes: number,

  /** The seeded bytes' digest; null when nothing was seeded. */
  sha256: string | null,

  basis: 'seeded' | 'nothing seeded' | 'fresh session',
}

/**
 * The journal's records after its seeded bytes: those appended once the run
 * was spawned, by whatever appended them. A continued session's journal
 * begins with its whole earlier history, and a context-limit or API-error
 * record there is an earlier process's; here it is not counted. Line numbers
 * in `reading` count from the boundary; `lineOffset` is how many line ends
 * the seeded bytes held. `not-read` when the boundary is not known, or the
 * journal no longer begins with the bytes seeded.
 */
export type CustodyAppendedJournal =
  | { status: 'read', boundary: CustodyJournalBoundary, lineOffset: number, reading: JournalReading }
  | { status: 'not-read', why: string };

/**
 * Where custody wrote a directory's records, and whether that is the
 * directory read. `from` is `invocation.directory`, or, in records written
 * before that was recorded, the directory of the outputs the completion
 * names; null `directory` when no record says. `sameAsRead` is false for a
 * directory moved or copied since it was written: a journal under the
 * original directory is then not read, since it would be the original's.
 */
export interface CustodyWrittenIn {
  directory: string | null,
  from: 'invocation.directory' | 'completion outputs' | null,
  sameAsRead: boolean | null,
}

/** The session journal as read, against what the completion recorded of it. */
export interface CustodyJournalReading {
  path: string,
  sessionId: string,

  /** Which record named it: the completion's journal, or, without one, the start. */
  namedBy: 'completion.journal' | 'start.sessionJsonlPath',

  file: CustodyFileRead | null,
  why: string | null,

  /** What `completion.json` recorded of it; null without a completion or a journal in it. */
  atCompletion: { exists: boolean, bytes: number | null, sha256: string | null } | null,

  /**
   * Whether it now differs from `atCompletion`: written since, created
   * since, or gone. Null when there is nothing to compare or it could not be
   * read. Neither value says whether anything still writes it, nor that the
   * session may be continued.
   */
  changedSinceCompletion: boolean | null,

  /** The whole journal, inherited records included; see `appended` for this run's alone. */
  reading: JournalReading | null,

  appended: CustodyAppendedJournal,
}

/** What {@link readCustody} read of one custody directory. See {@link custodyReadingScope}. */
export interface CustodyReading {
  format: 'bare-claude/custody-reading',
  version: typeof custodyReadingVersion,
  scope: typeof custodyReadingScope,

  /** The package that read it. */
  reader: { name: string, version: string },

  directory: string,

  /** When the reading began. */
  read: string,

  state: CustodyState,

  /** Why the state is what it is. */
  basis: string,

  /** Everything that could not be read or did not agree, in the order found. */
  problems: string[],

  /** The directory's entries, sorted, anyone else's files included; null when it could not be listed. */
  entries: string[] | null,

  writtenIn: CustodyWrittenIn,

  invocation: CustodyRecordReading<CustodyInvocation>,
  start: CustodyRecordReading<CustodyStart>,
  completion: CustodyRecordReading<CustodyCompletion>,

  stdout: CustodyStdoutReading,
  stderr: CustodyOutputReading,

  /** Null when no readable record names a journal. */
  journal: CustodyJournalReading | null,

  /**
   * The stdout result joined with the journal, when both were read; see
   * {@link CustodyJoin} for which reading of the journal it is over.
   */
  join: CustodyJoin | null,
}

/**
 * `joinResult` from `@agladysh/bare-claude/outcome` over the stdout result
 * and one reading of the journal, and which: `over` says which `segments`
 * list `segment` and `candidates` index.
 *
 * - `appended`, `journal.appended.reading`, whenever that reading exists:
 *   the records after the verified seeded bytes. An inherited segment, and an
 *   inherited context-limit record, cannot be joined to this run's result. A
 *   fresh session's boundary is 0, so this is the whole journal for it.
 * - `whole`, `journal.reading`, only when there is no verified boundary: a
 *   continued session whose start was written before the seed was recorded
 *   (0.12.0), or a journal that no longer begins with the bytes seeded
 *   (`journal.appended.why` says which). There an earlier process that wrote no `cost-state` record
 *   shares a segment with this run's records, and the joined segment's
 *   `contextLimitRecord` may be that process's.
 *
 * Either way it correlates the result with one segment's recorded figures;
 * it is not process identity, and a segment can span processes after the
 * boundary too. `stdout.result.reading.process` stays the figures of the
 * process that wrote the result, joined or not.
 */
export type CustodyJoin = ResultJournalJoin & { over: 'appended' | 'whole' };

type Guard<T> = (value: unknown) => value is T;

/**
 * A guard for each property of `T`, optional ones included, each guarding
 * `undefined` too: mapped over `Required<T>`, not with `-?`, which would take
 * `undefined` out of an optional property's type.
 */
type Shape<T> = { [K in keyof Required<T>]: Guard<T[K & keyof T]> };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object whose every named property passes its guard; properties it does not name are allowed. */
function shape<T extends object>(fields: Shape<T>): Guard<T> {
  return (value: unknown): value is T => {
    if (!isObject(value)) {
      return false;
    }
    for (const key in fields) {
      if (!fields[key](value[key])) {
        return false;
      }
    }
    return true;
  };
}

function literal<const T extends string | number>(...values: T[]): Guard<T> {
  return (value: unknown): value is T => values.some(known => known === value);
}

function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value: unknown): value is T | null => value === null || guard(value);
}

function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value: unknown): value is T | undefined => value === undefined || guard(value);
}

function either<A, B>(a: Guard<A>, b: Guard<B>): Guard<A | B> {
  return (value: unknown): value is A | B => a(value) || b(value);
}

function listOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every(item => guard(item));
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isLauncher = (value: unknown): value is Launcher => typeof value === 'string' && Object.hasOwn(Launchers, value);
/**
 * Every signal name a record may hold, whatever host wrote it: the whole of
 * `NodeJS.Signals`, not the reading host's `os.constants.signals`, so a
 * completion written on Linux with `SIGPWR` reads on macOS too.
 */
const signalNames = [
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO',
  'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT',
  'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGUNUSED', 'SIGURG',
  'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ', 'SIGBREAK', 'SIGLOST', 'SIGINFO',
] as const satisfies readonly NodeJS.Signals[];

/** Compile-time: `T` must be `never`. */
type AssertNever<T extends never> = T;

/** Fails to compile when `NodeJS.Signals` gains a name {@link signalNames} lacks. */
type _EverySignalIsNamed = AssertNever<Exclude<NodeJS.Signals, typeof signalNames[number]>>;

const isSignalName = (value: unknown): value is NodeJS.Signals => signalNames.some(known => known === value);
const isStopSignal = (value: unknown): value is StopSignal => stopSignals.some(known => known === value);
const isSignalCode = either(isFiniteNumber, isSignalName);

const isFileRecord = shape<ConfigFileRecord>({ path: isString, realPath: nullable(isString), bytes: isCount, sha256: isString });

const isRecordedConfiguration = shape<RecordedConfiguration>({
  scope: literal(configurationScope),
  source: literal('located', 'file', 'files', 'none'),
  files: listOf(isFileRecord),
  use: nullable(listOf(isString)),
  useFrom: nullable(literal('command-line', 'configuration')),
});

const isSession: Guard<CustodySession> = either(
  shape<Extract<CustodySession, { kind: 'fresh' }>>({ kind: literal('fresh') }),
  either(
    shape<Extract<CustodySession, { kind: 'memory' }>>({ kind: literal('memory'), sessionId: isString }),
    shape<Extract<CustodySession, { kind: 'file' }>>({
      kind: literal('file'), sessionId: isString, sourcePath: isString, sourceSha256: nullable(isString),
    }),
  ),
);

const isCustodyInvocation = shape<CustodyInvocation>({
  format: literal('bare-claude/run-invocation'),
  version: literal(custodyVersion),
  recorded: isString,
  package: shape<CustodyInvocation['package']>({ name: isString, version: isString }),
  directory: optional(isString),
  launcher: isLauncher,
  executable: isString,
  model: nullable(isString),
  effortLevel: isString,
  permissionMode: isString,
  tools: nullable(listOf(isString)),
  disallowedTools: nullable(listOf(isString)),
  addDirs: listOf(isString),
  maxBudgetUsd: nullable(isFiniteNumber),
  maxTokens: nullable(isFiniteNumber),
  maxOutputLength: nullable(isFiniteNumber),
  auth: literal('fallback', 'caller', 'native-store'),
  linkAuth: isBoolean,
  noProcessEnv: isBoolean,
  extraArgs: listOf(isString),
  cwd: isString,
  claudeHome: isString,
  session: isSession,
  callToAction: shape<CustodyInvocation['callToAction']>({ bytes: isCount, sha256: isString, kept: nullable(isString) }),
  configuration: optional(nullable(isRecordedConfiguration)),
});

const isCustodyIdentity: Guard<CustodyIdentity> = either(
  shape<{ observed: ProcessIdentity }>({ observed: isProcessIdentity }),
  shape<{ failed: string }>({ failed: isString }),
);

const isCustodyStart = shape<CustodyStart>({
  format: literal('bare-claude/run-start'),
  version: literal(custodyVersion),
  recorded: isString,
  pid: isCount,
  processGroup: nullable(isCount),
  sessionId: isString,
  sessionJsonlPath: isString,
  claudeHome: isString,
  identity: nullable(isCustodyIdentity),
  seededJournal: optional(nullable(shape<{ bytes: number, sha256: string }>({ bytes: isCount, sha256: isString }))),
});

const isGroupState: Guard<ProcessGroupState> = literal('empty', 'occupied', 'not-permitted');
const isGroupObservation = shape<ProcessGroupObservation>({ elapsedMs: isFiniteNumber, state: isGroupState });

const isStopReport = shape<StopReport>({
  signal: isSignalName,
  escalated: isBoolean,
  exitCode: nullable(isFiniteNumber),
  signalCode: nullable(isSignalCode),
  processGroup: nullable(isCount),
  groupState: nullable(isGroupState),
  groupObservations: listOf(isGroupObservation),
});

const isOutput = shape<CustodyOutput>({ file: isString, bytes: isCount, sha256: isString });

const isCustodyCompletion = shape<CustodyCompletion>({
  format: literal('bare-claude/run-completion'),
  version: literal(custodyVersion),
  scope: literal(completionScope),
  ended: isString,
  outcome: literal('not-started', 'exited', 'stopped'),
  notStarted: nullable(isString),
  exitStatus: nullable(isFiniteNumber),
  exitCode: nullable(isFiniteNumber),
  signalCode: nullable(isSignalCode),
  stoppedBy: nullable(isStopSignal),
  stop: nullable(shape<NonNullable<CustodyCompletion['stop']>>({
    cause: either(isStopSignal, literal('cancelled', 'custody-error')),
    report: nullable(isStopReport),
  })),
  processGroupAfter: nullable(shape<ProcessGroupReading>({ state: isGroupState, observations: listOf(isGroupObservation) })),
  custodyError: nullable(isString),
  stdout: nullable(isOutput),
  stderr: nullable(isOutput),
  journal: nullable(shape<CustodyJournal>({
    path: isString, sessionId: isString, exists: isBoolean, bytes: nullable(isCount), sha256: nullable(isString),
  })),
});

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One whole read of a file, or why there was none. */
type WholeRead =
  | { kind: 'read', file: CustodyFileRead, bytes: Uint8Array }
  | { kind: 'absent' }
  | { kind: 'failed', why: string };

/** Reads `file` whole, once; the digest and anything read from it are of those bytes. */
async function readWhole(file: string): Promise<WholeRead> {
  const readAt = new Date().toISOString();
  try {
    const bytes = new Uint8Array(await fs.readFile(file));
    return { kind: 'read', bytes, file: { path: file, readAt, bytes: bytes.length, sha256: digestOf(bytes) } };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'failed', why: messageOf(error) };
  }
}

async function readRecord<T>(file: string, format: string, guard: Guard<T>): Promise<CustodyRecordReading<T>> {
  const got = await readWhole(file);
  switch (got.kind) {
    case 'absent':
      return { status: 'absent', path: file };
    case 'failed':
      return { status: 'unreadable', path: file, file: null, why: got.why };
    case 'read': {
      const unreadable = (why: string): CustodyRecordReading<T> => ({ status: 'unreadable', path: file, file: got.file, why });
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(got.bytes));
      } catch {
        return unreadable('not one JSON document; possibly cut short');
      }
      if (!isObject(parsed) || parsed.format !== format) {
        return unreadable(`not a ${format} record`);
      }
      if (parsed.version !== custodyVersion) {
        return unreadable(`version ${JSON.stringify(parsed.version)}; this reader knows version ${custodyVersion}`);
      }
      if (!guard(parsed)) {
        return unreadable(`a version ${custodyVersion} ${format} record whose fields are not as that version writes them`);
      }
      return { status: 'read', file: got.file, record: parsed };
    }
  }
}

function whyNot(got: WholeRead): string | null {
  switch (got.kind) {
    case 'read':
      return null;
    case 'absent':
      return 'no file at that path';
    case 'failed':
      return got.why;
  }
}

/**
 * One output in the directory, read whole, against what the completion
 * recorded of it. `expected` is where the completion should name it: in the
 * directory the records were written in, which a moved or copied one is not.
 */
async function readOutput(
  file: string,
  expected: string,
  atCompletion: CustodyOutput | null,
  problems: string[],
): Promise<{ reading: CustodyOutputReading, bytes: Uint8Array | null }> {
  const got = await readWhole(file);
  if (got.kind === 'failed') {
    problems.push(`${file}: ${got.why}`);
  }
  if (atCompletion !== null && atCompletion.file !== expected) {
    problems.push(`${custodyFiles.completion} recorded this output at ${atCompletion.file}, not in the directory its records were written in`);
  }
  const recorded = atCompletion === null ? null : { bytes: atCompletion.bytes, sha256: atCompletion.sha256 };
  const now = got.kind === 'read' ? got.file : null;
  return {
    reading: {
      path: file,
      file: now,
      why: whyNot(got),
      atCompletion: recorded,
      changedSinceCompletion: recorded === null || got.kind === 'failed'
        ? null
        : now === null || now.bytes !== recorded.bytes || now.sha256 !== recorded.sha256,
    },
    bytes: got.kind === 'read' ? got.bytes : null,
  };
}

/** The value of the last `--output-format` in `args`, in either of its spellings. */
function outputFormatIn(args: readonly string[]): string | null {
  let format: string | null = null;
  for (const [ index, arg ] of args.entries()) {
    if (arg === '--output-format') {
      format = args[index + 1] ?? null;
    } else if (arg.startsWith('--output-format=')) {
      format = arg.slice('--output-format='.length);
    }
  }
  return format;
}

/** Whether `file` lies inside `directory`, by their paths alone. */
function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Whether two paths resolve to one directory now; false when either cannot be resolved. */
async function samePhysical(a: string, b: string): Promise<boolean> {
  try {
    return await fs.realpath(a) === await fs.realpath(b);
  } catch {
    return false;
  }
}

/** Where the records say they were written, and whether that is the directory read; see {@link CustodyWrittenIn}. */
async function writtenInOf(
  read: string,
  invocation: CustodyInvocation | null,
  completion: CustodyCompletion | null,
): Promise<CustodyWrittenIn> {
  const output = completion?.stdout ?? completion?.stderr ?? null;
  let directory: string;
  let from: CustodyWrittenIn['from'];
  if (invocation?.directory !== undefined) {
    directory = invocation.directory;
    from = 'invocation.directory';
  } else if (output !== null) {
    directory = path.dirname(output.file);
    from = 'completion outputs';
  } else {
    return { directory: null, from: null, sameAsRead: null };
  }
  return { directory, from, sameAsRead: directory === read || await samePhysical(directory, read) };
}

/**
 * Where the journal's seeded bytes end, from `start.json`, or, for a start
 * written before that was recorded, from a fresh invocation; or why the
 * boundary is not known.
 */
function boundaryOf(invocation: CustodyInvocation | null, start: CustodyStart | null): CustodyJournalBoundary | string {
  if (start === null) {
    return `there is no readable ${custodyFiles.start} to say what was seeded before the spawn`;
  }
  const seeded = start.seededJournal;
  if (seeded === null) {
    return { bytes: 0, sha256: null, basis: 'nothing seeded' };
  }
  if (seeded !== undefined) {
    return { bytes: seeded.bytes, sha256: seeded.sha256, basis: 'seeded' };
  }
  if (invocation !== null && invocation.session.kind === 'fresh') {
    return { bytes: 0, sha256: null, basis: 'fresh session' };
  }
  return `${custodyFiles.start} records no seeded bytes (written before 0.13), and the invocation `
    + `${invocation === null ? 'could not be read' : 'continued a session'}: inherited records cannot be told from this run's`;
}

/** The journal's bytes after `boundary`, when they still begin with what was seeded. */
function appendedOf(bytes: Uint8Array, boundary: CustodyJournalBoundary | string): CustodyAppendedJournal {
  if (typeof boundary === 'string') {
    return { status: 'not-read', why: boundary };
  }
  if (bytes.length < boundary.bytes) {
    return { status: 'not-read', why: `the journal holds ${bytes.length} bytes, fewer than the ${boundary.bytes} seeded: it is not the journal as seeded` };
  }
  const seeded = bytes.subarray(0, boundary.bytes);
  if (boundary.sha256 !== null && digestOf(seeded) !== boundary.sha256) {
    return { status: 'not-read', why: `its first ${boundary.bytes} bytes are no longer the bytes seeded, so where this run's records begin is not known` };
  }
  return {
    status: 'read',
    boundary,
    lineOffset: seeded.reduce((lines, byte) => byte === 0x0a ? lines + 1 : lines, 0),
    reading: readJournal(bytes.subarray(boundary.bytes)),
  };
}

/**
 * The journal the completion names, or else the start, read whole, against
 * what the completion recorded, with the records appended after its seeded
 * bytes read apart. One under the original directory of a moved or copied
 * directory is not read: it would be the original's.
 */
async function readSessionJournal(
  invocation: CustodyInvocation | null,
  start: CustodyStart | null,
  completion: CustodyCompletion | null,
  writtenIn: CustodyWrittenIn,
  problems: string[],
): Promise<CustodyJournalReading | null> {
  const recorded = completion?.journal ?? null;
  let named: Pick<CustodyJournalReading, 'path' | 'sessionId' | 'namedBy'>;
  if (recorded !== null) {
    named = { path: recorded.path, sessionId: recorded.sessionId, namedBy: 'completion.journal' };
  } else if (start !== null) {
    named = { path: start.sessionJsonlPath, sessionId: start.sessionId, namedBy: 'start.sessionJsonlPath' };
  } else {
    return null;
  }
  const atCompletion = recorded === null ? null : { exists: recorded.exists, bytes: recorded.bytes, sha256: recorded.sha256 };

  if (writtenIn.sameAsRead === false && writtenIn.directory !== null && isWithin(writtenIn.directory, named.path)) {
    const why = `the journal is under ${writtenIn.directory}, where these records were written, not under the directory read; `
      + 'read there, it would be that directory\'s journal, not this one\'s';
    return { ...named, file: null, why, atCompletion, changedSinceCompletion: null, reading: null, appended: { status: 'not-read', why } };
  }
  if (writtenIn.directory === null) {
    problems.push('the records do not say which directory they were written in (no invocation.directory, and no outputs in a completion); '
      + 'the journal is read where they name it');
  }

  const got = await readWhole(named.path);
  if (got.kind === 'failed') {
    problems.push(`${named.path}: ${got.why}`);
  }
  let changed: boolean | null = null;
  if (recorded !== null && got.kind !== 'failed') {
    changed = got.kind === 'read'
      ? !recorded.exists || got.file.bytes !== recorded.bytes || got.file.sha256 !== recorded.sha256
      : recorded.exists;
  }
  return {
    ...named,
    file: got.kind === 'read' ? got.file : null,
    why: whyNot(got),
    atCompletion,
    changedSinceCompletion: changed,
    reading: got.kind === 'read' ? readJournal(got.bytes) : null,
    appended: got.kind === 'read'
      ? appendedOf(got.bytes, boundaryOf(invocation, start))
      : { status: 'not-read', why: whyNot(got) ?? 'the journal was not read' },
  };
}

/**
 * Whether stdout is read as a result; see {@link CustodyStdoutResult}. A run
 * that never started wrote nothing, so its stdout is never read as one.
 */
function stdoutResultOf(
  bytes: Uint8Array | null,
  unread: string | null,
  outputFormat: string | null,
  completion: CustodyCompletion | null,
): CustodyStdoutResult {
  if (completion !== null && completion.outcome === 'not-started') {
    return { status: 'not-read', why: 'the run never started: no process was spawned to write this stdout' };
  }
  if (bytes === null) {
    return { status: 'not-read', why: unread ?? 'nothing was read' };
  }
  if (outputFormat === 'json') {
    return { status: 'read', basis: 'json-requested', reading: readResult(bytes) };
  }
  const reading = readResult(bytes);
  if (reading.file === 'result') {
    return { status: 'read', basis: 'parsed-as-result', reading };
  }
  return {
    status: 'not-read',
    why: outputFormat === null
      ? 'the invocation asked for no --output-format, and claude --print writes text by default; the bytes are not a result'
      : `the invocation asked for --output-format ${outputFormat}, not json, and the bytes are not one result`,
  };
}

/** Where readable records name the session, journal or home differently, as one run's records never do. */
function disagreements(
  invocation: CustodyInvocation | null,
  start: CustodyStart | null,
  completion: CustodyCompletion | null,
): string[] {
  const found: string[] = [];
  if (start !== null && completion !== null && completion.journal !== null) {
    if (completion.journal.sessionId !== start.sessionId) {
      found.push(`${custodyFiles.start} names session ${start.sessionId}, ${custodyFiles.completion} session ${completion.journal.sessionId}`);
    }
    if (completion.journal.path !== start.sessionJsonlPath) {
      found.push(`${custodyFiles.start} names the journal ${start.sessionJsonlPath}, ${custodyFiles.completion} ${completion.journal.path}`);
    }
  }
  if (invocation !== null && start !== null) {
    if (invocation.session.kind !== 'fresh' && invocation.session.sessionId !== start.sessionId) {
      found.push(`${custodyFiles.invocation} continues session ${invocation.session.sessionId}, ${custodyFiles.start} names session ${start.sessionId}`);
    }
    if (invocation.claudeHome !== start.claudeHome) {
      found.push(`${custodyFiles.invocation} names the Claude home ${invocation.claudeHome}, ${custodyFiles.start} ${start.claudeHome}`);
    }
  }
  return found;
}

/** How the spawned process ended, as a completion says. */
function endOf(completion: CustodyCompletion): string {
  if (completion.signalCode !== null) {
    return `signal ${completion.signalCode}`;
  }
  return completion.exitCode === null ? 'had not been seen to end' : `exit code ${completion.exitCode}`;
}

/** A state and why. */
interface StateBasis {
  state: CustodyState,
  basis: string,
}

/** The state the records rest on, and why; see {@link CustodyState}. */
function stateOf(
  invocation: CustodyRecordReading<CustodyInvocation>,
  start: CustodyRecordReading<CustodyStart>,
  completion: CustodyRecordReading<CustodyCompletion>,
): StateBasis {
  const unreadable = (what: string): StateBasis => ({
    state: 'unreadable',
    basis: `${what} is there but could not be read as a record this reader knows`,
  });

  const disagree = disagreements(
    invocation.status === 'read' ? invocation.record : null,
    start.status === 'read' ? start.record : null,
    completion.status === 'read' ? completion.record : null,
  );
  if (disagree.length > 0) {
    return { state: 'unknown', basis: `the records disagree, as one run's never do: ${disagree.join('; ')}` };
  }

  if (completion.status === 'unreadable') {
    return unreadable(custodyFiles.completion);
  }
  if (completion.status === 'read') {
    const done = completion.record;
    if (done.custodyError !== null || done.stop?.cause === 'custody-error') {
      return {
        state: 'custody-error',
        basis: `custody recorded a failure of its own (${done.custodyError ?? 'it stopped the run because it could not record its start'}); `
          + `its completion says ${done.outcome}${done.outcome === 'not-started' ? '' : `, ${endOf(done)}`}`,
      };
    }
    if (done.outcome === 'not-started') {
      return start.status === 'absent'
        ? { state: 'not-started', basis: `the completion says the run never started: ${done.notStarted ?? 'no reason was recorded'}` }
        : { state: 'unknown', basis: `the completion says the run never started, but ${custodyFiles.start} is there` };
    }
    if (start.status === 'absent') {
      return {
        state: 'unknown',
        basis: `the completion says the spawned process ${done.outcome}, but there is no ${custodyFiles.start}, which custody writes before it waits for an end`,
      };
    }
    if (start.status === 'unreadable') {
      return unreadable(custodyFiles.start);
    }
    // As for a start with no completion: custody writes the invocation before it spawns.
    if (invocation.status === 'absent') {
      return {
        state: 'unknown',
        basis: `the completion says the spawned process ${done.outcome}, but there is no ${custodyFiles.invocation}, which custody writes before it spawns`,
      };
    }
    if (invocation.status === 'unreadable') {
      return unreadable(custodyFiles.invocation);
    }
    return done.outcome === 'exited'
      ? { state: 'exited', basis: `the completion says the spawned process was seen to end without custody stopping it: ${endOf(done)}` }
      : { state: 'stopped', basis: `the completion says custody stopped it (${done.stop?.cause ?? 'no cause was recorded'}); it ${endOf(done)}` };
  }

  if (start.status === 'unreadable') {
    return unreadable(custodyFiles.start);
  }
  if (start.status === 'read') {
    if (invocation.status === 'unreadable') {
      return unreadable(custodyFiles.invocation);
    }
    return invocation.status === 'absent'
      ? { state: 'unknown', basis: `a start with no ${custodyFiles.invocation}, which custody writes before it spawns` }
      : {
        state: 'start-only',
        basis: `a start and no completion: custody did not record an end. Its runner may have died before or after the spawned process ended, and nothing here says which`,
      };
  }

  switch (invocation.status) {
    case 'unreadable':
      return unreadable(custodyFiles.invocation);
    case 'read':
      return {
        state: 'invocation-only',
        basis: 'an invocation and nothing after it: the run may have been spawned just before its runner died, since the start is recorded after the spawn',
      };
    case 'absent':
      return {
        state: 'unknown',
        basis: `no ${custodyFiles.invocation}, start or completion: not a custody directory, or one whose runner ended before writing its invocation`,
      };
  }
}

/**
 * Reads one custody directory as {@link runInCustody} keeps it: its records,
 * the spawned process's stdout and stderr, and the session journal they
 * name, each file read whole and once, every digest of the bytes read. The
 * stdout is read as a result with `readResult` when that is honest (see
 * {@link CustodyStdoutResult}), the journal with `readJournal`, whole and
 * after its seeded bytes, and the two joined with `joinResult`, all from
 * `@agladysh/bare-claude/outcome`. Nothing is written, spawned or signalled,
 * and no PID is looked up: a start-only directory stays unknown here however
 * long ago it was written.
 *
 * Never throws: a directory that cannot be listed, or a record that cannot be
 * read, is itself the finding, in `state`, `basis` and `problems`. What the
 * stdout says is what `invocation.executable` wrote (see
 * {@link stdoutProvenance}); whether that was native Claude Code is not
 * established here, whatever its path or its output look like. The
 * configuration files an invocation names are not read again: what the
 * record says of them is what was stated when it was written.
 * @param directory - The custody directory; relative to the process cwd
 * @returns The reading, versioned by {@link custodyReadingVersion}
 */
export async function readCustody(directory: string): Promise<CustodyReading> {
  const read = new Date().toISOString();
  const absolute = path.resolve(directory);
  const at = (name: string) => path.join(absolute, name);
  const problems: string[] = [];

  let entries: string[] | null = null;
  let unlisted: string | null = null;
  try {
    entries = (await fs.readdir(absolute)).sort();
  } catch (error) {
    unlisted = messageOf(error);
  }

  const invocation = await readRecord(at(custodyFiles.invocation), 'bare-claude/run-invocation', isCustodyInvocation);
  const start = await readRecord(at(custodyFiles.start), 'bare-claude/run-start', isCustodyStart);
  const completion = await readRecord(at(custodyFiles.completion), 'bare-claude/run-completion', isCustodyCompletion);
  for (const record of [ invocation, start, completion ]) {
    if (record.status === 'unreadable') {
      problems.push(`${record.path}: ${record.why}`);
    }
  }
  const invoked = invocation.status === 'read' ? invocation.record : null;
  const started = start.status === 'read' ? start.record : null;
  const done = completion.status === 'read' ? completion.record : null;
  problems.push(...disagreements(invoked, started, done));

  const writtenIn = await writtenInOf(absolute, invoked, done);
  if (writtenIn.sameAsRead === false) {
    problems.push(`these records were written in ${writtenIn.directory ?? 'another directory'}, not the directory read: `
      + 'it was moved or copied, and paths under the original are not read as this one\'s');
  }
  // Where the completion should name an output: in the directory its records were written in.
  const recordedAt = (name: string) => writtenIn.directory === null ? at(name) : path.join(writtenIn.directory, name);

  const out = await readOutput(at(custodyFiles.stdout), recordedAt(custodyFiles.stdout), done?.stdout ?? null, problems);
  const outputFormat = invoked === null ? null : outputFormatIn(invoked.extraArgs);
  const stdout: CustodyStdoutReading = {
    ...out.reading,
    writtenBy: invoked === null ? null : { launcher: invoked.launcher, executable: invoked.executable },
    provenance: stdoutProvenance,
    outputFormat,
    result: stdoutResultOf(out.bytes, out.reading.why, outputFormat, done),
  };
  const stderr = (await readOutput(at(custodyFiles.stderr), recordedAt(custodyFiles.stderr), done?.stderr ?? null, problems)).reading;
  const journal = await readSessionJournal(invoked, started, done, writtenIn, problems);

  // Bindings to this run's session that the state does not rest on: stdout
  // and the journal's contents are not custody's records.
  const resultSession = stdout.result.status === 'read' ? stdout.result.reading.sessionId : null;
  if (started !== null && resultSession !== null && resultSession !== started.sessionId) {
    problems.push(`the stdout result names session ${resultSession}, ${custodyFiles.start} session ${started.sessionId}: it may be another session's result`);
  }
  if (started !== null && journal !== null && journal.appended.status === 'read') {
    const named = journal.appended.reading.sessionIds;
    if (named.length > 0 && !named.includes(started.sessionId)) {
      problems.push(`the records appended to the journal name sessions ${named.join(', ')}, not ${started.sessionId} as ${custodyFiles.start} does`);
    }
  }

  // Over this run's appended records whenever the boundary is verified, so an
  // inherited segment never joins; over the whole journal only without one.
  let join: CustodyJoin | null = null;
  if (stdout.result.status === 'read' && journal !== null) {
    if (journal.appended.status === 'read') {
      join = { ...joinResult(stdout.result.reading, journal.appended.reading), over: 'appended' };
    } else if (journal.reading !== null) {
      join = { ...joinResult(stdout.result.reading, journal.reading), over: 'whole' };
    }
  }

  const unlistable: StateBasis = { state: 'unreadable', basis: `the directory could not be listed: ${unlisted}` };
  const { state, basis } = unlisted === null ? stateOf(invocation, start, completion) : unlistable;

  return {
    format: 'bare-claude/custody-reading',
    version: custodyReadingVersion,
    scope: custodyReadingScope,
    reader: { name: pkg.name, version: pkg.version },
    directory: absolute,
    read,
    state,
    basis,
    problems,
    entries,
    writtenIn,
    invocation,
    start,
    completion,
    stdout,
    stderr,
    journal,
    join,
  };
}

///////////////////////////////////////////////////////////////////////////////
// Briefing a custody reading

/** Version of the briefs {@link briefCustody} returns. It changes when what they mean changes. */
export const custodyBriefVersion = 1;

/** What a brief reports, and the limit of it. */
export const custodyBriefScope = 'one custody reading without its named payload fields (call to action, prompt, result, error and API-error text, stderr, problem text, extraArgs, environment); not redaction. Showing it is not reception of the run\'s return, which is read from its stdout, and says nothing of whether the task was done, delivered, received or accepted';

/** What every `costUsd` in a brief is. */
export const briefCostBasis = 'Claude Code\'s own reported dollar figure: not a bill, and not subscription usage';

/** How a run's custody ended, as its completion records it: classifications and numbers only. */
export interface BriefEnd {
  outcome: CustodyOutcome,
  exitCode: number | null,
  signalCode: number | NodeJS.Signals | null,

  /** What started custody's stop of the run; null when custody stopped nothing. */
  stopCause: CustodyStopCause | null,

  /** Whether custody recorded a failure of its own. What it was stays in the completion. */
  custodyError: boolean,
}

/** What the invocation chose, of what a brief carries. */
export interface BriefRun {
  /** The version of the package that kept the run. */
  packageVersion: string,

  launcher: Launcher,
  model: string | null,
  effortLevel: string,

  /** Its size and digest; never its text. */
  callToAction: RecordedDigest,
}

/**
 * What `spawnClaude` put in the journal before the spawn, as `start.json`
 * recorded it: the size and digest of those bytes; `nothing`; `unrecorded`,
 * by a start written before the seed was recorded (0.12); or `no-start`,
 * with no readable start at all, so no record that anything was seeded:
 * a run that never started, or whose start was never written.
 */
export type BriefSeeded = RecordedDigest | 'nothing' | 'unrecorded' | 'no-start';

/**
 * How the run's session began. `requiredSha256` is the digest a file seed's
 * caller required of its source, which the spawn refuses to seed without;
 * `seeded` the digest of the bytes seeded, which the spawn measured. Lineage
 * rests on these digests alone, and on the required one only where a start
 * shows the spawn happened. A session id is not lineage: a session can be
 * continued from any of its journals, or from bytes no custody kept.
 */
export interface BriefSession {
  /** As the invocation records it; null when the invocation could not be read. */
  kind: CustodySession['kind'] | null,

  /** The start's session, or else the one the invocation continued. */
  sessionId: string | null,

  /** A file seed's source, as the invocation records it. */
  sourcePath: string | null,

  requiredSha256: string | null,
  seeded: BriefSeeded,
}

/**
 * Which digest of a predecessor's journal is the digest of the bytes a run
 * seeded: the one its completion recorded, or that of its journal as read.
 */
export type LineageMatch = 'completion.journal' | 'journal as read';

/**
 * Why no predecessor is named for a run, the last in a chain included:
 *
 * - `fresh`: it continued nothing. A chain ending here is whole.
 * - `not-sought`: no predecessors were given to look among.
 * - `unknown`: the records do not say what was seeded: no readable start,
 *   which is what records that the spawn happened, or a start written by 0.12
 *   with no readable invocation. A digest the invocation required is not
 *   bytes seeded: a run that never started, or was refused its seed, has one.
 * - `no-digest`: it continued a session, but no record holds a digest of the
 *   bytes it seeded: records written by 0.12, a memory seed among them, or a
 *   file seed whose caller required none.
 * - `conflict`: its records disagree about what was seeded: a start's digest
 *   other than the one its invocation required, or a continued session with
 *   nothing seeded.
 * - `ambiguous`: the journals of all the `candidates` have the digest
 *   seeded, for example a directory and a copy of it. None is chosen.
 * - `source-differs`: no journal given has the digest seeded, and the
 *   `candidates` are the runs whose recorded journal path is the file the
 *   invocation names as its source: its completion digest, and its digest
 *   as read when available, differ from the bytes seeded. Paths are compared
 *   as recorded.
 * - `unresolved`: no journal given has the digest seeded. Its predecessor
 *   may simply not be among those given; bytes preloaded into a seed also
 *   make it so, as they change the digest.
 * - `cycle`: the next predecessor, the one candidate, is already in the chain.
 *   Runs that appended nothing to what they seeded can make one.
 */
export type LineageEndStatus =
  | 'fresh'
  | 'not-sought'
  | 'unknown'
  | 'no-digest'
  | 'conflict'
  | 'ambiguous'
  | 'source-differs'
  | 'unresolved'
  | 'cycle';

/** Where a lineage stops. Directories are sorted, and none is a choice among them. */
export interface LineageEnd {
  status: LineageEndStatus,

  /** The directories `ambiguous`, `source-differs` or `cycle` names; otherwise empty. */
  candidates: string[],

  /**
   * Under `no-digest` and `unresolved`, the runs given that share the session
   * id; otherwise empty. A hint, not lineage and not evidence against it: a
   * run's own successors share its session id too.
   */
  sameSession: string[],
}

/**
 * What a run inherited from its predecessor, as the predecessor's journal
 * says when it is, as read, exactly the bytes seeded: its last measured
 * call, whose prompt is what Claude Code reads back as the context size on
 * resume. Otherwise why that is not known.
 */
export type LineageInheritedCall =
  | { status: 'read', prompt: number | null, output: number | null }
  | { status: 'no-measured-call' | 'journal-differs' | 'journal-not-read' };

/** One predecessor: a run whose journal is, by digest, the bytes the run after it seeded. */
export interface LineageLink {
  directory: string,

  /** Every digest of its journal that matched. */
  matchedBy: LineageMatch[],

  state: CustodyState,
  inheritedCall: LineageInheritedCall,

  /** Whether its result or its appended records show a context limit; null when it has neither. */
  contextLimit: boolean | null,

  /** Compactions in its appended records; null when they were not read. */
  compactions: number | null,
}

/** A run's predecessors, nearest first, each established by digest, and where the chain stops. */
export interface BriefLineage {
  links: LineageLink[],
  end: LineageEnd,
}

/** The stdout result as a brief carries it: classifications, never its text or error text. */
export type BriefResult =
  | { status: 'not-read' }
  | {
    status: 'read',
    basis: 'json-requested' | 'parsed-as-result',
    file: ResultFile,

    /** What the result says about itself, from `is_error` alone. */
    resultStatus: ResultStatus,

    /** Null when absent, or not one word (see {@link CustodyBrief}). */
    terminalReason: string | null,
    stopReason: string | null,
    numTurns: number | null,
    apiErrorStatus: number | null,
    contextLimit: ContextLimitEvidence | null,
    sessionId: string | null,
  };

/** This run's appended journal records, counted; never an inherited one. */
export interface BriefAppended {
  segments: number,
  openTail: boolean,
  versions: string[],
  unmeasuredCalls: number,
  apiErrors: number,

  /** API-error records saying the prompt no longer fit. */
  contextLimitErrors: number,

  compactions: number,

  /** Each compaction's `compactMetadata.preTokens`, in order; null where it was not recorded. */
  preTokens: (number | null)[],
}

/**
 * Where a continued session's cumulative totals stood before this run, as
 * the last `cost-state` record in the seeded bytes states them. Whether
 * Claude Code resumes its totals from that record is not established here.
 */
export type BriefInheritedTotals =
  | { status: 'read', costUsd: number | null, apiDurationMs: number | null }
  | { status: 'nothing-seeded' | 'no-cost-state' | 'unknown' };

/** This run's figures, each in its own scope. No figure is compared with any limit. */
export interface BriefMeasured {
  /**
   * This run's last measured API call: the result's last `usage.iterations`
   * entry, or else the last measured call appended to the journal. Its
   * prompt is that one call's.
   */
  lastCall: { prompt: number | null, output: number | null, from: 'result' | 'appended journal' } | null,

  /** The shared window among models that report one; null when none report one or their windows differ. */
  contextWindow: number | null,

  /** The result's sums over this process's calls: no context size. */
  process: { tokens: TokenSums, durationMs: number | null } | null,

  /**
   * The result's session totals, earlier processes of a resumed session
   * included. `models` leaves out any name that is not one word.
   */
  session: { costUsd: number | null, apiDurationMs: number | null, models: string[] } | null,

  inheritedTotals: BriefInheritedTotals,
  costBasis: typeof briefCostBasis,

  /** Null when this run's records cannot be told from inherited ones, or the journal was not read. */
  appended: BriefAppended | null,
}

/** An output by size and digest. Its bytes, the run's return among them, are read from `path`. */
export interface BriefOutput {
  path: string,
  bytes: number | null,
  sha256: string | null,
  changedSinceCompletion: boolean | null,
}

/** The session journal, by what was recorded of it. */
export interface BriefJournal {
  path: string,
  sessionId: string,

  /**
   * As the completion recorded it; null without a completion. It, the path
   * and the session id describe the journal a continuation would seed from
   * only while `changedSinceCompletion` is false.
   */
  atCompletion: { exists: boolean, bytes: number | null, sha256: string | null } | null,

  changedSinceCompletion: boolean | null,

  /** How the end of the seeded bytes is known; null when it is not. */
  boundary: CustodyJournalBoundary['basis'] | null,
}

/**
 * What {@link briefCustody} makes of a reading. See {@link custodyBriefScope}.
 * A native string it carries (terminal and stop reasons, versions, model
 * names, the result's session id) is null, or left out of a list, both when
 * it was not recorded and when it is not one word of printable characters,
 * 128 at most: that keeps native sentences out, and is not redaction.
 */
export interface CustodyBrief {
  format: 'bare-claude/custody-brief',
  version: typeof custodyBriefVersion,
  scope: typeof custodyBriefScope,

  /** The package that read the directory. */
  reader: { name: string, version: string },

  directory: string,

  /** When the reading began. */
  read: string,

  state: CustodyState,

  /** How many problems the reading lists. Their text stays in the reading. */
  problems: number,

  /** Whether the directory read is the one its records were written in; null when no record says. */
  inPlace: boolean | null,

  /** Null when the invocation could not be read. */
  run: BriefRun | null,

  /** Null without a readable completion. */
  end: BriefEnd | null,

  session: BriefSession,
  lineage: BriefLineage,
  result: BriefResult,
  join: { kind: JoinKind, over: CustodyJoin['over'] } | null,
  measured: BriefMeasured,
  stdout: BriefOutput,
  stderr: BriefOutput,
  journal: BriefJournal | null,
}

/**
 * A native identifier, code, version or model name as a brief carries it:
 * one word of printable characters, else null. A result is whatever the
 * spawned executable wrote, and no sentence of it reaches a brief; a single
 * word does, whatever it says.
 */
function word(value: string | null): string | null {
  return value !== null && /^[^\s\p{C}]{1,128}$/u.test(value) ? value : null;
}

function words(values: readonly string[]): string[] {
  return values.flatMap(value => word(value) ?? []);
}

function recordOf<T>(reading: CustodyRecordReading<T>): T | null {
  return reading.status === 'read' ? reading.record : null;
}

function resultOf(reading: CustodyReading): ResultReading | null {
  return reading.stdout.result.status === 'read' ? reading.stdout.result.reading : null;
}

function briefOutput(output: CustodyOutputReading): BriefOutput {
  return {
    path: output.path,
    bytes: output.file?.bytes ?? null,
    sha256: output.file?.sha256 ?? null,
    changedSinceCompletion: output.changedSinceCompletion,
  };
}

function briefResult(result: CustodyStdoutResult): BriefResult {
  if (result.status === 'not-read') {
    return { status: 'not-read' };
  }
  const { reading } = result;
  const limit = reading.contextLimit;
  return {
    status: 'read',
    basis: result.basis,
    file: reading.file,
    resultStatus: reading.status,
    terminalReason: word(reading.terminalReason),
    stopReason: word(reading.stopReason),
    numTurns: reading.numTurns,
    apiErrorStatus: reading.apiErrorStatus,
    contextLimit: limit === null ? null : { terminalReason: limit.terminalReason, text: limit.text },
    sessionId: word(reading.sessionId),
  };
}

/** This run's appended records, when they were read apart from the seeded ones. */
function appendedReadingOf(reading: CustodyReading): Extract<CustodyAppendedJournal, { status: 'read' }> | null {
  const appended = reading.journal === null ? null : reading.journal.appended;
  return appended !== null && appended.status === 'read' ? appended : null;
}

function briefAppended(reading: CustodyReading): BriefAppended | null {
  const appended = appendedReadingOf(reading);
  if (appended === null) {
    return null;
  }
  const { segments, openTail, versions } = appended.reading;
  const errors = segments.flatMap(segment => segment.apiErrors);
  const compactions = segments.flatMap(segment => segment.compactions);
  return {
    segments: segments.length,
    openTail,
    versions: words(versions),
    unmeasuredCalls: segments.reduce((calls, segment) => calls + segment.unmeasuredCalls, 0),
    apiErrors: errors.length,
    contextLimitErrors: errors.filter(error => error.contextLimit).length,
    compactions: compactions.length,
    preTokens: compactions.map(compaction => compaction.preTokens),
  };
}

function lastCallOf(reading: CustodyReading): BriefMeasured['lastCall'] {
  const tokens = resultOf(reading)?.lastCall?.tokens ?? null;
  if (tokens !== null && isMeasuredPrompt(tokens)) {
    return { prompt: tokens.prompt, output: tokens.output, from: 'result' };
  }
  const call = appendedReadingOf(reading)?.reading.lastCall ?? null;
  return call === null ? null : { prompt: call.tokens.prompt, output: call.tokens.output, from: 'appended journal' };
}

/**
 * The last `cost-state` record wholly within the seeded bytes: a line of the
 * whole journal is seeded when the seeded bytes hold its line end.
 */
function inheritedTotalsOf(reading: CustodyReading): BriefInheritedTotals {
  const whole = reading.journal?.reading ?? null;
  const appended = appendedReadingOf(reading);
  if (whole === null || appended === null) {
    return { status: 'unknown' };
  }
  if (appended.boundary.bytes === 0) {
    return { status: 'nothing-seeded' };
  }
  const closed = whole.segments.flatMap(segment =>
    segment.closedBy !== null && segment.closedBy.line <= appended.lineOffset ? [ segment.closedBy ] : []);
  const last = closed.at(-1);
  return last === undefined
    ? { status: 'no-cost-state' }
    : { status: 'read', costUsd: last.costUsd, apiDurationMs: last.apiDurationMs };
}

/** Whether a run's result or appended records show a context limit; null when it has neither to show. */
function contextLimitOf(reading: CustodyReading): boolean | null {
  const result = resultOf(reading);
  const said = result !== null && result.file === 'result' ? result.contextLimit !== null : null;
  const appended = briefAppended(reading);
  if (said === null && appended === null) {
    return null;
  }
  return said === true || (appended?.contextLimitErrors ?? 0) > 0;
}

function seededOf(start: CustodyStart | null): BriefSeeded {
  if (start === null) {
    return 'no-start';
  }
  const seeded = start.seededJournal;
  if (seeded === undefined) {
    return 'unrecorded';
  }
  return seeded === null ? 'nothing' : { bytes: seeded.bytes, sha256: seeded.sha256 };
}

function sessionOfReading(reading: CustodyReading): BriefSession {
  const session = recordOf(reading.invocation)?.session ?? null;
  const start = recordOf(reading.start);
  return {
    kind: session?.kind ?? null,
    sessionId: start?.sessionId ?? (session === null || session.kind === 'fresh' ? null : session.sessionId),
    sourcePath: session?.kind === 'file' ? session.sourcePath : null,
    requiredSha256: session?.kind === 'file' ? session.sourceSha256 : null,
    seeded: seededOf(start),
  };
}

/** Every recorded digest of a run's journal, with what recorded it. */
function journalDigests(reading: CustodyReading): { sha256: string, by: LineageMatch }[] {
  const recorded = reading.journal?.atCompletion ?? null;
  const read = reading.journal?.file ?? null;
  const found: { sha256: string, by: LineageMatch }[] = [];
  if (recorded !== null && recorded.exists && recorded.sha256 !== null) {
    found.push({ sha256: recorded.sha256, by: 'completion.journal' });
  }
  if (read !== null) {
    found.push({ sha256: read.sha256, by: 'journal as read' });
  }
  return found;
}

function inheritedCallFrom(predecessor: CustodyReading, seeded: string): LineageInheritedCall {
  const journal = predecessor.journal;
  if (journal === null || journal.file === null || journal.reading === null) {
    return { status: 'journal-not-read' };
  }
  if (journal.file.sha256 !== seeded) {
    return { status: 'journal-differs' };
  }
  const call = journal.reading.lastCall;
  return call === null ? { status: 'no-measured-call' } : { status: 'read', prompt: call.tokens.prompt, output: call.tokens.output };
}

type Resolution =
  | { kind: 'established', predecessor: CustodyReading, seeded: string, matchedBy: LineageMatch[] }
  | { kind: 'end', end: LineageEnd };

/** A run's predecessor among `predecessors`, by the digest of what it seeded alone, or why there is none. */
function resolvePredecessor(reading: CustodyReading, predecessors: readonly CustodyReading[] | null): Resolution {
  const directories = (runs: readonly CustodyReading[]) => runs.map(run => run.directory).sort();
  const end = (status: LineageEndStatus, candidates: readonly CustodyReading[] = [], sameSession: readonly CustodyReading[] = []): Resolution =>
    ({ kind: 'end', end: { status, candidates: directories(candidates), sameSession: directories(sameSession) } });

  const { kind, sessionId, sourcePath, requiredSha256, seeded } = sessionOfReading(reading);
  if (kind === 'fresh' || (kind === null && seeded === 'nothing')) {
    return typeof seeded === 'string' ? end('fresh') : end('conflict');
  }
  // Only a start records that the spawn happened: without one, a digest the
  // invocation required names bytes nobody is known to have seeded.
  if (seeded === 'no-start' || (kind === null && seeded === 'unrecorded')) {
    return end('unknown');
  }
  if (seeded === 'nothing') {
    return end('conflict');
  }
  const recorded = seeded === 'unrecorded' ? null : seeded.sha256;
  if (recorded !== null && requiredSha256 !== null && recorded !== requiredSha256) {
    return end('conflict');
  }

  const others = predecessors?.filter(candidate => candidate.directory !== reading.directory) ?? null;
  const sharing = (others ?? []).filter(candidate =>
    sessionId !== null && (recordOf(candidate.start)?.sessionId ?? candidate.journal?.sessionId) === sessionId);
  const digest = recorded ?? requiredSha256;
  if (digest === null) {
    return end('no-digest', [], sharing);
  }
  if (others === null) {
    return end('not-sought');
  }

  const matches = others.flatMap(candidate => {
    const matchedBy = journalDigests(candidate).filter(found => found.sha256 === digest).map(found => found.by);
    return matchedBy.length === 0 ? [] : [ { candidate, matchedBy } ];
  });
  const [ only, ...more ] = matches;
  if (only === undefined) {
    const source = sourcePath === null ? [] : others.filter(candidate => candidate.journal?.path === sourcePath);
    return source.length > 0 ? end('source-differs', source) : end('unresolved', [], sharing);
  }
  if (more.length > 0) {
    return end('ambiguous', matches.map(match => match.candidate));
  }
  return { kind: 'established', predecessor: only.candidate, seeded: digest, matchedBy: only.matchedBy };
}

function lineageOf(reading: CustodyReading, predecessors: readonly CustodyReading[] | null): BriefLineage {
  const links: LineageLink[] = [];
  const seen = new Set([ reading.directory ]);
  let current = reading;
  while (true) {
    const next = resolvePredecessor(current, predecessors);
    if (next.kind === 'end') {
      return { links, end: next.end };
    }
    const { predecessor } = next;
    if (seen.has(predecessor.directory)) {
      return { links, end: { status: 'cycle', candidates: [ predecessor.directory ], sameSession: [] } };
    }
    seen.add(predecessor.directory);
    links.push({
      directory: predecessor.directory,
      matchedBy: next.matchedBy,
      state: predecessor.state,
      inheritedCall: inheritedCallFrom(predecessor, next.seeded),
      contextLimit: contextLimitOf(predecessor),
      compactions: briefAppended(predecessor)?.compactions ?? null,
    });
    current = predecessor;
  }
}

/**
 * A compact projection of a custody reading: its state, how its custody
 * ended, how its session began, its measured figures each in its own scope,
 * and the size and digest of each output, the return among them. Pure: it
 * reads nothing but `reading` and `predecessors`, which {@link readCustody}
 * produces. Every field is copied by name, so nothing else attached to a
 * reading passes through.
 *
 * What it leaves out is the point of it: the call to action and the result's
 * text, error and API-error text, stderr, `basis` and `problems` text,
 * `extraArgs`, which may hold secrets, and anything of the environment. That
 * is all it leaves out: it is not redaction for publication. Absolute paths,
 * directory names, session ids, model names, native codes and the call to
 * action's digest, which can confirm a guessed prompt, are carried as
 * recorded. A caller that receives the run's return reads the stdout the brief names,
 * and can hold those bytes to its digest; that a brief was produced or shown
 * says nothing of that reception.
 *
 * Lineage is sought only among `predecessors`, never on disk: a predecessor
 * is a run whose journal, as its completion recorded it or as read, has the
 * digest of the bytes this run seeded, and each link is followed the same
 * way. A session id never makes one (see {@link LineageEndStatus}).
 * @param reading - One custody directory as `readCustody` read it
 * @param predecessors - Readings to look for its lineage among; itself, by
 *   directory, is skipped. Without them, lineage is `not-sought`
 * @returns The brief, versioned by {@link custodyBriefVersion}
 */
export function briefCustody(reading: CustodyReading, predecessors: readonly CustodyReading[] | null = null): CustodyBrief {
  const invocation = recordOf(reading.invocation);
  const completion = recordOf(reading.completion);
  const result = resultOf(reading);
  const journal = reading.journal;
  const distinct = predecessors === null
    ? null
    : [ ...new Map(predecessors.map((candidate): [ string, CustodyReading ] => [ candidate.directory, candidate ])).values() ];
  const sums = result?.process ?? null;
  const session = result?.session ?? null;

  return {
    format: 'bare-claude/custody-brief',
    version: custodyBriefVersion,
    scope: custodyBriefScope,
    reader: { name: reading.reader.name, version: reading.reader.version },
    directory: reading.directory,
    read: reading.read,
    state: reading.state,
    problems: reading.problems.length,
    inPlace: reading.writtenIn.sameAsRead,
    run: invocation === null ? null : {
      packageVersion: invocation.package.version,
      launcher: invocation.launcher,
      model: invocation.model,
      effortLevel: invocation.effortLevel,
      callToAction: { bytes: invocation.callToAction.bytes, sha256: invocation.callToAction.sha256 },
    },
    end: completion === null ? null : {
      outcome: completion.outcome,
      exitCode: completion.exitCode,
      signalCode: completion.signalCode,
      stopCause: completion.stop?.cause ?? null,
      custodyError: completion.custodyError !== null,
    },
    session: sessionOfReading(reading),
    lineage: lineageOf(reading, distinct),
    result: briefResult(reading.stdout.result),
    join: reading.join === null ? null : { kind: reading.join.kind, over: reading.join.over },
    measured: {
      lastCall: lastCallOf(reading),
      contextWindow: session?.contextWindow ?? null,
      process: sums === null ? null : {
        tokens: {
          input: sums.tokens.input,
          cacheCreation: sums.tokens.cacheCreation,
          cacheRead: sums.tokens.cacheRead,
          output: sums.tokens.output,
        },
        durationMs: sums.durationMs,
      },
      session: session === null ? null : {
        costUsd: session.costUsd,
        apiDurationMs: session.apiDurationMs,
        models: words(session.models.map(model => model.model)),
      },
      inheritedTotals: inheritedTotalsOf(reading),
      costBasis: briefCostBasis,
      appended: briefAppended(reading),
    },
    stdout: briefOutput(reading.stdout),
    stderr: briefOutput(reading.stderr),
    journal: journal === null ? null : {
      path: journal.path,
      sessionId: journal.sessionId,
      atCompletion: journal.atCompletion === null ? null : {
        exists: journal.atCompletion.exists,
        bytes: journal.atCompletion.bytes,
        sha256: journal.atCompletion.sha256,
      },
      changedSinceCompletion: journal.changedSinceCompletion,
      boundary: journal.appended.status === 'read' ? journal.appended.boundary.basis : null,
    },
  };
}
