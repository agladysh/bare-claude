/**
 * Reading a finished headless run from what it left: the result object that
 * `claude --print --output-format json` writes when it ends, and the session
 * journal. Pure functions over bytes, plus one batch reader that takes the
 * caller's file reader; nothing here spawns, signals or writes.
 *
 * Nothing here says whether a run's work was done, delivered or worth
 * anything. `no-error` means only that native reported no error.
 *
 * Every figure says which scope it belongs to, because the same field names
 * cover three. Observed 2026-10-16 in retained records written by Claude Code
 * 2.1.292 (doc/sessions/2026-10-16-run-outcome-reading.md):
 *
 * - The last entry of `usage.iterations` is read as the last API call of the
 *   process, and its input plus cache counts as the prompt that call sent.
 *   Every retained result held exactly one entry; what several would mean is
 *   not established.
 * - The rest of `usage`, and `duration_ms`, are the process's own, summed over
 *   its calls. A sum of cache reads over many calls is not a context size.
 * - `total_cost_usd`, `duration_api_ms` and `modelUsage` are the session's,
 *   earlier processes of a resumed session included. They equalled the totals
 *   of the journal's `cost-state` record written at the same process end.
 *   Its costs are Claude Code's own figures, not billing or subscription usage.
 * - `subtype` was `"success"` on every error result read; it is carried
 *   verbatim and never read as an outcome, with one exception: the
 *   {@link SchemaOutcome} of a run given an output schema (see there).
 *   `is_error` and `terminal_reason` are read; `stop_reason` and
 *   `safety_stops` are carried verbatim.
 * - The native version is on journal record envelopes (`version`). Neither
 *   the result nor a `cost-state` record carries one, and a `cost-state`
 *   record has no `uuid` or `timestamp` either.
 */

import { createHash } from 'node:crypto';

import type { Json } from '@agladysh/bare-claude';

import { syntheticModel } from './events.ts';

/** What Claude Code says, in a result and in its journal, when the prompt no longer fits. */
export const contextLimitText = 'Prompt is too long';

/** The `terminal_reason` of a result that ended on the context limit. */
export const contextLimitTerminalReason = 'blocking_limit';

/** Scope of {@link ResultReading.process}. */
export const processScope = 'this process, summed over its API calls; not a context size';

/** Scope of {@link ResultReading.session} and of `cost-state` totals. */
export const sessionScope = 'the session, earlier processes of a resumed session included';

/** Longest native text carried into a reading. */
const textLimit = 200;
/** Longest native identifier, code or version carried into a reading. */
const idLimit = 64;
/** Most record keys listed for a compaction record. */
const keyLimit = 32;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function listOf(v: unknown): readonly unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bounded(v: unknown, limit = textLimit): string | null {
  return typeof v === 'string' ? v.slice(0, limit) : null;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrows a parsed value to {@link Json}; anything `JSON.parse` returns is. */
function isJson(v: unknown): v is Json {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') {
    return true;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v);
  }
  if (Array.isArray(v)) {
    return v.every(isJson);
  }
  return isRecord(v) && Object.values(v).every(isJson);
}

/**
 * The `subtype` of a result whose run never produced an answer that passed
 * its schema. Read from the claude 2.1.328 bundle on 2026-11-22, not
 * observed in a run: its result-message schema lists it among the error
 * subtypes, and the code that ends such a run writes it with `is_error: true`
 * and `errors`.
 */
export const structuredOutputRetriesSubtype = 'error_max_structured_output_retries';

/** The `terminal_reason` the same 2.1.328 code writes beside {@link structuredOutputRetriesSubtype}. Read from the bundle, not observed. */
export const structuredOutputRetriesTerminalReason = 'structured_output_retry_exhausted';

/**
 * Who checked an answer against its schema: `native`, the harness itself,
 * which Bare Claude always is (`claude --json-schema`); or `wrapper`, a
 * wrapper's own JSON Schema validator after the fact, for a sibling wrapper
 * whose harness enforces nothing. The two share {@link SchemaOutcome}.
 */
export type SchemaEnforcer = 'native' | 'wrapper';

/** One error of a JSON Schema validator, as a wrapper that validates itself reports it. */
export interface SchemaValidationError {
  instancePath: string,
  keyword: string,
  message: string,
}

/**
 * Why a run given a schema has no final message to judge: `no-result`,
 * nothing was written where the result should be, or nothing there was read
 * as a result; `unreadable-result`, bytes that are not a result object; or
 * `no-structured-output`, a result without `structured_output`, which neither
 * says the schema was met nor that native gave up on it.
 */
export type NoFinalMessageReason = 'no-result' | 'unreadable-result' | 'no-structured-output';

/**
 * How a run given an output schema answered, as the enforcer reported it:
 *
 * - `conforming`: the result carries `structured_output`, the answer the
 *   enforcer accepted, as `value`.
 * - `not-conforming`: the enforcer gave up on the schema. `errors` is what
 *   it said, verbatim: native's `errors` strings, or a validator's errors.
 *   `finalText` is the result's text, if it has any.
 * - `no-final-message`: neither, with a reason code and a detail.
 *
 * Nothing here reads or judges the answer's content beyond what the enforcer
 * reported about the schema, and `conforming` is not a judgment that the
 * work was done, nor that native reported no error: that is the result's
 * `status`.
 *
 * Bare Claude reads native's report from the `--output-format json` result.
 * `conforming` when it carries a non-null `structured_output` (observed
 * 2026-11-22 on claude 2.1.328: `is_error: false`, subtype `success`, the
 * parsed value, and `result` the same value as JSON text). `not-conforming`
 * when it says `is_error: true` with subtype
 * {@link structuredOutputRetriesSubtype} or terminal reason
 * {@link structuredOutputRetriesTerminalReason}: the one place a subtype is
 * read, since it may be the only discriminator. That shape is read from the
 * 2.1.328 bundle; no such run has been observed.
 */
export type SchemaOutcome =
  | { kind: 'conforming', enforcedBy: SchemaEnforcer, value: Json }
  | { kind: 'not-conforming', enforcedBy: 'native', errors: string[], finalText: string | null }
  | { kind: 'not-conforming', enforcedBy: 'wrapper', errors: SchemaValidationError[], finalText: string | null }
  | { kind: 'no-final-message', enforcedBy: SchemaEnforcer, reason: NoFinalMessageReason, detail: string };

/**
 * The {@link SchemaOutcome} of a run given a schema whose result was never
 * read: stdout not asked for as `--output-format json`, a run that never
 * started, a file that is not there.
 * @param detail - Why there is no result to read
 */
export function noResultSchemaOutcome(detail: string): SchemaOutcome {
  return { kind: 'no-final-message', enforcedBy: 'native', reason: 'no-result', detail };
}

/** The schema outcome of a parsed result object. */
function schemaOutcomeOf(parsed: Record<string, unknown>): SchemaOutcome {
  const subtype = bounded(parsed.subtype, idLimit);
  const terminalReason = bounded(parsed.terminal_reason, idLimit);
  if (parsed.is_error === true
    && (subtype === structuredOutputRetriesSubtype || terminalReason === structuredOutputRetriesTerminalReason)) {
    return {
      kind: 'not-conforming',
      enforcedBy: 'native',
      errors: (listOf(parsed.errors) ?? []).flatMap(e => typeof e === 'string' ? [ e ] : []),
      finalText: typeof parsed.result === 'string' ? parsed.result : null,
    };
  }
  const value = parsed.structured_output;
  if (value !== undefined && value !== null && isJson(value)) {
    return { kind: 'conforming', enforcedBy: 'native', value };
  }
  const said = `is_error ${JSON.stringify(parsed.is_error ?? null)}, subtype ${JSON.stringify(subtype)}, terminal_reason ${JSON.stringify(terminalReason)}`;
  return {
    kind: 'no-final-message',
    enforcedBy: 'native',
    reason: 'no-structured-output',
    detail: value === null
      ? `the result's structured_output is null (${said})`
      : `the result carries no structured_output (${said})`,
  };
}

/**
 * Token counts as Claude Code recorded them for one API call.
 * A count that was not recorded or was invalid is null, never zero.
 */
export interface CallTokens {
  input: number | null,
  cacheCreation: number | null,
  cacheRead: number | null,
  output: number | null,

  /**
   * `input + cacheCreation + cacheRead` when all three were recorded, else
   * null. This is the prompt of one call.
   */
  prompt: number | null,
}

/** Token counts summed over a process's calls. No prompt: a sum of prompts measures none. */
export type TokenSums = Omit<CallTokens, 'prompt'>;

/** Reads a `usage` object's token counts, or null when it is not an object. */
export function callTokens(usage: unknown): CallTokens | null {
  if (!isRecord(usage)) {
    return null;
  }
  const input = count(usage.input_tokens);
  const cacheCreation = count(usage.cache_creation_input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  return {
    input,
    cacheCreation,
    cacheRead,
    output: count(usage.output_tokens),
    prompt: input === null || cacheCreation === null || cacheRead === null ? null : input + cacheCreation + cacheRead,
  };
}

/**
 * Whether counts are a prompt measurement. Claude Code takes a zero
 * input-plus-cache total as "no measurement" when it reads usage back on
 * resume (CLAUDE.md, measured on 2.1.220); a count that is missing is not a
 * measurement here either.
 */
export function isMeasuredPrompt(tokens: CallTokens | null): boolean {
  return tokens !== null && tokens.prompt !== null && tokens.prompt > 0;
}

/** What the bytes were. */
export type ResultFile = 'result' | 'empty' | 'unreadable' | 'not-a-result';

/**
 * What the result says about itself, from `is_error` alone. `no-error` is not
 * completion, delivery or success of the work.
 */
export type ResultStatus = 'no-error' | 'error' | 'unstated';

/** Which part of an error result said the context limit was hit. */
export interface ContextLimitEvidence {
  /** `terminal_reason` is `blocking_limit`. */
  terminalReason: boolean,

  /** The error text is exactly `Prompt is too long`. */
  text: boolean,
}

/** The last API call of the process, from `usage.iterations`. */
export interface LastCall {
  tokens: CallTokens,
  source: 'usage.iterations[last]',

  /** How many entries `usage.iterations` held. */
  entries: number,
}

/** One model's session totals from `modelUsage`; a field that was not recorded is null. */
export interface ModelTotals {
  model: string,
  input: number | null,
  output: number | null,
  cacheRead: number | null,
  cacheCreation: number | null,
  costUsd: number | null,

  /** The context window the result reports for this model. */
  contextWindow: number | null,
}

/**
 * What a result file says, each figure with its scope. It never says the
 * process has ended or what became of the work: a result is what native
 * wrote, not a process fact.
 */
export interface ResultReading {
  bytes: number,

  /** Digest of exactly the bytes read; null for an empty file. */
  sha256: string | null,

  file: ResultFile,

  /** Why the file is not a readable result, or null. */
  why: string | null,

  status: ResultStatus,

  /** Verbatim. `"success"` appears on error results; never read as an outcome. */
  subtype: string | null,

  terminalReason: string | null,

  /** Verbatim `stop_reason`; not interpreted. */
  stopReason: string | null,

  /** Verbatim `safety_stops`; not interpreted. */
  safetyStops: number | null,

  apiErrorStatus: number | null,

  /** The result text of an error result, bounded; never the output of a result without error. */
  errorText: string | null,

  sessionId: string | null,
  uuid: string | null,

  /** As native reports it; whether it counts earlier processes is not established. */
  numTurns: number | null,

  /** Non-null only for an error result, with what said so. */
  contextLimit: ContextLimitEvidence | null,

  lastCall: LastCall | null,

  /** Why there is no last call, or null. */
  lastCallMissing: string | null,

  /** This process's sums and wall time. */
  process: { tokens: TokenSums, durationMs: number | null, scope: string } | null,

  /** The session's cumulative totals. */
  session: {
    costUsd: number | null,
    apiDurationMs: number | null,
    models: ModelTotals[],

    /** The shared window among models that report one; null when none report one or their windows differ. */
    contextWindow: number | null,
    scope: string,
  } | null,

  /**
   * How the run's answer fared against its output schema. Present only when
   * the reader was told the run had one ({@link ResultOptions.outputSchema});
   * absent otherwise, since a result without `structured_output` cannot say
   * whether a schema was given.
   */
  schema?: SchemaOutcome,
}

/** What the reader of a result is told about the run that wrote it. */
export interface ResultOptions {
  /** The run was given an output schema (`outputSchemaFile`); read its {@link SchemaOutcome}. */
  outputSchema?: boolean,
}

function lastCallOf(usage: unknown): { lastCall: LastCall | null, missing: string | null } {
  if (!isRecord(usage)) {
    return { lastCall: null, missing: 'the result has no usage' };
  }
  const entries = listOf(usage.iterations);
  if (entries === null) {
    return { lastCall: null, missing: 'usage has no iterations' };
  }
  const last = entries.at(-1);
  if (last === undefined) {
    return { lastCall: null, missing: 'usage.iterations is empty: no API call recorded' };
  }
  const tokens = callTokens(last);
  if (tokens === null) {
    return { lastCall: null, missing: 'the last usage.iterations entry is not an object' };
  }
  return { lastCall: { tokens, source: 'usage.iterations[last]', entries: entries.length }, missing: null };
}

function modelTotals(v: unknown): ModelTotals[] {
  if (!isRecord(v)) {
    return [];
  }
  const out: ModelTotals[] = [];
  for (const [ model, m ] of Object.entries(v)) {
    if (isRecord(m)) {
      out.push({
        model,
        input: count(m.inputTokens),
        output: count(m.outputTokens),
        cacheRead: count(m.cacheReadInputTokens),
        cacheCreation: count(m.cacheCreationInputTokens),
        costUsd: finite(m.costUSD),
        contextWindow: count(m.contextWindow),
      });
    }
  }
  return out;
}

/**
 * Reads the bytes `claude --print --output-format json` wrote. Never throws:
 * an empty, cut-short or foreign file is itself a finding, with the digest of
 * what was there.
 * @param bytes - The result file's bytes
 * @param options - What the reader knows of the run; with `outputSchema`,
 *   the reading carries `schema`, a `no-final-message` one when the bytes are
 *   no result
 */
export function readResult(bytes: Uint8Array, options: ResultOptions = {}): ResultReading {
  const read = readResultFile(bytes);
  if (options.outputSchema !== true) {
    return read.reading;
  }
  const schema: SchemaOutcome = read.parsed !== null
    ? schemaOutcomeOf(read.parsed)
    : {
      kind: 'no-final-message',
      enforcedBy: 'native',
      reason: read.reading.file === 'empty' ? 'no-result' : 'unreadable-result',
      detail: read.reading.why ?? 'the bytes are not a result',
    };
  return { ...read.reading, schema };
}

function readResultFile(bytes: Uint8Array): { reading: ResultReading, parsed: Record<string, unknown> | null } {
  const finding = (reading: ResultReading) => ({ reading, parsed: null });
  const reading: ResultReading = {
    bytes: bytes.length,
    sha256: bytes.length === 0 ? null : sha256(bytes),
    file: 'result',
    why: null,
    status: 'unstated',
    subtype: null,
    terminalReason: null,
    stopReason: null,
    safetyStops: null,
    apiErrorStatus: null,
    errorText: null,
    sessionId: null,
    uuid: null,
    numTurns: null,
    contextLimit: null,
    lastCall: null,
    lastCallMissing: null,
    process: null,
    session: null,
  };

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return finding({ ...reading, file: 'unreadable', why: 'not UTF-8 text' });
  }
  if (text.trim() === '') {
    return finding({ ...reading, file: 'empty', why: 'nothing but whitespace was written' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return finding({ ...reading, file: 'unreadable', why: 'not one JSON document; possibly cut short' });
  }
  if (!isRecord(parsed) || parsed.type !== 'result') {
    return finding({ ...reading, file: 'not-a-result', why: 'not a Claude Code result object' });
  }

  const status: ResultStatus = parsed.is_error === true ? 'error' : parsed.is_error === false ? 'no-error' : 'unstated';
  const terminalReason = bounded(parsed.terminal_reason, idLimit);
  const errorText = status === 'error' ? bounded(parsed.result) : null;
  const byReason = status === 'error' && terminalReason === contextLimitTerminalReason;
  const byText = errorText !== null && errorText.trim() === contextLimitText;
  const { lastCall, missing } = lastCallOf(parsed.usage);
  const processTokens = callTokens(parsed.usage);
  const models = modelTotals(parsed.modelUsage);
  const windows = [ ...new Set(models.flatMap(m => m.contextWindow === null ? [] : [ m.contextWindow ])) ];

  const result: ResultReading = {
    ...reading,
    status,
    subtype: bounded(parsed.subtype, idLimit),
    terminalReason,
    stopReason: bounded(parsed.stop_reason, idLimit),
    safetyStops: finite(parsed.safety_stops),
    apiErrorStatus: finite(parsed.api_error_status),
    errorText,
    sessionId: bounded(parsed.session_id, idLimit),
    uuid: bounded(parsed.uuid, idLimit),
    numTurns: finite(parsed.num_turns),
    contextLimit: byReason || byText ? { terminalReason: byReason, text: byText } : null,
    lastCall,
    lastCallMissing: missing,
    process: processTokens === null ? null : { tokens: { input: processTokens.input, cacheCreation: processTokens.cacheCreation, cacheRead: processTokens.cacheRead, output: processTokens.output }, durationMs: finite(parsed.duration_ms), scope: processScope },
    session: {
      costUsd: finite(parsed.total_cost_usd),
      apiDurationMs: finite(parsed.duration_api_ms),
      models,
      contextWindow: windows.length === 1 ? windows[0] ?? null : null,
      scope: sessionScope,
    },
  };
  return { reading: result, parsed };
}

/** Where in a journal a record is. */
export interface JournalPlace {
  /** 1-based line. */
  line: number,
  uuid: string | null,
  timestamp: string | null,
}

/** A measured API call in the journal. */
export interface JournalCall extends JournalPlace {
  /** The native version on the record's envelope. */
  version: string | null,
  model: string | null,

  /** Verbatim `message.stop_reason`; not interpreted. */
  stopReason: string | null,

  tokens: CallTokens,
}

/** An API error Claude Code wrote into the journal as an assistant record. */
export interface JournalApiError extends JournalPlace {
  version: string | null,
  error: string | null,
  text: string | null,

  /** The text is exactly `Prompt is too long`. */
  contextLimit: boolean,
}

/**
 * A `compact_boundary` record. Its fields are not established from retained
 * records, so only its keys are listed, and `compactMetadata.preTokens` is
 * read when present.
 */
export interface JournalCompaction extends JournalPlace {
  version: string | null,
  keys: string[],
  preTokens: number | null,
}

/** A `cost-state` record: the session's cumulative totals at the moment it was written. */
export interface CostStateRecord {
  line: number,
  sessionId: string | null,
  costUsd: number | null,
  apiDurationMs: number | null,
}

/**
 * The records after one `cost-state` record, up to and including the next.
 * Not a process: a process that wrote no `cost-state` record (a crash, a kill)
 * has its records here together with the next process's.
 */
export interface JournalSegment {
  /** The `cost-state` record that closed it; null for records after the last one. */
  closedBy: CostStateRecord | null,

  /** Records in it, the closing `cost-state` record excluded. */
  records: number,

  sessionIds: string[],

  /** Native versions on its records' envelopes, in order of first appearance. */
  versions: string[],

  firstTimestamp: string | null,
  lastTimestamp: string | null,

  /** Its last call with a measured prompt ({@link isMeasuredPrompt}); synthetic records are skipped. */
  lastCall: JournalCall | null,

  /** Assistant records, not synthetic and not API errors, whose usage was not a measurement. */
  unmeasuredCalls: number,

  apiErrors: JournalApiError[],
  compactions: JournalCompaction[],
}

/** What a session journal says about context, by cost-state segment. */
export interface JournalReading {
  bytes: number,
  sha256: string,

  /** Non-empty lines. */
  lines: number,

  /** Lines that were not one JSON object. */
  unparsed: number,

  sessionIds: string[],
  versions: string[],
  segments: JournalSegment[],

  /** Records follow the last `cost-state` record: still running, stopped or crashed, which the journal cannot tell. */
  openTail: boolean,

  /** The journal's last measured call: what Claude Code reads back as the context size on resume. */
  lastCall: JournalCall | null,
}

interface SegmentBuilder {
  records: number,
  sessionIds: Set<string>,
  versions: Set<string>,
  firstTimestamp: string | null,
  lastTimestamp: string | null,
  lastCall: JournalCall | null,
  unmeasuredCalls: number,
  apiErrors: JournalApiError[],
  compactions: JournalCompaction[],
}

function newSegment(): SegmentBuilder {
  return {
    records: 0,
    sessionIds: new Set(),
    versions: new Set(),
    firstTimestamp: null,
    lastTimestamp: null,
    lastCall: null,
    unmeasuredCalls: 0,
    apiErrors: [],
    compactions: [],
  };
}

function closeSegment(s: SegmentBuilder, closedBy: CostStateRecord | null): JournalSegment {
  return {
    closedBy,
    records: s.records,
    sessionIds: [ ...s.sessionIds ],
    versions: [ ...s.versions ],
    firstTimestamp: s.firstTimestamp,
    lastTimestamp: s.lastTimestamp,
    lastCall: s.lastCall,
    unmeasuredCalls: s.unmeasuredCalls,
    apiErrors: s.apiErrors,
    compactions: s.compactions,
  };
}

function parseObject(row: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(row);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  for (const block of listOf(content) ?? []) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

/** Reads a session journal's context measurements, API errors and compactions. Never throws. */
export function readJournal(bytes: Uint8Array): JournalReading {
  const segments: JournalSegment[] = [];
  const sessionIds = new Set<string>();
  const versions = new Set<string>();
  let current = newSegment();
  let lastCall: JournalCall | null = null;
  let lines = 0;
  let unparsed = 0;

  for (const [ index, row ] of new TextDecoder().decode(bytes).split('\n').entries()) {
    if (row.trim() === '') {
      continue;
    }
    lines += 1;
    const record = parseObject(row);
    if (record === null) {
      unparsed += 1;
      continue;
    }
    const line = index + 1;

    if (record.type === 'cost-state') {
      const closedBy: CostStateRecord = {
        line,
        sessionId: bounded(record.sessionId, idLimit),
        costUsd: finite(record.totalCostUSD),
        apiDurationMs: finite(record.totalAPIDuration),
      };
      if (closedBy.sessionId !== null) {
        sessionIds.add(closedBy.sessionId);
      }
      segments.push(closeSegment(current, closedBy));
      current = newSegment();
      continue;
    }

    current.records += 1;
    const sessionId = bounded(record.sessionId, idLimit);
    if (sessionId !== null) {
      current.sessionIds.add(sessionId);
      sessionIds.add(sessionId);
    }
    const version = bounded(record.version, idLimit);
    if (version !== null) {
      current.versions.add(version);
      versions.add(version);
    }
    const timestamp = bounded(record.timestamp, idLimit);
    if (timestamp !== null) {
      current.firstTimestamp ??= timestamp;
      current.lastTimestamp = timestamp;
    }
    const where: JournalPlace = { line, uuid: bounded(record.uuid, idLimit), timestamp };

    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const metadata = record.compactMetadata;
      current.compactions.push({
        ...where,
        version,
        keys: Object.keys(record).sort().slice(0, keyLimit),
        preTokens: isRecord(metadata) ? count(metadata.preTokens) : null,
      });
      continue;
    }

    const message = record.message;
    if (record.type !== 'assistant' || !isRecord(message)) {
      continue;
    }
    if (record.isApiErrorMessage === true) {
      const said = firstText(message.content);
      current.apiErrors.push({
        ...where,
        version,
        error: bounded(record.error, idLimit),
        text: said === null ? null : said.slice(0, textLimit),
        contextLimit: said !== null && said.trim() === contextLimitText,
      });
      continue;
    }
    if (message.model === syntheticModel) {
      continue;
    }
    const tokens = callTokens(message.usage);
    if (tokens === null || !isMeasuredPrompt(tokens)) {
      current.unmeasuredCalls += 1;
      continue;
    }
    lastCall = {
      ...where,
      version,
      model: bounded(message.model, idLimit),
      stopReason: bounded(message.stop_reason, idLimit),
      tokens,
    };
    current.lastCall = lastCall;
  }

  if (current.records > 0) {
    segments.push(closeSegment(current, null));
  }
  const last = segments.at(-1);
  return {
    bytes: bytes.length,
    sha256: sha256(bytes),
    lines,
    unparsed,
    sessionIds: [ ...sessionIds ],
    versions: [ ...versions ],
    segments,
    openTail: last !== undefined && last.closedBy === null,
    lastCall,
  };
}

/** How a result relates to a journal's cost-state segments. */
export type JoinKind = 'joined' | 'no-match' | 'ambiguous' | 'disagrees' | 'not-comparable';

/** Which cost-state segment's closing record states a result's session and totals, and on what basis. */
export interface ResultJournalJoin {
  kind: JoinKind,

  /** The joined segment's index; set only when `kind` is `joined`. */
  segment: number | null,

  /** Every segment whose closing record states the result's session and totals. */
  candidates: number[],

  basis: string,

  /** Whether their measured last-call prompt token totals are equal; null when not compared. This compares counts, not prompt contents or call identity. */
  lastCallPromptTokensAgree: boolean | null,

  /** uuid of the joined segment's `Prompt is too long` record, when it has one. Segments can span processes, so this alone does not attribute that error to the result's process. */
  contextLimitRecord: string | null,

  /** The joined segment's native versions. */
  versions: string[],
}

/**
 * Correlates a result with a cost-state segment on the recorded fields.
 * Neither record format supplies an invocation identifier; this is not proof of process identity.
 * Exactly one `cost-state` record must name the result's session and state
 * its `total_cost_usd` and `duration_api_ms`. Several such records (a process
 * that spent nothing repeats the totals before it) are `ambiguous`, with every
 * candidate listed and none chosen. A measured last call whose prompt token
 * total differs from the segment's is `disagrees`, not a join. Totals alone never join: both the
 * result and the segment need a measured last call.
 */
export function joinResult(result: ResultReading, journal: JournalReading): ResultJournalJoin {
  const refuse = (kind: JoinKind, basis: string, candidates: number[] = []): ResultJournalJoin =>
    ({ kind, segment: null, candidates, basis, lastCallPromptTokensAgree: null, contextLimitRecord: null, versions: [] });

  if (result.file !== 'result') {
    return refuse('not-comparable', 'the result file holds no readable result');
  }
  const session = result.sessionId;
  if (session === null) {
    return refuse('not-comparable', 'the result names no session');
  }
  const cost = result.session?.costUsd ?? null;
  const api = result.session?.apiDurationMs ?? null;
  if (cost === null || api === null) {
    return refuse('not-comparable', 'the result states no session cost and API duration to match');
  }
  if (!journal.sessionIds.includes(session)) {
    return refuse('no-match', 'the journal never names the result\'s session');
  }

  const candidates = journal.segments.flatMap((s, i) =>
    s.closedBy !== null && s.closedBy.sessionId === session && s.closedBy.costUsd === cost && s.closedBy.apiDurationMs === api
      ? [ i ]
      : []);
  const index = candidates[0];
  if (index === undefined) {
    return refuse('no-match', 'no cost-state record of the result\'s session states its session cost and API duration');
  }
  if (candidates.length > 1) {
    return refuse('ambiguous', 'more than one cost-state record of the result\'s session states its totals; none is chosen', candidates);
  }
  const segment = journal.segments[index];
  if (segment === undefined) {
    return refuse('no-match', 'the matched segment is missing', candidates);
  }

  const resultPrompt = result.lastCall?.tokens.prompt ?? null;
  const segmentPrompt = segment.lastCall?.tokens.prompt ?? null;
  if (!isMeasuredPrompt(result.lastCall?.tokens ?? null) || !isMeasuredPrompt(segment.lastCall?.tokens ?? null)) {
    return refuse('not-comparable', 'only the totals match: a process that spent nothing states the same totals as the one before it, and a journal copy seeded before it holds no record of it', candidates);
  }
  if (resultPrompt !== segmentPrompt) {
    return { ...refuse('disagrees', 'the cost-state record states the result\'s totals, but the measured last-call prompt token totals differ', candidates), lastCallPromptTokensAgree: false };
  }

  const limit = segment.apiErrors.find(e => e.contextLimit);
  return {
    kind: 'joined',
    segment: index,
    candidates,
    basis: 'exactly one cost-state record matches the session and cumulative totals, and the measured last-call prompt token totals agree; this is correlation, not process identity',
    lastCallPromptTokensAgree: true,
    contextLimitRecord: limit?.uuid ?? null,
    versions: segment.versions,
  };
}

/** A result, a journal, or both, read together. */
export interface OutcomeReading {
  result: ResultReading | null,
  journal: JournalReading | null,
  join: ResultJournalJoin | null,
}

/** Puts readings together, joining them when both are present. */
export function readOutcome(result: ResultReading | null, journal: JournalReading | null): OutcomeReading {
  return { result, journal, join: result !== null && journal !== null ? joinResult(result, journal) : null };
}

/** One request of a batch: files to read, by the caller's own paths. */
export interface OutcomeRequest {
  /** Echoed back so the caller can match an entry to its request. */
  id: string | null,
  result: string | null,
  journal: string | null,

  /** The run was given an output schema: the result's reading carries `schema`. Absent means false. */
  outputSchema?: boolean,
}

/**
 * One batch request naming a run's custody directory, which `readCustody`
 * from `@agladysh/bare-claude/custody` reads; the directory names its own
 * result and journal.
 */
export interface CustodyRequest {
  /** Echoed back so the caller can match an entry to its request. */
  id: string | null,
  custody: string,
}

/** One batch entry: a reading, or why there is none. */
export interface OutcomeEntry {
  id: string | null,
  reading: OutcomeReading | null,
  error: string | null,
}

/**
 * Reads one batch request from a line of JSON:
 * `{ "id"?: string, "result"?: string, "journal"?: string, "outputSchema"?: boolean }`,
 * with at least one of `result` and `journal`, or
 * `{ "id"?: string, "custody": string }`, whose invocation record says
 * itself whether the run had an output schema. Returns the request, or why
 * it is not one.
 */
export function parseOutcomeRequest(line: string): OutcomeRequest | CustodyRequest | string {
  const parsed = parseObject(line);
  if (parsed === null) {
    return 'not one JSON object';
  }
  const { id, result, journal, custody, outputSchema } = parsed;
  if (id !== undefined && typeof id !== 'string') {
    return '`id` must be a string';
  }
  if (outputSchema !== undefined && typeof outputSchema !== 'boolean') {
    return '`outputSchema` must be true or false';
  }
  if (custody !== undefined) {
    if (typeof custody !== 'string') {
      return '`custody` must be a path';
    }
    if (result !== undefined || journal !== undefined) {
      return '`custody` cannot be combined with `result` or `journal`: a custody directory names its own';
    }
    if (outputSchema !== undefined) {
      return '`custody` cannot be combined with `outputSchema`: its invocation record says whether the run had one';
    }
    return { id: typeof id === 'string' ? id : null, custody };
  }
  if (outputSchema === true && result === undefined) {
    return '`outputSchema` needs a `result` to read';
  }
  if (result !== undefined && typeof result !== 'string') {
    return '`result` must be a path';
  }
  if (journal !== undefined && typeof journal !== 'string') {
    return '`journal` must be a path';
  }
  if (result === undefined && journal === undefined) {
    return 'names neither `result` nor `journal`';
  }
  return {
    id: typeof id === 'string' ? id : null,
    result: typeof result === 'string' ? result : null,
    journal: typeof journal === 'string' ? journal : null,
    ...(outputSchema === true ? { outputSchema } : {}),
  };
}

/**
 * Reads many requests in one process, in order. Each distinct path is read
 * once per call and its reading reused, so every entry that names a file
 * refers to the same bytes; a result named both with and without
 * `outputSchema` is read once for each. A file that cannot be read makes that entry an
 * error naming it; the others are read.
 */
export async function readOutcomeFiles(
  requests: readonly OutcomeRequest[],
  readFile: (file: string) => Promise<Uint8Array>
): Promise<OutcomeEntry[]> {
  const results = new Map<string, Promise<ResultReading>>();
  const schemaResults = new Map<string, Promise<ResultReading>>();
  const journals = new Map<string, Promise<JournalReading>>();
  const once = <T>(cache: Map<string, Promise<T>>, file: string, read: (bytes: Uint8Array) => T): Promise<T> => {
    const cached = cache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const pending = readFile(file).then(read, (error: unknown) => {
      throw new Error(`cannot read ${file}: ${describe(error)}`);
    });
    cache.set(file, pending);
    return pending;
  };

  const asResult = (bytes: Uint8Array) => readResult(bytes);
  const asSchemaResult = (bytes: Uint8Array) => readResult(bytes, { outputSchema: true });

  const entries: OutcomeEntry[] = [];
  for (const request of requests) {
    try {
      const result = request.result === null
        ? null
        : request.outputSchema === true
          ? await once(schemaResults, request.result, asSchemaResult)
          : await once(results, request.result, asResult);
      const journal = request.journal === null ? null : await once(journals, request.journal, readJournal);
      entries.push({ id: request.id, reading: readOutcome(result, journal), error: null });
    } catch (error) {
      entries.push({ id: request.id, reading: null, error: describe(error) });
    }
  }
  return entries;
}
