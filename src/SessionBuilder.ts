import * as Bun from 'bun';

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { SessionEvent } from '@agladysh/bare-claude/events';

// TODO: Provide concrete types instead?
type ExtendableRecord<T> = T & Record<string, any>;
type DeepExtendable<T> = T extends object
  ? ExtendableRecord<{
      [K in keyof T]: DeepExtendable<T[K]>;
    }>
  : T;

const base62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * An Anthropic-style opaque id: a prefix plus `length` base62 characters.
 *
 * Measured 2026-07-26 over `~/.claude/projects`: all 12 113 distinct
 * `message.id`s are `msg_` plus exactly 24 base62 characters, and all 16 937
 * `tool_use` ids are `toolu_` plus exactly 24 — not one contains `-` or `_`
 * after the prefix. `Bun.randomUUIDv7('base64url')` yields 22 characters from
 * an alphabet that includes both, so it cannot produce a well-formed id.
 */
function anthropicId(prefix: string, length: number = 24): string {
  let id = '';
  while (id.length < length) {
    for (const byte of randomBytes(length - id.length)) {
      // 248 = 4 * 62. Bytes at or above it would bias `% 62` toward `0`–`7`.
      if (byte < 248) {
        id += base62.charAt(byte % 62);
      }
    }
  }
  return `${prefix}${id}`;
}

/**
 * Claude Code's own zero-usage constant, reproduced field for field from the
 * 2.1.220 bundle (measured 2026-07-26). It is what Claude Code itself writes
 * for a turn that consumed no API usage, which is exactly what a fabricated
 * turn is.
 *
 * Zeros, not ones. On resume Claude Code takes the *last* assistant record's
 * usage and treats `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens === 0` as "no measurement — fall back to my own
 * estimate"; any nonzero total is believed verbatim, so the old
 * `{input_tokens: 1, output_tokens: 1}` claimed a 1-token context and fed the
 * auto-compaction threshold a lie. The turn also enters cost accounting —
 * Claude Code excludes only the `<synthetic>` model marker, which this builder
 * deliberately does not use — so zeros keep `/cost` honest too.
 *
 * A fresh object per call: `commit()` hands these records to the caller.
 */
function zeroUsage() {
  return {
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
  };
}

export class SessionBuilder {
  readonly now = () => (new Date).toISOString();

  private cwd: string;

  private lastMessageUuid: string | null = null;
  private lastMessageId: string | null = null;
  private lastPrompt: string | undefined = undefined;
  private buf: DeepExtendable<SessionEvent>[] = [];

  /**
   * @param sessionId - Session UUID; the transcript's filename stem.
   * @param version - `claude --version`, without the ` (Claude Code)` suffix.
   * @param cwdPath - Working directory the turns claim to have run in.
   * @param gitBranch - Branch name recorded on every turn.
   * @param modelId - Model the fabricated assistant turns are attributed to.
   *   Never `<synthetic>`: Claude Code reserves that marker for API-error
   *   messages, excludes it from usage and cost accounting, and every
   *   assistant display rule drops it.
   * @param effort - Effort level stamped on every assistant record. Real
   *   records carry one (`low`/`medium`/`high`/`xhigh`/`max`); defaults to
   *   `high`, matching `resolveConfig`'s `effortLevel` default.
   */
  constructor(
    readonly sessionId: string,
    readonly version: string,
    cwdPath: string,
    readonly gitBranch: string,
    readonly modelId: string,
    readonly effort: string = 'high'
  ) {
    this.cwd = path.resolve(cwdPath);
    this.emitPrologue();
  }

  /**
   * Seals the session and returns its events.
   * @param maxBytes - Raw-content budget the caller enforced while building.
   *   When given, a session serializing to more than twice it warns: that
   *   signals pathological JSON escaping or binary that slipped the content
   *   accounting. Never aborts — the real limit is enforced as entries are
   *   added, not here.
   */
  commit(maxBytes?: number) {
    const events = this.emitEpilogue().buf;

    if (maxBytes !== undefined) {
      const bytes = Buffer.byteLength(events.map(e => JSON.stringify(e)).join('\n'), 'utf8');
      if (bytes > maxBytes * 2) {
        process.stderr.write(
          `SessionBuilder: serialized session is ${bytes} bytes, over 2x the `
          + `${maxBytes}-byte content budget (pathological escaping or binary?); proceeding.\n`
        );
      }
    }

    return events;
  }

  emitUser(content: string, permissionMode: string = 'default') {
    const parentUuid = this.lastMessageUuid;
    this.nextMessageId();
    this.buf.push({
      parentUuid,
      isSidechain: false,
      promptId: Bun.randomUUIDv7(),
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      uuid: this.lastMessageUuid,
      timestamp: this.now(),
      // The three fields that mark a record as a human prompt rather than a
      // tool result. Measured 2026-07-26: all 391 non-sidechain user records
      // carrying `origin` also carry `permissionMode` and `promptSource`, and
      // none of them carries `session_id`; the 3 100 tool-result user records
      // are the exact mirror image. `typed` is also Claude Code's own default
      // when a prompt arrives without a source.
      origin: { kind: 'human' },
      promptSource: 'typed',
      permissionMode, // TODO: We should provide abstraction to switch permission modes so it is consistent
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
    });
    this.lastPrompt = content; // So the epilogue's last-prompt event is real.
    return this;
  }

  /**
   * Emits a plain assistant text turn.
   * @param text - The assistant's message
   */
  emitAssistant(text: string) {
    const parentUuid = this.lastMessageUuid;
    this.nextMessageId();
    this.buf.push({
      parentUuid,
      isSidechain: false,
      message: {
        model: this.modelId,
        id: this.lastMessageId,
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'text',
          text,
        }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        diagnostics: null,
        usage: zeroUsage(),
      },
      // We do not provide requestId, as we did not make any requests
      type: 'assistant',
      uuid: this.lastMessageUuid,
      timestamp: this.now(),
      effort: this.effort,
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      session_id: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
    });
    return this;
  }

  /**
   * Emits a framing context entry: a user message carrying `# <header>` and the
   * content, acknowledged by an assistant echo. The home for preloaded context
   * that is neither a file nor a command. Reads as a plain conversation turn,
   * so the same display rules and guards catch it.
   * @param header - Title for the content
   * @param content - The content itself
   * @param ack - What the assistant answers, acknowledging it
   */
  emitContext(header: string, content: string, ack: string) {
    return this
      .emitUser(`# ${header}\n\n${content}`)
      .emitAssistant(ack);
  }

  emitRead(filePath: string, content: string) {
    const parentUuid = this.lastMessageUuid;
    this.nextMessageId(); // Generate UUID for this assistant message
    const assistantUuid = this.lastMessageUuid;
    const tooluId = anthropicId('toolu_');

    this.buf.push({
      parentUuid,
      isSidechain: false,
      message: {
        model: this.modelId,
        id: this.lastMessageId,
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: tooluId,
          name: 'Read',
          // The path as the caller wrote it, deliberately. Real Claude Code
          // always writes an absolute path here (5 171 of 5 171 Read calls
          // measured 2026-07-26), but this is the one field of the record the
          // *model* reads, and `--read` names files git-relative. Safe because
          // the Read tool schema is a bare string and Claude Code normalizes a
          // relative path against cwd; `toolUseResult.file.filePath`, which its
          // own machinery keys on, is absolute below. Pass an absolute path if
          // you want byte fidelity.
          input: { file_path: filePath },
          caller: { type: 'direct' },
        }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        stop_details: null,
        diagnostics: null,
        usage: zeroUsage(),
      },
      // We do not provide requestId for now, as we did not make any requests
      type: 'assistant',
      uuid: this.lastMessageUuid,
      timestamp: this.now(),
      effort: this.effort,
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      session_id: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
    });

    this.nextMessageId();

    const lines = content.split('\n');
    const numLines = lines.length;
    // Real Read results are `1\t<line>`: 1-based, one tab, no padding. Claude
    // Code strips the prefix back off with /^\s*\d+[→\t:](.*)$/, so any
    // other shape both misnumbers every line and defeats un-numbering.
    const prefixedContent = lines.flatMap((l, i) => [ `${i + 1}\t`, l, '\n' ]).join('');

    this.buf.push({
      parentUuid: assistantUuid,
      isSidechain: false,
      promptId: Bun.randomUUIDv7(),
      type: 'user',
      message: {
        role: 'user',
        content: [{
          tool_use_id: tooluId,
          type: 'tool_result',
          content: prefixedContent,
        }],
      },
      uuid: this.lastMessageUuid,
      timestamp: this.now(),
      toolUseResult: {
        type: 'text',
        file: {
          filePath: path.resolve(filePath), // Absolute path
          content, // Raw, as real records store it; only the tool_result is numbered.
          numLines,
          startLine: 1,
          totalLines: numLines,
        },
      },
      sourceToolAssistantUUID: assistantUuid,
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      session_id: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
    });

    return this;
  }

  // TODO: DRY with the emitRead()
  emitBash(
    command: string,
    description: string,
    result: { stdout: unknown; stderr: unknown; exitCode: number; }
  ) {
    const parentUuid = this.lastMessageUuid;
    this.nextMessageId(); // Generate UUID for this assistant message
    const assistantUuid = this.lastMessageUuid;
    const tooluId = anthropicId('toolu_');
    this.buf.push({
      parentUuid,
      isSidechain: false,
      message: {
        model: this.modelId,
        id: this.lastMessageId,
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: tooluId,
          name: 'Bash',
          input: { command, description },
          caller: { type: 'direct' },
        }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        stop_details: null,
        diagnostics: null,
        usage: zeroUsage(),
      },
      // We do not provide requestId for now, as we did not make any requests
      type: 'assistant',
      uuid: this.lastMessageUuid,
      timestamp: this.now(),
      effort: this.effort,
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      session_id: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
    });

    this.nextMessageId();

    this.buf.push({
      parentUuid: assistantUuid,
      isSidechain: false,
      promptId: Bun.randomUUIDv7(),
      type: 'user',
      message: {
        role: 'user',
        content: [{
          tool_use_id: tooluId,
          type: 'tool_result',
          content: String(result.stdout), // TODO: Or is it stdout + stderr? Check and fix.
          is_error: result.exitCode !== 0,
        }],
      },
      uuid: this.lastMessageUuid,
      timestamp: this.now(),
      toolUseResult: {
        stdout: String(result.stdout),
        stderr: String(result.stderr),
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
      sourceToolAssistantUUID: assistantUuid,
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      session_id: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
    });

    return this;
  }

  emitPermissionMode(permissionMode: string = 'default') {
    this.buf.push({ type: 'permission-mode', permissionMode, sessionId: this.sessionId });
    return this;
  }

  private nextMessageId() {
    this.lastMessageUuid = Bun.randomUUIDv7();
    this.lastMessageId = anthropicId('msg_');
    return this.lastMessageId;
  }

  private emitPrologue() {
    return this
      .emitPermissionMode('default')
      .emitFileHistorySnapshot();
  }

  // Not sealing the object for now, as we don't emit nothing truly final.
  private emitEpilogue() {
    return this
      .emitLastPrompt()
      .emitPermissionMode('default');
  }

  private emitFileHistorySnapshot() {
    const messageId = Bun.randomUUIDv7(); // Weirdly, this does not participate in a message chain nor create one.
    this.buf.push({
      type: 'file-history-snapshot',
      messageId,
      snapshot: {
        messageId,
        trackedFileBackups: {},
        timestamp: this.now(),
      },
      isSnapshotUpdate: false,
    });
    return this;
  }

  private emitLastPrompt(lastPrompt: string | undefined = this.lastPrompt) {
    if (lastPrompt !== undefined) {
      this.buf.push({
        type: 'last-prompt',
        lastPrompt,
        // The head of the message chain this prompt left behind. Claude Code
        // collects every `last-prompt` leafUuid while loading a transcript and
        // prefers one of them when choosing where a `--resume` continues from;
        // without it, it falls back to scanning for records no other record
        // parents. Our chain is linear, so both routes agree — but only if we
        // point at the genuine last message. All 1 050 real `last-prompt`
        // records measured 2026-07-26 carry a leafUuid, 3 of them with a null
        // `lastPrompt`.
        leafUuid: this.lastMessageUuid,
        sessionId: this.sessionId,
      });
    }
    return this;
  }
}
