/**
 * Every record and result in this file is constructed for these tests. Field
 * names and shapes follow what Claude Code 2.1.292 wrote; no value, id, path
 * or cost comes from a retained record.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  contextLimitText,
  isMeasuredPrompt,
  joinResult,
  noResultSchemaOutcome,
  parseOutcomeRequest,
  readJournal,
  readOutcomeFiles,
  readResult,
} from './outcome.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const json = (value: unknown): Uint8Array => encode(JSON.stringify(value));
const jsonl = (...rows: (string | Record<string, unknown>)[]): Uint8Array =>
  encode(rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');

const session = 'session-constructed-1';
const other = 'session-constructed-2';
const version = '2.1.292';
const newer = '2.1.293';

const tokens = (input: number, cacheCreation: number, cacheRead: number, output = 1) =>
  ({ input_tokens: input, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead, output_tokens: output });

const errorResult = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: null,
  terminal_reason: 'blocking_limit',
  result: contextLimitText,
  stop_reason: 'stop_sequence',
  safety_stops: 0,
  num_turns: 9,
  duration_ms: 60000,
  duration_api_ms: 200000,
  total_cost_usd: 20.25,
  session_id: session,
  uuid: 'result-constructed-1',
  usage: {
    ...tokens(40, 50000, 5000000, 9000),
    iterations: [ { ...tokens(3, 2000, 900000, 700), type: 'message' } ],
  },
  modelUsage: {
    'constructed-model': {
      inputTokens: 90, outputTokens: 20000, cacheReadInputTokens: 9000000,
      cacheCreationInputTokens: 90000, costUSD: 20.25, contextWindow: 1000000,
    },
  },
};

const envelope = (fields: Record<string, unknown>) =>
  ({ sessionId: session, version, timestamp: '2026-01-01T00:00:00.000Z', ...fields });
const call = (uuid: string, usage: Record<string, number>, fields: Record<string, unknown> = {}) => envelope({
  type: 'assistant',
  uuid,
  message: { model: 'constructed-model', role: 'assistant', stop_reason: 'tool_use', content: [ { type: 'text', text: '.' } ], usage },
  ...fields,
});
const costState = (cost: number, api: number, sessionId = session) =>
  ({ type: 'cost-state', sessionId, totalCostUSD: cost, totalAPIDuration: api });

const journal = jsonl(
  envelope({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Start.' } }),
  call('a0', tokens(0, 0, 0, 0)),
  call('a1', tokens(3, 1000, 700000)),
  call('a1b', { input_tokens: 5, cache_creation_input_tokens: 5, output_tokens: 1 }),
  costState(12.5, 100000),
  envelope({ type: 'user', uuid: 'u2', version: newer, message: { role: 'user', content: 'Continue.' } }),
  envelope({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', version: newer, compactMetadata: { trigger: 'auto', preTokens: 800000 } }),
  call('a2', tokens(3, 2000, 900000), { version: newer }),
  envelope({
    type: 'assistant', uuid: 'e1', version: newer, isApiErrorMessage: true, error: 'invalid_request',
    message: { model: '<synthetic>', role: 'assistant', content: [ { type: 'text', text: contextLimitText } ], usage: tokens(0, 0, 0, 0) },
  }),
  '{"type":"assistant", cut short',
  costState(20.25, 200000),
  call('a3', tokens(1000, 0, 0)),
);

describe('readResult', () => {
  test('an error result reads as an error whatever its subtype says', () => {
    const reading = readResult(json(errorResult));
    expect(reading.file).toBe('result');
    expect(reading.status).toBe('error');
    expect(reading.subtype).toBe('success');
    expect(reading.contextLimit).toEqual({ terminalReason: true, text: true });
    expect(reading.errorText).toBe(contextLimitText);
  });

  test('stop_reason and safety_stops are carried verbatim, not interpreted', () => {
    const reading = readResult(json({ ...errorResult, is_error: false, terminal_reason: 'completed', result: 'Part 1.', stop_reason: 'end_turn', safety_stops: 1 }));
    expect(reading.status).toBe('no-error');
    expect(reading.stopReason).toBe('end_turn');
    expect(reading.safetyStops).toBe(1);
    expect(reading.errorText).toBeNull();
  });

  test('the last call is the last usage.iterations entry, kept apart from process and session sums', () => {
    const reading = readResult(json(errorResult));
    expect(reading.lastCall).toEqual({
      source: 'usage.iterations[last]',
      entries: 1,
      tokens: { input: 3, cacheCreation: 2000, cacheRead: 900000, output: 700, prompt: 902003 },
    });
    expect(reading.process?.tokens.cacheRead).toBe(5000000);
    expect(reading.process?.durationMs).toBe(60000);
    expect(reading.session?.costUsd).toBe(20.25);
    expect(reading.session?.apiDurationMs).toBe(200000);
    expect(reading.session?.contextWindow).toBe(1000000);
  });

  test('a count that was not recorded is null, and the prompt is then not a measurement', () => {
    const reading = readResult(json({ ...errorResult, usage: { output_tokens: 1, iterations: [ { input_tokens: 3, cache_read_input_tokens: 900000 } ] } }));
    expect(reading.lastCall?.tokens.cacheCreation).toBeNull();
    expect(reading.lastCall?.tokens.output).toBeNull();
    expect(reading.lastCall?.tokens.prompt).toBeNull();
    expect(isMeasuredPrompt(reading.lastCall?.tokens ?? null)).toBe(false);
    expect(reading.process?.tokens.input).toBeNull();
  });

  test('a result without error is not a context limit, even when its text names one', () => {
    const reading = readResult(json({ ...errorResult, is_error: false, terminal_reason: 'completed', result: `It hit "${contextLimitText}" twice.` }));
    expect(reading.status).toBe('no-error');
    expect(reading.contextLimit).toBeNull();
  });

  test('an account limit is an error, not a context limit', () => {
    const reading = readResult(json({ ...errorResult, api_error_status: 429, terminal_reason: 'api_error', result: 'You have hit your session limit' }));
    expect(reading.status).toBe('error');
    expect(reading.apiErrorStatus).toBe(429);
    expect(reading.contextLimit).toBeNull();
  });

  test('the text alone is evidence, and the reading says which evidence it was', () => {
    expect(readResult(json({ ...errorResult, terminal_reason: undefined })).contextLimit).toEqual({ terminalReason: false, text: true });
  });

  test('a cut-short result is unreadable, with the digest of what was there', () => {
    const bytes = encode('{"type":"result","is_err');
    const reading = readResult(bytes);
    expect(reading.file).toBe('unreadable');
    expect(reading.status).toBe('unstated');
    expect(reading.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  test('an empty file says nothing was written; another document is not a result', () => {
    expect(readResult(new Uint8Array()).file).toBe('empty');
    expect(readResult(new Uint8Array()).sha256).toBeNull();
    expect(readResult(new Uint8Array()).form).toBeNull();
    expect(readResult(json({ type: 'assistant' }))).toMatchObject({ file: 'not-a-result', form: 'object' });
    expect(readResult(json('a string'))).toMatchObject({ file: 'not-a-result', form: null });
    expect(readResult(json(errorResult)).form).toBe('object');
  });

  test('the verbose array is read by its last element, a result, and says so; the digest is of the whole file', () => {
    const messages = [ { type: 'system', subtype: 'init' }, { type: 'assistant' }, { type: 'user' } ];
    const bytes = json([ ...messages, errorResult ]);
    const reading = readResult(bytes);
    expect(reading).toMatchObject({ file: 'result', form: 'array', why: null, status: 'error', terminalReason: 'blocking_limit' });
    expect(reading.bytes).toBe(bytes.length);
    expect(reading.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const { form: arrayForm, bytes: _a, sha256: _b, ...fromArray } = reading;
    const { form: objectForm, bytes: _c, sha256: _d, ...fromObject } = readResult(json(errorResult));
    expect(fromArray).toEqual(fromObject);
    expect([ arrayForm, objectForm ]).toEqual([ 'array', 'object' ]);
    expect(readResult(json([ errorResult ])).file).toBe('result');
  });

  test('an array without a result last is not a result: an empty one, or one whose result is not last', () => {
    expect(readResult(json([]))).toMatchObject({ file: 'not-a-result', form: 'array', status: 'unstated' });
    expect(readResult(json([]))?.why).toContain('empty JSON array');
    const resultNotLast = readResult(json([ errorResult, { type: 'assistant' } ]));
    expect(resultNotLast).toMatchObject({ file: 'not-a-result', form: 'array', status: 'unstated', terminalReason: null });
    expect(resultNotLast.why).toContain('last element is not a Claude Code result object');
    expect(readResult(json([ { type: 'assistant' }, 'text' ])).file).toBe('not-a-result');
  });

  test('a result with no recorded call says why it has no last call', () => {
    expect(readResult(json({ ...errorResult, usage: { output_tokens: 0 } })).lastCallMissing).toBe('usage has no iterations');
    expect(readResult(json({ ...errorResult, usage: { output_tokens: 0, iterations: [] } })).lastCallMissing)
      .toBe('usage.iterations is empty: no API call recorded');
  });
});

describe('readJournal', () => {
  const reading = readJournal(journal);

  test('segments end at cost-state records, which keep their session and totals', () => {
    expect(reading.segments.map(s => s.closedBy?.line ?? null)).toEqual([ 5, 11, null ]);
    expect(reading.segments[0]?.closedBy).toEqual({ line: 5, sessionId: session, costUsd: 12.5, apiDurationMs: 100000 });
    expect(reading.openTail).toBe(true);
  });

  test('each segment lists the native versions its records carry', () => {
    expect(reading.segments[0]?.versions).toEqual([ version ]);
    expect(reading.segments[1]?.versions).toEqual([ newer ]);
    expect(reading.versions).toEqual([ version, newer ]);
  });

  test('the last measured call skips zero, incomplete and synthetic usage, and counts what it skipped', () => {
    expect(reading.segments[0]?.lastCall?.line).toBe(3);
    expect(reading.segments[0]?.lastCall?.tokens.prompt).toBe(701003);
    expect(reading.segments[0]?.unmeasuredCalls).toBe(2);
    expect(reading.segments[1]?.lastCall?.line).toBe(8);
    expect(reading.segments[1]?.lastCall?.tokens.prompt).toBe(902003);
    expect(reading.segments[1]?.lastCall?.stopReason).toBe('tool_use');
    expect(reading.lastCall?.line).toBe(12);
  });

  test('API error records and compactions stay where they occurred', () => {
    expect(reading.segments[1]?.apiErrors).toEqual([ {
      line: 9, uuid: 'e1', timestamp: '2026-01-01T00:00:00.000Z', version: newer,
      error: 'invalid_request', text: contextLimitText, contextLimit: true,
    } ]);
    expect(reading.segments[1]?.compactions[0]?.line).toBe(7);
    expect(reading.segments[1]?.compactions[0]?.preTokens).toBe(800000);
    expect(reading.segments[1]?.compactions[0]?.keys).toContain('compactMetadata');
  });

  test('a line that is not JSON is counted, not fatal', () => {
    expect(reading.unparsed).toBe(1);
    expect(reading.lines).toBe(12);
    expect(reading.segments[1]?.records).toBe(4);
    expect(reading.sessionIds).toEqual([ session ]);
  });
});

describe('joinResult', () => {
  test('joins by session and exact totals, and reports the segment\'s versions', () => {
    const join = joinResult(readResult(json(errorResult)), readJournal(journal));
    expect(join.kind).toBe('joined');
    expect(join.segment).toBe(1);
    expect(join.candidates).toEqual([ 1 ]);
    expect(join.lastCallPromptTokensAgree).toBe(true);
    expect(join.contextLimitRecord).toBe('e1');
    expect(join.versions).toEqual([ newer ]);
  });

  test('a result of a session the journal never names does not join', () => {
    const join = joinResult(readResult(json({ ...errorResult, session_id: other })), readJournal(journal));
    expect(join.kind).toBe('no-match');
    expect(join.segment).toBeNull();
  });

  test('totals stated by another session\'s cost-state record do not join', () => {
    const mixed = jsonl(call('a1', tokens(3, 2000, 900000)), costState(20.25, 200000, other));
    expect(joinResult(readResult(json(errorResult)), readJournal(mixed)).kind).toBe('no-match');
  });

  test('repeated totals are ambiguous, with every candidate kept and none chosen', () => {
    const repeated = jsonl(
      call('a1', tokens(3, 2000, 900000)),
      costState(20.25, 200000),
      envelope({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'Again.' } }),
      costState(20.25, 200000),
    );
    const join = joinResult(readResult(json(errorResult)), readJournal(repeated));
    expect(join.kind).toBe('ambiguous');
    expect(join.segment).toBeNull();
    expect(join.candidates).toEqual([ 0, 1 ]);
  });

  test('a disagreeing last call is refused, not joined', () => {
    const disagreeing = jsonl(call('a1', tokens(3, 2000, 800000)), costState(20.25, 200000));
    const join = joinResult(readResult(json(errorResult)), readJournal(disagreeing));
    expect(join.kind).toBe('disagrees');
    expect(join.lastCallPromptTokensAgree).toBe(false);
    expect(join.segment).toBeNull();
    expect(join.candidates).toEqual([ 0 ]);
  });

  test('totals alone do not join when the result has no measured last call', () => {
    for (const iterations of [[], [tokens(0, 0, 0)]]) {
      const join = joinResult(readResult(json({ ...errorResult, usage: { output_tokens: 0, iterations } })), readJournal(journal));
      expect(join.kind).toBe('not-comparable');
      expect(join.segment).toBeNull();
      expect(join.candidates).toEqual([1]);
      expect(join.lastCallPromptTokensAgree).toBeNull();
    }
  });

  test('a result without a session is not comparable', () => {
    expect(joinResult(readResult(json({ ...errorResult, session_id: undefined })), readJournal(journal)).kind).toBe('not-comparable');
  });
});

describe('parseOutcomeRequest', () => {
  test('takes ids and paths, and says why a line is not a request', () => {
    expect(parseOutcomeRequest('{"id":"x","result":"r.json"}')).toEqual({ id: 'x', result: 'r.json', journal: null });
    expect(parseOutcomeRequest('{"journal":"j.jsonl"}')).toEqual({ id: null, result: null, journal: 'j.jsonl' });
    expect(parseOutcomeRequest('{"id":"x"}')).toBe('names neither `result` nor `journal`');
    expect(parseOutcomeRequest('{"result":1}')).toBe('`result` must be a path');
    expect(parseOutcomeRequest('[1]')).toBe('not one JSON object');
  });

  test('takes a custody directory alone: it names its own result and journal', () => {
    expect(parseOutcomeRequest('{"id":"c","custody":"runs/0042"}')).toEqual({ id: 'c', custody: 'runs/0042' });
    expect(parseOutcomeRequest('{"custody":"runs/0042"}')).toEqual({ id: null, custody: 'runs/0042' });
    expect(parseOutcomeRequest('{"custody":7}')).toBe('`custody` must be a path');
    expect(parseOutcomeRequest('{"custody":"d","journal":"j.jsonl"}')).toContain('cannot be combined');
    expect(parseOutcomeRequest('{"id":3,"custody":"d"}')).toBe('`id` must be a string');
  });
});

describe('readOutcomeFiles', () => {
  test('reads each distinct path once, keeps order and ids, and isolates an unreadable file', async () => {
    const files = new Map<string, Uint8Array>([ [ '/r.json', json(errorResult) ], [ '/j.jsonl', journal ] ]);
    const reads: string[] = [];
    const readFile = async (file: string): Promise<Uint8Array> => {
      reads.push(file);
      const bytes = files.get(file);
      if (bytes === undefined) {
        throw new Error('no such file');
      }
      return bytes;
    };
    const entries = await readOutcomeFiles([
      { id: 'a', result: '/r.json', journal: '/j.jsonl' },
      { id: 'b', result: null, journal: '/j.jsonl' },
      { id: 'c', result: '/missing.json', journal: null },
      { id: 'd', result: '/r.json', journal: null },
    ], readFile);
    expect(reads).toEqual([ '/r.json', '/j.jsonl', '/missing.json' ]);
    expect(entries.map(e => e.id)).toEqual([ 'a', 'b', 'c', 'd' ]);
    expect(entries[0]?.reading?.join?.kind).toBe('joined');
    expect(entries[1]?.reading?.result).toBeNull();
    expect(entries[2]?.reading).toBeNull();
    expect(entries[2]?.error).toContain('/missing.json');
    expect(entries[3]?.reading?.result?.sha256).toBe(entries[0]?.reading?.result?.sha256 ?? '');
  });
});

/**
 * Results of runs given an output schema, in the shapes observed 2026-11-22
 * of claude 2.1.328 (`-p --output-format json --json-schema`): a satisfiable
 * schema's result, and the give-up of an unsatisfiable one under
 * `MAX_STRUCTURED_OUTPUT_RETRIES=1` (no `result`, no `structured_output`).
 * With native verbose, each was the last element of an array of the run's
 * messages. Values, ids and texts are constructed.
 */
const structuredResult = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 3, session_id: session,
  terminal_reason: 'completed', structured_output: { answer: 'ok' }, result: '{"answer":"ok"}',
};
const gaveUpResult = {
  type: 'result', subtype: 'error_max_structured_output_retries', is_error: true,
  terminal_reason: 'structured_output_retry_exhausted', num_turns: 3, session_id: session,
  errors: [ 'constructed: Failed to provide valid structured output after 1 attempts' ],
};
/** What precedes the result in the verbose array, by type as observed; contents constructed. */
const verboseMessages = [
  { type: 'system', subtype: 'init', session_id: session, tools: [ 'StructuredOutput' ] },
  { type: 'assistant', message: { content: [] } },
  { type: 'rate_limit_event' },
  { type: 'user', message: { content: [] } },
];
const schemaDigest = 'a'.repeat(64);

describe('readResult with an output schema', () => {
  const schemaOf = (bytes: Uint8Array) => readResult(bytes, { outputSchema: true }).schema;

  test('structured_output is a conforming answer, native-enforced, its value as native parsed it', () => {
    expect(schemaOf(json(structuredResult)))
      .toEqual({ kind: 'conforming', enforcedBy: 'native', value: { answer: 'ok' }, schemaSha256: null });
  });

  test('native giving up is not-conforming, with its errors verbatim and no final message in the error variant', () => {
    expect(schemaOf(json(gaveUpResult))).toEqual({
      kind: 'not-conforming', enforcedBy: 'native',
      errors: [ 'constructed: Failed to provide valid structured output after 1 attempts' ], finalMessage: null,
      schemaSha256: null,
    });
  });

  test('the verbose array is read by its last element: conforming, and a give-up, as from the lone object', () => {
    const conforming = readResult(json([ ...verboseMessages, structuredResult ]), { outputSchema: true });
    expect(conforming).toMatchObject({ file: 'result', form: 'array', status: 'no-error' });
    expect(conforming.schema).toEqual(schemaOf(json(structuredResult)));
    expect(conforming.schema?.kind).toBe('conforming');
    const gaveUp = readResult(json([ ...verboseMessages, gaveUpResult ]), { outputSchema: true });
    expect(gaveUp).toMatchObject({ file: 'result', form: 'array', status: 'error' });
    expect(gaveUp.schema).toEqual(schemaOf(json(gaveUpResult)));
  });

  test('an array that does not end in a result is no final message, an unreadable result saying why', () => {
    for (const array of [ [], verboseMessages, [ ...verboseMessages, structuredResult, { type: 'assistant' } ] ]) {
      const reading = readResult(json(array), { outputSchema: true });
      expect(reading).toMatchObject({ file: 'not-a-result', form: 'array' });
      expect(reading.schema).toMatchObject({ kind: 'no-final-message', enforcedBy: 'native', reason: 'unreadable-result' });
      expect(reading.schema?.kind === 'no-final-message' ? reading.schema.detail : '').toContain('array');
    }
  });

  test('every kind names the schema by its digest when the reader is given it, and null when not', () => {
    const given = { sha256: schemaDigest };
    for (const bytes of [ json(structuredResult), json(gaveUpResult), json({ ...structuredResult, structured_output: null }), new Uint8Array(), json([]) ]) {
      expect(readResult(bytes, { outputSchema: given }).schema?.schemaSha256).toBe(schemaDigest);
      expect(readResult(bytes, { outputSchema: true }).schema?.schemaSha256).toBeNull();
    }
    expect(noResultSchemaOutcome('never started', schemaDigest).schemaSha256).toBe(schemaDigest);
  });

  test('the subtype or the terminal reason alone says it gave up, but only on an error result', () => {
    const bySubtype = { ...gaveUpResult, terminal_reason: 'completed' };
    expect(schemaOf(json(bySubtype))?.kind).toBe('not-conforming');
    // An error result reading subtype "success" (as 2.1.292 wrote) still gave up by its terminal reason.
    const byReason = { ...gaveUpResult, subtype: 'success', result: 'final words' };
    expect(schemaOf(json(byReason))).toMatchObject({ kind: 'not-conforming', finalMessage: 'final words' });
    const notAnError = { ...gaveUpResult, is_error: false };
    expect(schemaOf(json(notAnError))).toMatchObject({ kind: 'no-final-message', reason: 'no-structured-output' });
  });

  test('a result without structured_output, or with it null, is no final message, saying what the result said', () => {
    const { structured_output: _dropped, ...plain } = structuredResult;
    const without = schemaOf(json(plain));
    expect(without).toMatchObject({ kind: 'no-final-message', enforcedBy: 'native', reason: 'no-structured-output' });
    expect(without?.kind === 'no-final-message' ? without.detail : '').toContain('subtype "success"');
    expect(schemaOf(json({ ...structuredResult, structured_output: null })))
      .toMatchObject({ kind: 'no-final-message', reason: 'no-structured-output' });
    // Another error is not a schema verdict.
    expect(schemaOf(json(errorResult))).toMatchObject({ kind: 'no-final-message', reason: 'no-structured-output' });
  });

  test('no result is no final message: nothing written, or bytes that are not a result', () => {
    expect(schemaOf(new Uint8Array())).toMatchObject({ kind: 'no-final-message', reason: 'no-result' });
    expect(schemaOf(encode('{"type":"res'))).toMatchObject({ kind: 'no-final-message', reason: 'unreadable-result' });
    expect(schemaOf(json({ type: 'assistant' }))).toMatchObject({ kind: 'no-final-message', reason: 'unreadable-result' });
    expect(noResultSchemaOutcome('never started', null))
      .toEqual({ kind: 'no-final-message', enforcedBy: 'native', reason: 'no-result', detail: 'never started', schemaSha256: null });
  });

  test('without the option the reading is as before: no schema key, whatever the result carries', () => {
    expect('schema' in readResult(json(structuredResult))).toBe(false);
    expect('schema' in readResult(json(gaveUpResult), { outputSchema: false })).toBe(false);
    const { schema: _schema, ...rest } = readResult(json(gaveUpResult), { outputSchema: true });
    expect(rest).toEqual(readResult(json(gaveUpResult)));
  });

  test('a batch line declares the schema; a custody line cannot, since its invocation records one', async () => {
    expect(parseOutcomeRequest('{"id":"s","result":"r.json","outputSchema":true}'))
      .toEqual({ id: 's', result: 'r.json', journal: null, outputSchema: true });
    expect(parseOutcomeRequest('{"result":"r.json","outputSchema":false}')).toEqual({ id: null, result: 'r.json', journal: null });
    expect(parseOutcomeRequest('{"result":"r.json","outputSchema":"yes"}')).toBe('`outputSchema` must be true or false');
    expect(parseOutcomeRequest('{"journal":"j.jsonl","outputSchema":true}')).toBe('`outputSchema` needs a `result` to read');
    expect(parseOutcomeRequest('{"custody":"d","outputSchema":true}')).toContain('cannot be combined with `outputSchema`');

    const entries = await readOutcomeFiles([
      { id: 'with', result: '/r.json', journal: null, outputSchema: true },
      { id: 'without', result: '/r.json', journal: null },
    ], async () => json(structuredResult));
    expect(entries[0]?.reading?.result?.schema).toMatchObject({ kind: 'conforming' });
    expect(entries[1]?.reading?.result !== null && 'schema' in (entries[1]?.reading?.result ?? {})).toBe(false);
  });
});
