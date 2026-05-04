import * as Bun from 'bun';

import path from 'node:path';

import type { SessionEvent } from '@agladysh/bare-claude/events';

// TODO: Provide concrete types instead?
type ExtendableRecord<T> = T & Record<string, any>;
type DeepExtendable<T> = T extends object
  ? ExtendableRecord<{
      [K in keyof T]: DeepExtendable<T[K]>;
    }>
  : T;

export class SessionBuilder {
  readonly now = () => (new Date).toISOString();

  private cwd: string;

  private lastMessageUuid: string | null = null;
  private lastMessageId: string | null = null;
  private lastPrompt: string | undefined = undefined;
  private buf: DeepExtendable<SessionEvent>[] = [];

  constructor(
    readonly sessionId: string,
    readonly version: string,
    cwdPath: string,
    readonly gitBranch: string,
    readonly modelId: string
  ) {
    this.cwd = path.resolve(cwdPath);
    this.emitPrologue();
  }

  commit() {
    return this.emitEpilogue().buf;
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
      permissionMode, // TODO: We should provide abstraction to switch permission modes so it is consistent
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
    });
    return this;
  }

  emitRead(filePath: string, content: string) {
    const parentUuid = this.lastMessageUuid;
    this.nextMessageId(); // Generate UUID for this assistant message
    const assistantUuid = this.lastMessageUuid;
    const tooluId = `toolu_${Bun.randomUUIDv7('base64url')}`;

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
          input: { file_path: filePath }, // Path as is
          caller: { type: 'direct' },
        }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 }, // We fake usage for now
      },
      // We do not provide requestId for now, as we did not make any requests
      type: 'assistant',
      uuid: this.lastMessageUuid,
      timestamp: this.now(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: this.version,
      gitBranch: this.gitBranch,
    });

    this.nextMessageId();

    const lines = content.split('\n');
    const numLines = lines.length;
    const prefixedContent = lines.flatMap((l, i) => [ i.toString().padEnd(6, ' '), l, '\n' ]).join('');

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
          content: prefixedContent,
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
      version: this.version,
      gitBranch: this.gitBranch,
    });

    return this;
  }

  // TODO: DRY with the emitRead()
  async emitBash(
    command: string,
    description: string,
    result: { stdout: unknown; stderr: unknown; exitCode: number; }
  ) {
    const parentUuid = this.lastMessageUuid;
    this.nextMessageId(); // Generate UUID for this assistant message
    const assistantUuid = this.lastMessageUuid;
    const tooluId = `call_function_${Bun.randomUUIDv7('base64url')}`;
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
        }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 }, // We fake usage for now
      },
      // We do not provide requestId for now, as we did not make any requests
      type: 'assistant',
      uuid: this.lastMessageUuid,
      timestamp: this.now(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: this.cwd,
      sessionId: this.sessionId,
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
    this.lastMessageId = `msg_${Bun.randomUUIDv7('base64url')}`; // TODO: Does Claude Code use same UUIDs as in parent UUID or independed IDs as here?
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
        sessionId: this.sessionId,
      });
    }
    return this;
  }
}
