import { describe, expect, test } from 'bun:test';

import path from 'node:path';

import { SessionBuilder } from './SessionBuilder.ts';

function build(): SessionBuilder {
  return new SessionBuilder('session-1', '2.1.220', '/tmp/project', 'main', 'test-model');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Message content blocks of a session record, or none if it has no message. */
function blocks(record: unknown): Record<string, unknown>[] {
  if (!isRecord(record) || !isRecord(record.message) || !Array.isArray(record.message.content)) {
    return [];
  }
  return record.message.content.filter(isRecord);
}

/** The one assistant record carrying a tool call. */
function toolCall(records: unknown[]): Record<string, unknown> {
  const found = records.find(r => blocks(r).some(b => b.type === 'tool_use'));
  if (!isRecord(found)) {
    throw new Error('no tool_use record in session');
  }
  return found;
}

/** The one user record carrying the paired tool result. */
function toolResult(records: unknown[]): Record<string, unknown> {
  const found = records.find(r => blocks(r).some(b => b.type === 'tool_result'));
  if (!isRecord(found)) {
    throw new Error('no tool_result record in session');
  }
  return found;
}

function field(record: Record<string, unknown>, ...keys: string[]): unknown {
  let value: unknown = record;
  for (const key of keys) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

/** Every record of one `type`. */
function ofType(records: unknown[], type: string): Record<string, unknown>[] {
  return records.filter(isRecord).filter(r => r.type === type);
}

/** Every content block of one `type`, across every record. */
function allBlocks(records: unknown[], type: string): Record<string, unknown>[] {
  return records.flatMap(blocks).filter(b => b.type === type);
}

/** The one record of a `type`, or a failure if there is not exactly one. */
function only(records: unknown[], type: string): Record<string, unknown> {
  const found = ofType(records, type);
  if (found.length !== 1) {
    throw new Error(`expected exactly one ${type} record, found ${found.length}`);
  }
  return found[0] as Record<string, unknown>;
}

/** A session exercising every emit, so cross-cutting fields can be checked at once. */
function everything(): unknown[] {
  return build()
    .emitUser('a prompt')
    .emitRead('a.txt', 'alpha')
    .emitBash('true', 'no-op', { stdout: 'out', stderr: '', exitCode: 0 })
    .emitAssistant('a reply')
    .commit();
}

describe('SessionBuilder.emitRead', () => {
  test('numbers lines the way Claude Code does: 1-based, one tab, no padding', () => {
    const records = build().emitRead('a.txt', 'alpha\nbeta\ngamma').commit();

    expect(blocks(toolResult(records))[0]?.content).toBe('1\talpha\n2\tbeta\n3\tgamma\n');
  });

  test('numbers a blank line like any other', () => {
    const records = build().emitRead('a.txt', 'alpha\n\ngamma').commit();

    expect(blocks(toolResult(records))[0]?.content).toBe('1\talpha\n2\t\n3\tgamma\n');
  });

  test('keeps toolUseResult.file.content raw and unnumbered', () => {
    const result = toolResult(build().emitRead('a.txt', 'alpha\nbeta').commit());

    expect(field(result, 'toolUseResult', 'file', 'content')).toBe('alpha\nbeta');
    expect(field(result, 'toolUseResult', 'file', 'numLines')).toBe(2);
  });

  test('pairs the tool_result back to the tool_use that produced it', () => {
    const records = build().emitRead('a.txt', 'alpha').commit();
    const call = toolCall(records);
    const result = toolResult(records);

    const callId = blocks(call)[0]?.id;

    expect(typeof callId).toBe('string');
    expect(blocks(result)[0]?.tool_use_id).toBe(callId);
    expect(result.parentUuid).toBe(call.uuid);
    expect(result.sourceToolAssistantUUID).toBe(call.uuid);
  });

  test('passes the path through as given, and resolves it in the result', () => {
    const records = build().emitRead('a.txt', 'alpha').commit();

    expect(field(blocks(toolCall(records))[0] ?? {}, 'input', 'file_path')).toBe('a.txt');
    expect(field(toolResult(records), 'toolUseResult', 'file', 'filePath'))
      .toBe(path.resolve('a.txt'));
  });

  test('brackets the session with a prologue and epilogue', () => {
    const records = build().commit();

    expect(records[0]?.type).toBe('permission-mode');
    expect(records[1]?.type).toBe('file-history-snapshot');
    expect(records[records.length - 1]?.type).toBe('permission-mode');
  });
});

// Every assertion below pins a shape measured against real transcripts in
// ~/.claude/projects on 2026-07-26, `claude` 2.1.220. Change one only with a
// fresh measurement.
describe('SessionBuilder fidelity to real Claude Code records', () => {
  test('ids are Anthropic-shaped: prefix plus exactly 24 base62 characters', () => {
    const records = everything();

    for (const record of ofType(records, 'assistant')) {
      expect(field(record, 'message', 'id')).toMatch(/^msg_[0-9A-Za-z]{24}$/);
    }
    for (const block of allBlocks(records, 'tool_use')) {
      expect(block.id).toMatch(/^toolu_[0-9A-Za-z]{24}$/);
    }
  });

  test('ids are distinct per record', () => {
    const records = everything();
    const messageIds = ofType(records, 'assistant').map(r => field(r, 'message', 'id'));
    const toolIds = allBlocks(records, 'tool_use').map(b => b.id);

    expect(new Set(messageIds).size).toBe(messageIds.length);
    expect(new Set(toolIds).size).toBe(toolIds.length);
  });

  test('Bash tool calls use the same toolu_ scheme as Read', () => {
    const records = build().emitBash('true', 'no-op', { stdout: '', stderr: '', exitCode: 0 })
      .commit();

    expect(blocks(toolCall(records))[0]?.id).toMatch(/^toolu_[0-9A-Za-z]{24}$/);
  });

  test('every tool_use block declares a direct caller', () => {
    for (const block of allBlocks(everything(), 'tool_use')) {
      expect(block.caller).toEqual({ type: 'direct' });
    }
  });

  test('assistant and tool-result records carry snake_case session_id too', () => {
    const records = everything();

    for (const record of ofType(records, 'assistant')) {
      expect(record.session_id).toBe('session-1');
      expect(record.sessionId).toBe('session-1');
    }
    for (const record of ofType(records, 'user').filter(r => 'toolUseResult' in r)) {
      expect(record.session_id).toBe('session-1');
      expect(record.sessionId).toBe('session-1');
    }
  });

  test('a typed user record carries no session_id — only tool results do', () => {
    const user = only(build().emitUser('a prompt').commit(), 'user');

    expect(user.sessionId).toBe('session-1');
    expect('session_id' in user).toBe(false);
  });

  test('a typed user record is marked human, typed, and permission-moded', () => {
    // Real typed prompts do carry permissionMode; it is the tool-result user
    // records that do not. These three fields travel together.
    const user = only(build().emitUser('a prompt', 'acceptEdits').commit(), 'user');

    expect(user.origin).toEqual({ kind: 'human' });
    expect(user.promptSource).toBe('typed');
    expect(user.permissionMode).toBe('acceptEdits');
  });

  test('a tool-result user record carries none of the human-prompt markers', () => {
    const result = toolResult(build().emitRead('a.txt', 'alpha').commit());

    expect('origin' in result).toBe(false);
    expect('promptSource' in result).toBe(false);
    expect('permissionMode' in result).toBe(false);
  });

  test('assistant records carry an effort level, defaulting to high', () => {
    for (const record of ofType(everything(), 'assistant')) {
      expect(record.effort).toBe('high');
    }
  });

  test('the constructor effort argument reaches every assistant record', () => {
    const records = new SessionBuilder('session-1', '2.1.220', '/tmp/project', 'main', 'm', 'xhigh')
      .emitRead('a.txt', 'alpha')
      .emitAssistant('a reply')
      .commit();

    const assistants = ofType(records, 'assistant');

    expect(assistants.length).toBe(2);
    for (const record of assistants) {
      expect(record.effort).toBe('xhigh');
    }
  });

  test('user records carry no effort', () => {
    for (const record of ofType(everything(), 'user')) {
      expect('effort' in record).toBe(false);
    }
  });

  test('assistant messages carry a null diagnostics field', () => {
    for (const record of ofType(everything(), 'assistant')) {
      expect(field(record, 'message', 'diagnostics')).toBe(null);
    }
  });

  test('usage is Claude Code\'s own zero-usage shape, not a fake count', () => {
    // Zeros matter: Claude Code reads the last assistant record's usage back on
    // resume and treats a zero input+cache total as "no measurement". A nonzero
    // one is believed, and would claim the whole preloaded context is a token.
    for (const record of ofType(everything(), 'assistant')) {
      expect(field(record, 'message', 'usage')).toEqual({
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
      });
    }
  });

  test('each record gets its own usage object', () => {
    const [ first, second ] = ofType(everything(), 'assistant');

    expect(field(first ?? {}, 'message', 'usage'))
      .not.toBe(field(second ?? {}, 'message', 'usage'));
  });

  test('last-prompt points its leafUuid at the final message record', () => {
    const records = everything();
    const withUuid = records.filter(isRecord).filter(r => typeof r.uuid === 'string');
    const leaf = withUuid[withUuid.length - 1];

    expect(only(records, 'last-prompt').leafUuid).toBe(leaf?.uuid);
  });

  test('last-prompt carries the prompt, the leaf and the session id', () => {
    const lastPrompt = only(build().emitUser('a prompt').commit(), 'last-prompt');

    expect(Object.keys(lastPrompt).toSorted())
      .toEqual([ 'lastPrompt', 'leafUuid', 'sessionId', 'type' ]);
    expect(lastPrompt.lastPrompt).toBe('a prompt');
    expect(lastPrompt.sessionId).toBe('session-1');
  });

  test('a session with no user turn emits no last-prompt at all', () => {
    expect(ofType(build().emitAssistant('a reply').commit(), 'last-prompt')).toEqual([]);
  });

  test('the whole session survives a JSONL round trip', () => {
    const events = everything();
    const parsed: unknown[] = events
      .map(e => JSON.stringify(e))
      .join('\n')
      .split('\n')
      .map(line => JSON.parse(line));

    expect(parsed).toEqual(events.map(e => JSON.parse(JSON.stringify(e))));
  });
});
