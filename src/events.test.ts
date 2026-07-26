import { describe, expect, test } from 'bun:test';

import * as Event from './events.ts';

function toolUse(name: string, input: object, id = 'toolu_test1') {
  return { type: 'tool_use', id, name, input };
}

function toolResult(content: unknown, toolUseId: string | undefined = 'toolu_test1') {
  return toolUseId === undefined
    ? { type: 'tool_result', content }
    : { type: 'tool_result', tool_use_id: toolUseId, content };
}

describe('content block guards', () => {
  test('isTextBlock accepts a typed block and a bare { text }', () => {
    expect(Event.isTextBlock({ type: 'text', text: 'hi' })).toBe(true);
    // SessionBuilder and the vendored forks emit untyped text blocks.
    expect(Event.isTextBlock({ text: 'hi' })).toBe(true);
    expect(Event.isTextBlock({ type: 'thinking', thinking: 'hi' })).toBe(false);
    expect(Event.isTextBlock(toolUse('Read', { file_path: 'a' }))).toBe(false);
  });

  test('isImageBlock requires a full source descriptor', () => {
    const source = { type: 'base64', media_type: 'image/png', data: 'AAAA' };
    expect(Event.isImageBlock({ type: 'image', source })).toBe(true);
    expect(Event.isImageBlock({ type: 'image', source: { type: 'base64' } })).toBe(false);
  });

  test('isThinkingBlock discriminates on emptiness, not on the signature', () => {
    const plain = { type: 'thinking', thinking: 'hm' };
    const unsigned = { type: 'thinking', thinking: 'hm', signature: '' };
    // Measured 2026-07-26: 87 blocks in the local corpus carry both readable
    // text and a signature. Requiring an absent signature dropped all of them.
    const signed = { type: 'thinking', thinking: 'hm', signature: 'sig' };
    const encrypted = { type: 'thinking', thinking: '', signature: 'sig' };

    expect(Event.isThinkingBlock(plain)).toBe(true);
    expect(Event.isThinkingBlock(unsigned)).toBe(true);
    expect(Event.isThinkingBlock(signed)).toBe(true);
    expect(Event.isThinkingBlock(encrypted)).toBe(false);

    expect(Event.isEncryptedThinkingBlock(encrypted)).toBe(true);
    expect(Event.isEncryptedThinkingBlock(plain)).toBe(false);
    expect(Event.isEncryptedThinkingBlock(signed)).toBe(false);
  });

  test('isBashBlock requires input.command', () => {
    expect(Event.isBashBlock(toolUse('Bash', { command: 'ls', description: 'list' }))).toBe(true);
    expect(Event.isBashBlock(toolUse('Bash', { description: 'no command' }))).toBe(false);
    expect(Event.isBashBlock(toolUse('Read', { file_path: 'x' }))).toBe(false);
  });

  test('tool block guards ignore the enclosing message entirely', () => {
    // They see one content block, so `<synthetic>` cannot reach them. That is
    // what lets a preloaded Read render like any other.
    expect(Event.isReadBlock(toolUse('Read', { file_path: 'a.txt' }))).toBe(true);
    expect(Event.isWriteBlock(toolUse('Write', { file_path: 'a', content: 'b' }))).toBe(true);
    expect(Event.isEditBlock(toolUse('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' })))
      .toBe(true);
    expect(Event.isGrepBlock(toolUse('Grep', { pattern: 'x' }))).toBe(true);
    expect(Event.isSkillBlock(toolUse('Skill', { skill: 's' }))).toBe(true);
    expect(Event.isAgentBlock(toolUse('Agent', { description: 'd', prompt: 'p' }))).toBe(true);
    expect(Event.isToolSearchBlock(toolUse('ToolSearch', { query: 'q' }))).toBe(true);
    expect(Event.isTaskCreateBlock(
      toolUse('TaskCreate', { subject: 's', description: 'd', activeForm: 'a' })
    )).toBe(true);
    expect(Event.isTaskUpdateBlock(toolUse('TaskUpdate', { taskId: 't', status: 'done' })))
      .toBe(true);
    expect(Event.isEnterPlanModeBlock(toolUse('EnterPlanMode', {}))).toBe(true);
    expect(Event.isExitPlanModeBlock(toolUse('ExitPlanMode', {}))).toBe(true);
  });

  test('isTaskUpdateBlock accepts a partial update, taskId being the only constant', () => {
    // Measured 2026-07-26: real TaskUpdate calls touch exactly one of status,
    // addBlockedBy, or description alongside taskId (64, 6, and 1 calls in
    // the local corpus) — never more than one, and never none. The old guard
    // required status, so the 7 calls without it fell to the generic catch-all.
    expect(Event.isTaskUpdateBlock(toolUse('TaskUpdate', { taskId: 't', status: 'done' })))
      .toBe(true);
    expect(Event.isTaskUpdateBlock(toolUse('TaskUpdate', { taskId: 't', addBlockedBy: [ '1' ] })))
      .toBe(true);
    expect(Event.isTaskUpdateBlock(toolUse('TaskUpdate', { taskId: 't', description: 'd' })))
      .toBe(true);
    expect(Event.isTaskUpdateBlock(toolUse('TaskUpdate', { taskId: 't' }))).toBe(true);
    expect(Event.isTaskUpdateBlock(toolUse('TaskUpdate', { status: 'done' }))).toBe(false);
    expect(Event.isTaskUpdateBlock(toolUse('TaskUpdate', { taskId: 't', addBlockedBy: [ 1 ] })))
      .toBe(false);
  });

  test('isToolUseBlock requires the pairing id, and takes any tool', () => {
    expect(Event.isToolUseBlock(toolUse('Read', { file_path: 'a' }))).toBe(true);
    expect(Event.isToolUseBlock(toolUse('WhateverTool', {}))).toBe(true);
    expect(Event.isToolUseBlock({ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }))
      .toBe(false);
  });

  test('isAnyToolUseBlock takes every tool, known or not, well-formed or not', () => {
    // No exclusion list: the renderer keeps this rule last, and ordering does
    // the work an exclusion list used to do badly.
    expect(Event.isAnyToolUseBlock(toolUse('SomeNewTool', { x: 1 }))).toBe(true);
    for (const name of [
      'Bash', 'Grep', 'Write', 'Edit', 'Read', 'Skill', 'Agent', 'ToolSearch',
      'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'EnterPlanMode', 'ExitPlanMode',
    ]) {
      expect(Event.isAnyToolUseBlock(toolUse(name, {}))).toBe(true);
    }
    expect(Event.isAnyToolUseBlock({ type: 'tool_use', name: 'Read' })).toBe(false);
    expect(Event.isAnyToolUseBlock({ type: 'text', text: 'x' })).toBe(false);
  });

  test('isToolResultBlock accepts string content with or without tool_use_id', () => {
    expect(Event.isToolResultBlock(toolResult('ok'))).toBe(true);
    expect(Event.isToolResultBlock(toolResult('ok', undefined))).toBe(true);
    expect(Event.isToolResultBlock({ type: 'tool_result', tool_use_id: 42, content: 'ok' }))
      .toBe(false);
    expect(Event.isToolResultBlock(toolResult([ { type: 'text', text: 'ok' } ]))).toBe(false);
  });

  test('the three array-shaped tool_result guards are disjoint', () => {
    const text = toolResult([ { type: 'text', text: 'ok' } ]);
    const image = toolResult([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
    ]);
    const reference = toolResult([ { type: 'tool_reference', tool_name: 'Read' } ]);

    expect([ text, image, reference ].map(Event.isToolResultTextBlock)).toEqual([ true, false, false ]);
    expect([ text, image, reference ].map(Event.isToolResultImageBlock)).toEqual([ false, true, false ]);
    expect([ text, image, reference ].map(Event.isToolReferenceBlock)).toEqual([ false, false, true ]);
  });

  test('array-shaped tool_result guards reject an empty array', () => {
    // `[].every(...)` is vacuously true, which would make all three match.
    const empty = toolResult([]);
    expect(Event.isToolResultTextBlock(empty)).toBe(false);
    expect(Event.isToolResultImageBlock(empty)).toBe(false);
    expect(Event.isToolReferenceBlock(empty)).toBe(false);
  });
});

describe('message envelope guards', () => {
  test('isBlockMessage accepts assistant and user block arrays', () => {
    expect(Event.isBlockMessage({ type: 'assistant', message: { content: [] } })).toBe(true);
    expect(Event.isBlockMessage({ type: 'user', message: { content: [] } })).toBe(true);
    expect(Event.isBlockMessage({ type: 'user', message: { content: 'hi' } })).toBe(false);
    expect(Event.isBlockMessage({ type: 'system', message: { content: [] } })).toBe(false);
  });

  test('isBlockMessage does not validate the blocks it exposes', () => {
    // The blocks stay unknown on purpose: the renderer dispatches each one.
    expect(Event.isBlockMessage({ type: 'assistant', message: { content: [ 1, null, 'x' ] } }))
      .toBe(true);
  });

  test('isUserText accepts string content, rejects a block array', () => {
    expect(Event.isUserText({ type: 'user', message: { content: 'hi' } })).toBe(true);
    expect(Event.isUserText({ type: 'user', message: { content: [ { text: 'hi' } ] } })).toBe(false);
  });
});

describe('standalone event guards', () => {
  test('metadata guards match their type tags', () => {
    expect(Event.isFileHistorySnapshot({ type: 'file-history-snapshot' })).toBe(true);
    expect(Event.isFileHistoryDelta({ type: 'file-history-delta', trackingPath: 'a.ts' })).toBe(true);
    expect(Event.isPermissionMode({ type: 'permission-mode', permissionMode: 'default' })).toBe(true);
    expect(Event.isMode({ type: 'mode', mode: 'normal' })).toBe(true);
    expect(Event.isAgentSetting({ type: 'agent-setting', agentSetting: 'claude' })).toBe(true);
    expect(Event.isLastPrompt({ type: 'last-prompt', lastPrompt: 'hi' })).toBe(true);
    expect(Event.isCustomTitle({ type: 'custom-title', customTitle: 't' })).toBe(true);
    expect(Event.isAiTitle({ type: 'ai-title', aiTitle: 't' })).toBe(true);
    expect(Event.isAgentName({ type: 'agent-name', agentName: 'a' })).toBe(true);
    expect(Event.isTurnDuration({
      type: 'system', subtype: 'turn_duration', durationMs: 1, messageCount: 2, timestamp: 't',
    })).toBe(true);
    expect(Event.isApiError({ type: 'system', subtype: 'api_error' })).toBe(true);
    expect(Event.isApiError({ type: 'system', subtype: 'turn_duration' })).toBe(false);
  });

  test('the queue operations discriminate on `operation`', () => {
    const queue = (operation: string, content?: string) =>
      content === undefined
        ? { type: 'queue-operation', operation }
        : { type: 'queue-operation', operation, content };

    expect(Event.isEnqueueOperation(queue('enqueue', 'x'))).toBe(true);
    expect(Event.isEnqueueOperation(queue('enqueue'))).toBe(false);
    expect(Event.isDequeueOperation(queue('dequeue'))).toBe(true);
    expect(Event.isRemoveOperation(queue('remove'))).toBe(true);
    expect(Event.isPopAllOperation(queue('popAll', 'x'))).toBe(true);
    expect(Event.isPopAllOperation(queue('enqueue', 'x'))).toBe(false);
  });

  test('attachment guards discriminate on the inner type', () => {
    expect(Event.isSkillListingAttachment({
      type: 'attachment', attachment: { type: 'skill_listing', content: 'x' },
    })).toBe(true);
    expect(Event.isCommandPermissionsAttachment({
      type: 'attachment', attachment: { type: 'command_permissions', allowedTools: [ 'Bash' ] },
    })).toBe(true);
    expect(Event.isCommandPermissionsAttachment({
      type: 'attachment', attachment: { type: 'command_permissions', allowedTools: [ 1 ] },
    })).toBe(false);
  });

  test('guards reject null and primitives', () => {
    for (const e of [ null, undefined, 42, 'user', [] ]) {
      expect(Event.isUserText(e)).toBe(false);
      expect(Event.isBlockMessage(e)).toBe(false);
      expect(Event.isTextBlock(e)).toBe(false);
      expect(Event.isToolUseBlock(e)).toBe(false);
      expect(Event.isToolResultBlock(e)).toBe(false);
      expect(Event.isMode(e)).toBe(false);
    }
  });
});
