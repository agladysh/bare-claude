/**
 * Type guards for Claude Code session NDJSON.
 *
 * Two vocabularies live here, and the distinction is load-bearing:
 *
 * - **Content blocks** (`is*Block`) describe one entry of an `assistant` or
 *   `user` record's `message.content` array. `display.ts` dispatches per block,
 *   so a record mixing prose with a tool call renders both halves.
 * - **Standalone events** (everything else) describe a whole record — the
 *   session metadata types that carry no content array.
 *
 * Measured 2026-07-26 across the local corpus (`~/.claude/projects/**\/*.jsonl`,
 * 954 files, ~53k assistant records): 11 assistant records carry more than one
 * content block, all of them `thinking`/`text`/`tool_use` mixes, and all of
 * them in subagent transcripts or non-Opus models (`glm-5.2`, `claude-fable-5`,
 * `claude-opus-4-8`). Per-event dispatch dropped every one of them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Content blocks: shared
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A plain text block. Appears in both `assistant` and `user` records, and
 * inside a `tool_result`'s content array.
 *
 * `type` is optional because the guard has always accepted a bare `{ text }`
 * block: hand-built sessions (`SessionBuilder`, the vendored forks) emit them.
 * Every block in the measured corpus does carry `type: 'text'`.
 */
export interface TextBlock {
  type?: 'text';
  text: string;
}

/** Recognizes a {@link TextBlock}. */
export function isTextBlock(c: unknown): c is TextBlock {
  return c !== null && typeof c === 'object'
    && (!('type' in c) || c.type === 'text')
    && 'text' in c && typeof c.text === 'string';
}

/**
 * An inline image, base64-encoded in `source.data`. Measured 2026-07-26: 206
 * `tool_result` blocks and 3 top-level `user` blocks in the local corpus carry
 * one, and none of them rendered at all before per-block dispatch.
 */
export interface ImageBlock {
  type: 'image';
  source: {
    type: string;
    media_type: string;
    data: string;
  };
}

/** Recognizes an {@link ImageBlock}. */
export function isImageBlock(c: unknown): c is ImageBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'image'
    && 'source' in c && c.source !== null && typeof c.source === 'object'
    && 'type' in c.source && typeof c.source.type === 'string'
    && 'media_type' in c.source && typeof c.source.media_type === 'string'
    && 'data' in c.source && typeof c.source.data === 'string';
}

// ─────────────────────────────────────────────────────────────────────────────
// Content blocks: assistant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended thinking with readable text.
 *
 * Measured 2026-07-26: of 16 503 thinking blocks in the local corpus, 87 carry
 * *both* non-empty `thinking` and a non-empty `signature`. The previous guard
 * required the signature to be absent or empty, so those 87 matched neither
 * thinking shape and rendered as nothing. Emptiness of `thinking` is the only
 * reliable discriminator; the signature says nothing about legibility.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

/** Recognizes a {@link ThinkingBlock}. */
export function isThinkingBlock(c: unknown): c is ThinkingBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'thinking'
    && 'thinking' in c && typeof c.thinking === 'string' && c.thinking !== ''
    && (!('signature' in c) || typeof c.signature === 'string');
}

/**
 * Extended thinking the API returned encrypted: a signature and no plaintext.
 * The overwhelmingly common case — 16 070 of 16 503 measured blocks.
 */
export interface EncryptedThinkingBlock {
  type: 'thinking';
  thinking: '';
  signature: string;
}

/** Recognizes an {@link EncryptedThinkingBlock}. */
export function isEncryptedThinkingBlock(c: unknown): c is EncryptedThinkingBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'thinking'
    && 'thinking' in c && c.thinking === ''
    && 'signature' in c && typeof c.signature === 'string';
}

/**
 * The turn was served by a different model than the one it started on.
 * Measured 2026-07-26: 16 blocks in the local corpus, every one of them a
 * downgrade away from `claude-fable-5`. A hermetic run has to surface this —
 * the model silently changing underneath a run breaks reproducibility.
 */
export interface FallbackBlock {
  type: 'fallback';
  from: { model: string; };
  to: { model: string; };
}

/** Recognizes a {@link FallbackBlock}. */
export function isFallbackBlock(c: unknown): c is FallbackBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'fallback'
    && 'from' in c && c.from !== null && typeof c.from === 'object'
    && 'model' in c.from && typeof c.from.model === 'string'
    && 'to' in c && c.to !== null && typeof c.to === 'object'
    && 'model' in c.to && typeof c.to.model === 'string';
}

/** A `Bash` tool call. */
export interface BashBlock {
  type: 'tool_use';
  name: 'Bash';
  input: { command: string; description?: string; };
}

/** Recognizes a {@link BashBlock}. */
export function isBashBlock(c: unknown): c is BashBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'Bash'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'command' in c.input && typeof c.input.command === 'string'
    && (!('description' in c.input) || typeof c.input.description === 'string');
}

/** A `Write` tool call. */
export interface WriteBlock {
  type: 'tool_use';
  name: 'Write';
  input: { file_path: string; content: string; };
}

/** Recognizes a {@link WriteBlock}. */
export function isWriteBlock(c: unknown): c is WriteBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'Write'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'file_path' in c.input && typeof c.input.file_path === 'string'
    && 'content' in c.input && typeof c.input.content === 'string';
}

/**
 * A `Read` tool call. Carries only the path: the file text arrives later, in
 * the paired `tool_result`, which is why the renderer keeps a pairing table.
 */
export interface ReadBlock {
  type: 'tool_use';
  name: 'Read';
  input: { file_path: string; };
}

/** Recognizes a {@link ReadBlock}. */
export function isReadBlock(c: unknown): c is ReadBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'Read'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'file_path' in c.input && typeof c.input.file_path === 'string';
}

/** An `Edit` tool call. */
export interface EditBlock {
  type: 'tool_use';
  name: 'Edit';
  input: { file_path: string; old_string: string; new_string: string; replace_all?: boolean; };
}

/** Recognizes an {@link EditBlock}. */
export function isEditBlock(c: unknown): c is EditBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'Edit'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'file_path' in c.input && typeof c.input.file_path === 'string'
    && 'old_string' in c.input && typeof c.input.old_string === 'string'
    && 'new_string' in c.input && typeof c.input.new_string === 'string'
    && (!('replace_all' in c.input) || typeof c.input.replace_all === 'boolean');
}

/** A `Skill` invocation. */
export interface SkillBlock {
  type: 'tool_use';
  name: 'Skill';
  input: { skill: string; args?: string; };
}

/** Recognizes a {@link SkillBlock}. */
export function isSkillBlock(c: unknown): c is SkillBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'Skill'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'skill' in c.input && typeof c.input.skill === 'string'
    && (!('args' in c.input) || typeof c.input.args === 'string');
}

/** An `Agent` (subagent launch) tool call. */
export interface AgentBlock {
  type: 'tool_use';
  name: 'Agent';
  input: { description: string; subagent_type?: string; prompt: string; model?: string; };
}

/** Recognizes an {@link AgentBlock}. */
export function isAgentBlock(c: unknown): c is AgentBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'Agent'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'description' in c.input && typeof c.input.description === 'string'
    && (!('subagent_type' in c.input) || typeof c.input.subagent_type === 'string')
    && 'prompt' in c.input && typeof c.input.prompt === 'string'
    && (!('model' in c.input) || typeof c.input.model === 'string');
}

/** A `ToolSearch` tool call (deferred-tool schema lookup). */
export interface ToolSearchBlock {
  type: 'tool_use';
  name: 'ToolSearch';
  input: { query: string; };
}

/** Recognizes a {@link ToolSearchBlock}. */
export function isToolSearchBlock(c: unknown): c is ToolSearchBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'ToolSearch'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'query' in c.input && typeof c.input.query === 'string';
}

/** A `Grep` tool call. */
export interface GrepBlock {
  type: 'tool_use';
  name: 'Grep';
  input: { pattern: string; path?: string; output_mode?: string; };
}

/** Recognizes a {@link GrepBlock}. */
export function isGrepBlock(c: unknown): c is GrepBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'Grep'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'pattern' in c.input && typeof c.input.pattern === 'string'
    && (!('path' in c.input) || typeof c.input.path === 'string')
    && (!('output_mode' in c.input) || typeof c.input.output_mode === 'string');
}

/** An `AskUserQuestion` tool call. */
export interface AskUserQuestionBlock {
  type: 'tool_use';
  name: 'AskUserQuestion';
  input: {
    questions: {
      question: string;
      header: string;
      options: {
        label: string;
        description: string;
      }[];
    }[];
  };
}

/** Recognizes an {@link AskUserQuestionBlock}. */
export function isAskUserQuestionBlock(c: unknown): c is AskUserQuestionBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'AskUserQuestion'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'questions' in c.input && Array.isArray(c.input.questions)
    && c.input.questions.every(
      (q: unknown) => q !== null && typeof q === 'object'
        && 'question' in q && typeof q.question === 'string'
        && 'header' in q && typeof q.header === 'string'
        && 'options' in q && Array.isArray(q.options)
        && q.options.every(
          (o: unknown) => o !== null && typeof o === 'object'
            && 'label' in o && typeof o.label === 'string'
            && 'description' in o && typeof o.description === 'string'
        )
    );
}

/** A `TaskCreate` tool call. */
export interface TaskCreateBlock {
  type: 'tool_use';
  name: 'TaskCreate';
  input: {
    subject: string;
    description: string;
    activeForm: string;
  };
}

/** Recognizes a {@link TaskCreateBlock}. */
export function isTaskCreateBlock(c: unknown): c is TaskCreateBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'TaskCreate'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'subject' in c.input && typeof c.input.subject === 'string'
    && 'description' in c.input && typeof c.input.description === 'string'
    && 'activeForm' in c.input && typeof c.input.activeForm === 'string';
}

/**
 * A `TaskUpdate` tool call. `taskId` is the only field every call carries.
 * Measured 2026-07-26 over the local corpus: a call updates exactly one of
 * `status`, `addBlockedBy`, or `description` at a time (64, 6, and 1 calls
 * respectively) — never more than one alongside `taskId`, but the type
 * allows any combination since nothing rules a future call out.
 */
export interface TaskUpdateBlock {
  type: 'tool_use';
  name: 'TaskUpdate';
  input: {
    taskId: string;
    status?: string;
    addBlockedBy?: string[];
    description?: string;
  };
}

/** Recognizes a {@link TaskUpdateBlock}. */
export function isTaskUpdateBlock(c: unknown): c is TaskUpdateBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'TaskUpdate'
    && 'input' in c && c.input !== null && typeof c.input === 'object'
    && 'taskId' in c.input && typeof c.input.taskId === 'string'
    && (!('status' in c.input) || typeof c.input.status === 'string')
    && (!('addBlockedBy' in c.input) || (
      Array.isArray(c.input.addBlockedBy)
      && c.input.addBlockedBy.every((b: unknown) => typeof b === 'string')
    ))
    && (!('description' in c.input) || typeof c.input.description === 'string');
}

/** An `ExitPlanMode` tool call. */
export interface ExitPlanModeBlock {
  type: 'tool_use';
  name: 'ExitPlanMode';
  input: object;
}

/** Recognizes an {@link ExitPlanModeBlock}. */
export function isExitPlanModeBlock(c: unknown): c is ExitPlanModeBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'ExitPlanMode'
    && 'input' in c && c.input !== null && typeof c.input === 'object';
}

/** An `EnterPlanMode` tool call. */
export interface EnterPlanModeBlock {
  type: 'tool_use';
  name: 'EnterPlanMode';
  input: object;
}

/** Recognizes an {@link EnterPlanModeBlock}. */
export function isEnterPlanModeBlock(c: unknown): c is EnterPlanModeBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && c.name === 'EnterPlanMode'
    && 'input' in c && c.input !== null && typeof c.input === 'object';
}

/**
 * Any tool call at all, whatever its name and whatever its input.
 *
 * The renderer keeps this last in its table, so it only ever fires for a call
 * the specific guards above turned down. That is deliberately broader than
 * "a tool we do not know": measured 2026-07-26, 2 calls in the local corpus
 * name a *known* tool but carry input its guard rejects — both a `Read` whose
 * arguments arrived as `input.__unparsedToolInput` because the model emitted
 * invalid JSON. (A `TaskUpdate` missing `status` used to be 7 more of these;
 * {@link isTaskUpdateBlock} now accepts the partial update instead.) An
 * exclusion list keyed on the name rendered every one of them as nothing;
 * ordering catches them and prints the input the model actually sent.
 */
export interface AnyToolUseBlock {
  type: 'tool_use';
  name: string;
  input: object;
}

/** Recognizes an {@link AnyToolUseBlock}. */
export function isAnyToolUseBlock(c: unknown): c is AnyToolUseBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'name' in c && typeof c.name === 'string'
    && 'input' in c && c.input !== null && typeof c.input === 'object';
}

/**
 * Any `tool_use` block that carries the `id` a later `tool_result` refers back
 * to. A pairing helper, not a display shape: `display.ts` walks it to learn
 * which tool produced which result, and never renders it directly.
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: object;
}

/** Recognizes a {@link ToolUseBlock}. */
export function isToolUseBlock(c: unknown): c is ToolUseBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_use'
    && 'id' in c && typeof c.id === 'string'
    && 'name' in c && typeof c.name === 'string'
    && 'input' in c && c.input !== null && typeof c.input === 'object';
}

// ─────────────────────────────────────────────────────────────────────────────
// Content blocks: user
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tool result whose payload is a plain string — 27 487 of 28 217 measured
 * `tool_result` blocks.
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content: string;
}

/** Recognizes a {@link ToolResultBlock}. */
export function isToolResultBlock(c: unknown): c is ToolResultBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_result'
    && (!('tool_use_id' in c) || typeof c.tool_use_id === 'string')
    && 'content' in c && typeof c.content === 'string';
}

/** A tool result whose payload is an array of text blocks. */
export interface ToolResultTextBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content: TextBlock[];
}

/** Recognizes a {@link ToolResultTextBlock}. */
export function isToolResultTextBlock(c: unknown): c is ToolResultTextBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_result'
    && (!('tool_use_id' in c) || typeof c.tool_use_id === 'string')
    && 'content' in c && Array.isArray(c.content) && c.content.length > 0
    && c.content.every(
      (cc: unknown) => cc !== null && typeof cc === 'object'
        && 'type' in cc && cc.type === 'text'
        && 'text' in cc && typeof cc.text === 'string'
    );
}

/**
 * A tool result whose payload is an array of images — a screenshot coming back
 * from a browser or vision tool.
 */
export interface ToolResultImageBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content: ImageBlock[];
}

/** Recognizes a {@link ToolResultImageBlock}. */
export function isToolResultImageBlock(c: unknown): c is ToolResultImageBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_result'
    && (!('tool_use_id' in c) || typeof c.tool_use_id === 'string')
    && 'content' in c && Array.isArray(c.content) && c.content.length > 0
    && c.content.every(isImageBlock);
}

/**
 * A tool result naming other tools — what `ToolSearch` returns when it loads
 * deferred tool schemas.
 */
export interface ToolReferenceBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content: {
    type: 'tool_reference';
    tool_name: string;
  }[];
}

/** Recognizes a {@link ToolReferenceBlock}. */
export function isToolReferenceBlock(c: unknown): c is ToolReferenceBlock {
  return c !== null && typeof c === 'object'
    && 'type' in c && c.type === 'tool_result'
    && (!('tool_use_id' in c) || typeof c.tool_use_id === 'string')
    && 'content' in c && Array.isArray(c.content) && c.content.length > 0
    && c.content.every(
      (cc: unknown) => cc !== null && typeof cc === 'object'
        && 'type' in cc && cc.type === 'tool_reference'
        && 'tool_name' in cc && typeof cc.tool_name === 'string'
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Message envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The envelope of an `assistant` or `user` record whose `message.content` is a
 * block array. The blocks stay `unknown` on purpose: this guard exists so the
 * renderer can reach them and dispatch each through its own guard, which is
 * exactly the boundary at which `unknown` is the honest type.
 */
export interface BlockMessage {
  type: 'assistant' | 'user';
  message: {
    model?: string;
    content: unknown[];
  };
}

/** Recognizes a {@link BlockMessage}. */
export function isBlockMessage(e: unknown): e is BlockMessage {
  return e !== null && typeof e === 'object'
    && 'type' in e && (e.type === 'assistant' || e.type === 'user')
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || typeof e.message.model === 'string')
    && 'content' in e.message && Array.isArray(e.message.content);
}

/**
 * Claude Code's marker for assistant content it fabricated rather than
 * received from the model — API-error notices, and the preloaded turns
 * `SessionBuilder` writes. 157 records in the measured corpus.
 */
export const syntheticModel = '<synthetic>';

// ─────────────────────────────────────────────────────────────────────────────
// Standalone events
// ─────────────────────────────────────────────────────────────────────────────

/** A working-copy file-history snapshot. */
export interface FileHistorySnapshot {
  type: 'file-history-snapshot';
}

// TODO: This code might benefit from arktype, valibot, or even zod.
/** Recognizes a {@link FileHistorySnapshot}. */
export function isFileHistorySnapshot(e: unknown): e is FileHistorySnapshot {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'file-history-snapshot';
}

/**
 * One tracked file's change against the last snapshot. 663 records measured;
 * `trackingPath` is the file the delta is for.
 */
export interface FileHistoryDelta {
  type: 'file-history-delta';
  trackingPath: string;
}

/** Recognizes a {@link FileHistoryDelta}. */
export function isFileHistoryDelta(e: unknown): e is FileHistoryDelta {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'file-history-delta'
    && 'trackingPath' in e && typeof e.trackingPath === 'string';
}

/** The session's permission mode: `default`, `acceptEdits`, `plan`, `bypassPermissions`. */
export interface PermissionMode {
  type: 'permission-mode';
  permissionMode: string;
}

// TODO: This code might benefit from arktype, valibot, or even zod.
/** Recognizes a {@link PermissionMode}. */
export function isPermissionMode(e: unknown): e is PermissionMode {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'permission-mode'
    && 'permissionMode' in e && typeof e.permissionMode === 'string';
}

/**
 * The session's interaction mode, distinct from the permission mode.
 * Introduced by 2.1.220; 2 231 records measured, every one of them `normal`.
 */
export interface Mode {
  type: 'mode';
  mode: string;
}

/** Recognizes a {@link Mode}. */
export function isMode(e: unknown): e is Mode {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'mode'
    && 'mode' in e && typeof e.mode === 'string';
}

/**
 * Which agent definition drives the session. 219 records measured, every one
 * of them `claude`.
 */
export interface AgentSetting {
  type: 'agent-setting';
  agentSetting: string;
}

/** Recognizes an {@link AgentSetting}. */
export function isAgentSetting(e: unknown): e is AgentSetting {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'agent-setting'
    && 'agentSetting' in e && typeof e.agentSetting === 'string';
}

/** The most recent user prompt, recorded out of band. */
export interface LastPrompt {
  type: 'last-prompt';
  lastPrompt: string;
}

/** Recognizes a {@link LastPrompt}. */
export function isLastPrompt(e: unknown): e is LastPrompt {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'last-prompt'
    && 'lastPrompt' in e && typeof e.lastPrompt === 'string';
}

/** A message queued mid-turn. */
export interface EnqueueOperation {
  type: 'queue-operation';
  operation: 'enqueue';
  content: string;
}

/** Recognizes an {@link EnqueueOperation}. */
export function isEnqueueOperation(e: unknown): e is EnqueueOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'enqueue'
    && 'content' in e && typeof e.content === 'string';
}

/** A queued message consumed. */
export interface DequeueOperation {
  type: 'queue-operation';
  operation: 'dequeue';
}

/** Recognizes a {@link DequeueOperation}. */
export function isDequeueOperation(e: unknown): e is DequeueOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'dequeue';
}

/** A queued message dropped without being consumed. */
export interface RemoveOperation {
  type: 'queue-operation';
  operation: 'remove';
}

/** Recognizes a {@link RemoveOperation}. */
export function isRemoveOperation(e: unknown): e is RemoveOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'remove';
}

/** The whole queue flushed at once. */
export interface PopAllOperation {
  type: 'queue-operation';
  operation: 'popAll';
  content: string;
}

/** Recognizes a {@link PopAllOperation}. */
export function isPopAllOperation(e: unknown): e is PopAllOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'popAll'
    && 'content' in e && typeof e.content === 'string';
}

/**
 * A session title the user set by hand. Zero records in the measured corpus —
 * Claude Code writes {@link AiTitle} instead unless the title is explicit.
 */
export interface CustomTitle {
  type: 'custom-title';
  customTitle: string;
}

/** Recognizes a {@link CustomTitle}. */
export function isCustomTitle(e: unknown): e is CustomTitle {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'custom-title'
    && 'customTitle' in e && typeof e.customTitle === 'string';
}

/**
 * The session title Claude Code generated. 2 272 records measured — the shape
 * a real transcript actually carries, and the reason {@link CustomTitle} alone
 * left every session unlabelled.
 */
export interface AiTitle {
  type: 'ai-title';
  aiTitle: string;
}

/** Recognizes an {@link AiTitle}. */
export function isAiTitle(e: unknown): e is AiTitle {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'ai-title'
    && 'aiTitle' in e && typeof e.aiTitle === 'string';
}

/** The name of the (sub)agent running the turn. */
export interface AgentName {
  type: 'agent-name';
  agentName: string;
}

/** Recognizes an {@link AgentName}. */
export function isAgentName(e: unknown): e is AgentName {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'agent-name'
    && 'agentName' in e && typeof e.agentName === 'string';
}

/** End-of-turn timing statistics. */
export interface TurnDuration {
  type: 'system';
  subtype: 'turn_duration';
  durationMs: number;
  messageCount: number;
  timestamp: string;
}

/** Recognizes a {@link TurnDuration}. */
export function isTurnDuration(e: unknown): e is TurnDuration {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'system'
    && 'subtype' in e && e.subtype === 'turn_duration'
    && 'durationMs' in e && typeof e.durationMs === 'number'
    && 'messageCount' in e && typeof e.messageCount === 'number'
    && 'timestamp' in e && typeof e.timestamp === 'string';
}

/** The provider returned an error during the turn. */
export interface ApiError {
  type: 'system';
  subtype: 'api_error';
}

/** Recognizes an {@link ApiError}. */
export function isApiError(e: unknown): e is ApiError {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'system'
    && 'subtype' in e && e.subtype === 'api_error';
}

// TODO: This should be grouped by the tool_use_id in the output

/** A user message whose content is a bare string rather than a block array. */
export interface UserText {
  type: 'user';
  message: {
    content: string;
  };
}

/** Recognizes a {@link UserText}. */
export function isUserText(e: unknown): e is UserText {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && typeof e.message.content === 'string';
}

/** A skills catalog attached to context. */
export interface SkillListingAttachment {
  type: 'attachment';
  attachment: {
    type: 'skill_listing';
    content: string;
  };
}

/** Recognizes a {@link SkillListingAttachment}. */
export function isSkillListingAttachment(e: unknown): e is SkillListingAttachment {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'attachment'
    && 'attachment' in e && e.attachment !== null && typeof e.attachment === 'object'
    && 'type' in e.attachment && e.attachment.type === 'skill_listing'
    && 'content' in e.attachment && typeof e.attachment.content === 'string';
}

/** A slash command declaring the tools it is allowed to use. */
export interface CommandPermissionsAttachment {
  type: 'attachment';
  attachment: {
    type: 'command_permissions';
    allowedTools: string[];
  };
}

/** Recognizes a {@link CommandPermissionsAttachment}. */
export function isCommandPermissionsAttachment(e: unknown): e is CommandPermissionsAttachment {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'attachment'
    && 'attachment' in e && e.attachment !== null && typeof e.attachment === 'object'
    && 'type' in e.attachment && e.attachment.type === 'command_permissions'
    && 'allowedTools' in e.attachment && Array.isArray(e.attachment.allowedTools)
    && e.attachment.allowedTools.every(t => typeof t === 'string');
}

// ─────────────────────────────────────────────────────────────────────────────
// Unions
// ─────────────────────────────────────────────────────────────────────────────

/** Every content block shape an `assistant` record's `message.content` can hold. */
export type AssistantContentBlock =
  | TextBlock
  | ThinkingBlock
  | EncryptedThinkingBlock
  | FallbackBlock
  | BashBlock
  | WriteBlock
  | ReadBlock
  | EditBlock
  | SkillBlock
  | AgentBlock
  | ToolSearchBlock
  | GrepBlock
  | AskUserQuestionBlock
  | TaskCreateBlock
  | TaskUpdateBlock
  | EnterPlanModeBlock
  | ExitPlanModeBlock
  | AnyToolUseBlock;

/** Every content block shape a `user` record's `message.content` array can hold. */
export type UserContentBlock =
  | TextBlock
  | ImageBlock
  | ToolResultBlock
  | ToolResultTextBlock
  | ToolResultImageBlock
  | ToolReferenceBlock;

/** An `assistant` record. */
export interface AssistantEvent {
  type: 'assistant';
  message: {
    model?: string;
    content: AssistantContentBlock[];
  };
}

/** A `user` record, whether its content is a bare string or a block array. */
export interface UserEvent {
  type: 'user';
  message: {
    content: string | UserContentBlock[];
  };
}

/** Every session NDJSON record shape this library recognizes. */
export type SessionEvent =
  | FileHistorySnapshot
  | FileHistoryDelta
  | PermissionMode
  | Mode
  | AgentSetting
  | LastPrompt
  | EnqueueOperation
  | DequeueOperation
  | RemoveOperation
  | PopAllOperation
  | CustomTitle
  | AiTitle
  | AgentName
  | TurnDuration
  | ApiError
  | AssistantEvent
  | UserEvent
  | SkillListingAttachment
  | CommandPermissionsAttachment;
