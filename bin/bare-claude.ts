#!/usr/bin/env bun

import { parseArgs } from 'node:util';
import path from 'node:path';
import { watch } from 'node:fs/promises';

import TailFile from '@logdna/tail-file';

import { Launchers, spawnClaude, type JsonObject, type Launcher } from 'bare-claude';

import pkg from '../package.json';

///////////////////////////////////////////////////////////////////////////////
// TODO: Move this to a dedicated module
// TODO: This needs nicer formatting

function truncateLine(str: string, max: number = 80) {
  if (str.length <= max) {
    return str;
  }
  return str.slice(0, max - 3) + '...';
}

function truncateText(str: string, maxLines: number = 16) {
  const lines = str.split("\n");
  if (lines.length <= maxLines) {
    return lines;
  }
  const headLength = Math.floor(maxLines / 2);
  const tailLength = maxLines - headLength;
  const head = lines.slice(0, headLength);
  const tail = lines.slice(-tailLength);
  return [...head, `... [${lines.length - head.length - tail.length} lines truncated] ...`, ...tail];
}

interface RuleOptions {
  verbose: boolean;
  debug: boolean;
}

type Rule = (e: unknown, o: RuleOptions) => string | null;

function Rule<T>(guard: (e: unknown) => e is T, run: (e: T, o: RuleOptions) => string): Rule {
  return (e: unknown, o: RuleOptions) => {
    if (!guard(e)) {
      return null;
    }
    return (!o.debug) ? run(e, o) : '';
  }
}

function Verbose<T>(guard: (e: unknown) => e is T, run: (e: T, o: RuleOptions) => string): Rule {
  return (e: unknown, o: RuleOptions) => {
    if (!o.verbose || !guard(e)) {
      return null;
    }
    return (!o.debug) ? run(e, o) : '';
  }
}

function Debug<T>(guard: (e: unknown) => e is T, run: (e: T, o: RuleOptions) => string): Rule {
  return (e: unknown, o: RuleOptions) => {
    if (!guard(e)) {
      return null;
    }
    return run(e, o); // No debug guard
  }
}

function VerboseDebug<T>(guard: (e: unknown) => e is T, run: (e: T, o: RuleOptions) => string): Rule {
  return (e: unknown, o: RuleOptions) => {
    if (!o.verbose || !guard(e)) {
      return null;
    }
    return run(e, o); // No debug guard
  }
}

interface FileHistorySnapshot {
  type: 'file-history-snapshot';
  lastPrompt: string;
}

// TODO: This code might benefit from arktype, valibot, or even zod.
function isFileHistorySnapshot(e: unknown): e is FileHistorySnapshot {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'file-history-snapshot'
    ;
}
interface LastPrompt {
  type: 'last-prompt';
  lastPrompt: string;
}

function isLastPrompt(e: unknown): e is LastPrompt {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'last-prompt'
    && 'lastPrompt' in e && typeof e.lastPrompt === 'string'
    ;
}

interface EnqueueOperation {
  type: 'queue-operation';
  operation: 'enqueue';
  content: string;
}

function isEnqueueOperation(e: unknown): e is EnqueueOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'enqueue'
    && 'content' in e && typeof e.content === 'string'
    ;
}

interface DequeueOperation {
  type: 'queue-operation';
  operation: 'dequeue';
}

function isDequeueOperation(e: unknown): e is DequeueOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'dequeue'
    ;
}

interface CustomTitle {
  type: 'custom-title';
  customTitle: string;
}

function isCustomTitle(e: unknown): e is CustomTitle {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'custom-title'
    && 'customTitle' in e && typeof e.customTitle === 'string'
    ;
}

interface AgentName {
  type: 'agent-name';
  agentName: string;
}

function isAgentName(e: unknown): e is AgentName {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'agent-name'
    && 'agentName' in e && typeof e.agentName === 'string'
    ;
}

interface TurnDuration {
  type: 'system';
  subtype: 'turn_duration';
  durationMs: number;
  messageCount: number;
  timestamp: string;
}

function isTurnDuration(e: unknown): e is TurnDuration {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'system'
    && 'subtype' in e && e.subtype === 'turn_duration'
    && 'durationMs' in e && typeof e.durationMs === 'number'
    && 'messageCount' in e && typeof e.messageCount === 'number'
    && 'timestamp' in e && typeof e.timestamp === 'string'
    ;
}

interface AssistantSynthetic {
  type: 'assistant';
  message: {
    model: '<synthetic>';
    content: {
      text: string;
    }[];
  }
}

function isAssistantSynthetic(e: unknown): e is AssistantSynthetic {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'model' in e.message && e.message.model === '<synthetic>'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
    )
    ;
}

interface AssistantThinking {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'thinking';
      thinking: string;
    }[];
  }
}

function isAssistantThinking(e: unknown): e is AssistantThinking {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'thinking'
        && 'thinking' in c && typeof c.thinking === 'string' && c.thinking !== ''
        && !('signature' in c || c.signature === '')
    )
    ;
}

interface AssistantEncryptedThinking {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'thinking';
      thinking: '';
      signature: string
    }[];
  }
}

function isAssistantEncryptedThinking(e: unknown): e is AssistantEncryptedThinking {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'thinking'
        && 'thinking' in c && c.thinking === ''
        && 'signature' in c && typeof c.signature === 'string'
    )
    ;
}

// TODO: Technically different content types can be mixed in one event, support that
interface AssistantBash {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Bash';
      input: { command: string, description?: string };
    }[];
  }
}

function isAssistantBash(e: unknown): e is AssistantBash {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'Bash'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'command' in c.input && typeof c.input.command === 'string'
        && (!('description' in c.input) || typeof c.input.description === 'string')
    )
    ;
}

interface AssistantWrite {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Write';
      input: { file_path: string, content: string };
    }[];
  }
}

function isAssistantWrite(e: unknown): e is AssistantWrite {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'Write'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'file_path' in c.input && typeof c.input.file_path === 'string'
        && 'content' in c.input && typeof c.input.content === 'string'
    )
    ;
}

interface AssistantRead {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Read';
      input: { file_path: string };
    }[];
  }
}

function isAssistantRead(e: unknown): e is AssistantRead {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'Read'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'file_path' in c.input && typeof c.input.file_path === 'string'
    )
    ;
}

interface AssistantSkill {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Skill';
      input: { skill: string, args: string | undefined };
    }[];
  }
}

function isAssistantSkill(e: unknown): e is AssistantSkill {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'Skill'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'skill' in c.input && typeof c.input.skill === 'string'
        && (!('args' in c.input) || typeof c.input.args === 'string')
    )
    ;
}

interface AssistantAgent {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Agent';
      input: { description: string, subagent_type: string, prompt: string, model?: string };
    }[];
  }
}

function isAssistantAgent(e: unknown): e is AssistantAgent {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'Agent'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'description' in c.input && typeof c.input.description === 'string'
        && 'subagent_type' in c.input && typeof c.input.subagent_type === 'string'
        && 'prompt' in c.input && typeof c.input.prompt === 'string'
        && (!('model' in c.input) || typeof c.input.model === 'string')
    )
    ;
}

interface AssistantToolSearch {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'ToolSearch';
      input: { query: string };
    }[];
  }
}

function isAssistantToolSearch(e: unknown): e is AssistantToolSearch {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'ToolSearch'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'query' in c.input && typeof c.input.query === 'string'
    )
    ;
}

interface AssistantAskUserQuestion {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
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
    }[];
  }
}

function isAssistantAskUserQuestion(e: unknown): e is AssistantAskUserQuestion {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
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
        )
    )
    ;
}

interface AssistantTaskCreate {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'TaskCreate';
      input: {
        subject: string;
        description: string;
        activeForm: string;
      };
    }[];
  }
}

function isAssistantTaskCreate(e: unknown): e is AssistantTaskCreate {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'TaskCreate'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'subject' in c.input && typeof c.input.subject === 'string'
        && 'description' in c.input && typeof c.input.description === 'string'
        && 'activeForm' in c.input && typeof c.input.activeForm === 'string'
    )
    ;
}

interface ExitPlanMode {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'ExitPlanMode';
    }[];
  }
}

function isExitPlanMode(e: unknown): e is ExitPlanMode {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'ExitPlanMode'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
    )
    ;
}

interface OtherToolUse {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'string';
      input: object;
    }[];
  }
}

function isOtherToolUse(e: unknown): e is OtherToolUse {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c
          && c.name !== 'Bash'
          && c.name !== 'Write'
          && c.name !== 'Read'
          && c.name !== 'Skill'
          && c.name !== 'Agent'
          && c.name !== 'ToolSearch'
          && c.name !== 'AskUserQuestion'
          && c.name !== 'TaskCreate'
          && c.name !== 'ExitPlanMode'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
    )
    ;
}

interface Assistant {
  type: 'assistant';
  message: {
    content: {
      text: string;
    }[];
  }
}

function isAssistant(e: unknown): e is Assistant {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type !== 'thinking'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
    )
    ;
}

interface ToolResult {
  type: 'user';
  message: {
    content: {
      type: 'tool_result';
      content: string;
    }[];
  }
}

// TODO: This should be grouped by the tool_use_id in the output
function isToolResult(e: unknown): e is ToolResult {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_result'
        && 'content' in c && typeof c.content === 'string'
    )
    ;
}

interface ToolResultArray {
  type: 'user';
  message: {
    content: {
      type: 'tool_result';
      content: {
        text: string;
      }[];
    }[];
  }
}

// TODO: This should be grouped by the tool_use_id in the output
function isToolResultArray(e: unknown): e is ToolResultArray {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_result'
        && 'content' in c && Array.isArray(c.content)
        && c.content.every(
          (cc: unknown) => cc !== null && typeof cc === 'object'
            && 'type' in cc && cc.type === 'text'
            && 'text' in cc && typeof cc.text === 'string'
        )
    )
    ;
}

interface ToolReference {
  type: 'user';
  message: {
    content: {
      type: 'tool_result';
      content: {
        type: 'tool_reference';
        tool_name: string;
      }[];
    }[];
  }
}

// TODO: This should be grouped by the tool_use_id in the output
function isToolReference(e: unknown): e is ToolReference {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_result'
        && 'content' in c && Array.isArray(c.content)
        && c.content.every(
          (cc: unknown) => cc !== null && typeof cc === 'object'
            && 'type' in cc && cc.type === 'tool_reference'
            && 'tool_name' in cc && typeof cc.tool_name === 'string'
        )
    )
    ;
}
interface User {
  type: 'user';
  message: {
    content: string;
  }
}

// TODO: This should be grouped by the tool_use_id in the output
function isUser(e: unknown): e is User {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && typeof e.message.content === 'string'
    ;
}

interface UserArray {
  type: 'user';
  message: {
    content: {
      text: string;
    }[];
  }
}

function isUserArray(e: unknown): e is UserArray {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
    )
    ;
}

interface SkillListingAttachment {
  type: 'attachment';
  attachment: {
    type: 'skill_listing';
    content: string;
  }
}

function isSkillListingAttachment(e: unknown): e is SkillListingAttachment {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'attachment'
    && 'attachment' in e && e.attachment !== null && typeof e.attachment === 'object'
    && 'type' in e.attachment && e.attachment.type === 'skill_listing'
    && 'content' in e.attachment && typeof e.attachment.content === 'string'
    ;
}

interface CommandPermissionsAttachment {
  type: 'attachment';
  attachment: {
    type: 'command_permissions';
    allowedTools: string[];
  }
}

function isCommandPermissionsAttachment(e: unknown): e is CommandPermissionsAttachment {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'attachment'
    && 'attachment' in e && e.attachment !== null && typeof e.attachment === 'object'
    && 'type' in e.attachment && e.attachment.type === 'command_permissions'
    && 'allowedTools' in e.attachment && Array.isArray(e.attachment.allowedTools)
    && e.attachment.allowedTools.every(t => typeof t === 'string')
    ;
}

// TODO: This needs to support even more events.
//       Use this file ~/.claude/projects/-Users-agladysh-rs-contract-unit/149fe6d5-fc0f-4427-9db7-7d7959956c0d.jsonl
//       Run with --debug --verbose --display
//       Weed out all unsupported tool calls and event types: everything should be supported
// TODO: Improve layout, add some colors, wrap lines etc.
const Rules: Rule[] = [
  Verbose(isFileHistorySnapshot, (e) =>
    `• File History snapshot\n`
  ),
  Verbose(isLastPrompt, (e) =>
    `• Last Prompt\n| ${truncateText(e.lastPrompt).join('\n| ')}\n`
  ),
  Verbose(isEnqueueOperation, (e) =>
    `• Enqueue\n| ${truncateText(e.content).join('\n| ')}\n`
  ),
  Verbose(isDequeueOperation, () =>
    `• Dequeue\n`
  ),
  Rule(isCustomTitle, (e) =>
    `• Custom Title\n| ${truncateText(e.customTitle).join('\n| ')}\n`
  ),
  Rule(isAgentName, (e) =>
    `• Agent Name\n| ${truncateText(e.agentName).join('\n| ')}\n`
  ),
  Verbose(isSkillListingAttachment, (e) =>
    `• Skill Listing\n| ${truncateText(e.attachment.content).join('\n| ')}\n`
  ),
  Verbose(isCommandPermissionsAttachment, (e) =>
    `• Allowed Tools\n| ${e.attachment.allowedTools.join('\n| ')}\n`
  ),
  Rule(isAssistantSynthetic, (e) =>
    `• Synthetic\n| ${e.message.content.flatMap(t => truncateText(t.text)).join('\n| ')}\n`
  ),
  Verbose(isAssistantEncryptedThinking, () =>
    `• Encrypted Thinking\n`
  ),
  Rule(isAssistantThinking, (e) =>
    `• Thinking\n| ${e.message.content.flatMap(t => truncateText(t.thinking)).join('\n| ')}\n`
  ),
  Rule(isAssistantBash, (e) =>
    `• Bash\n| ${e.message.content.map(t => [
      t.input.description && truncateLine(t.input.description),
      truncateText(t.input.command) ]
    ).filter(Boolean).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(isAssistantWrite, (e) =>
    `• Write\n| ${e.message.content.map(t => [ t.input.file_path, truncateText(t.input.content) ]).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(isAssistantRead, (e) =>
    `• Read\n| ${e.message.content.map(t => t.input.file_path).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(isAssistantSkill, (e) =>
    `• Skill\n| ${e.message.content.flatMap(t => [ t.input.skill, t.input.args ].filter(Boolean)).join('\n| ')}\n`
  ),
  Rule(isAssistantAgent, (e) =>
    `• Agent\n| ${e.message.content.map(t => [
      t.input.subagent_type,
      t.input.model,
      truncateLine(t.input.description),
      truncateText(t.input.prompt),
    ]).flat(Infinity).filter(Boolean).join('\n| ')}\n`
  ),
  Verbose(isAssistantToolSearch, (e) =>
    `• Tool Search\n| ${e.message.content.flatMap(t => t.input.query).join('\n| ')}\n`
  ),
  Verbose(isToolReference, (e) =>
    `• Tool Reference\n| ${e.message.content.map(t => t.content.map(r => r.tool_name)).flat(Infinity).join('\n| ')}\n`
  ),
  // TODO: This especially is in dire need of additional formatting for readability
  Verbose(isAssistantAskUserQuestion, (e) =>
    `• Ask User Question\n| ${e.message.content.map(t => t.input.questions.map(q => [
      truncateLine(q.header),
      truncateText(q.question),
      q.options.map(o => [ truncateLine(o.label), truncateText(o.description) ])
    ])).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(isAssistantTaskCreate, (e) =>
    `• Task Create\n| ${e.message.content.map(t => [
      truncateLine(t.input.subject),
      truncateText(t.input.description),
    ]).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(isExitPlanMode, () =>
    `• Exit Plan Mode\n`
  ),
  Debug(isOtherToolUse, (e) =>
    `• Tool\n| ${e.message.content.flatMap(t => [ t.name, JSON.stringify(t.input) ]).join('\n| ')}\n`
  ),
  Rule(isAssistant, (e) =>
    `• Assistant\n| ${e.message.content.flatMap(t => truncateText(t.text)).join('\n| ')}\n`
  ),
  Rule(isToolResult, (e) =>
    `> ${e.message.content.flatMap(t => truncateText(t.content)).join('\n| ')}\n`
  ),
  Rule(isToolResultArray, (e) =>
    `> ${e.message.content.flatMap(t => t.content.flatMap(c => truncateText(c.text))).join('\n| ')}\n`
  ),
  Rule(isUser, (e) =>
    `• User\n| ${truncateText(e.message.content).join('\n| ')}\n`
  ),
  Rule(isUserArray, (e) =>
    `• User\n| ${e.message.content.flatMap(t => truncateText(t.text)).join('\n| ')}\n`
  ),
  Rule(isTurnDuration, (e) =>
    `• Turn Duration\n| ${e.durationMs}ms, ${e.messageCount} messages\n`
  ),
] as const;

function displayClaudeEvent(e: unknown, o: RuleOptions): string {
  for (const r of Rules) {
    const result = r(e, o);
    if (result !== null) {
      return result;
    }
  }
  return (o.verbose || o.debug) ? `${JSON.stringify(e)}\n` : '';
}

///////////////////////////////////////////////////////////////////////////////

const { values, positionals } = parseArgs({
  args: Bun.argv,
  options: {
    launcher: {
      type: 'string',
      default: 'claude',
      short: 'l',
    },
    model: {
      type: 'string',
      short: 'm',
    },
    verbose: {
      type: 'boolean',
      default: false,
    },
    debug: {
      type: 'boolean',
      default: false,
    },
    quiet: {
      type: 'boolean',
      short: 'q',
      default: false,
    },
    version: {
      type: 'boolean',
      short: 'v',
      default: false,
    },
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
    },
    display: {
      type: 'string',
    },
  },
  strict: true,
  allowPositionals: true,
});

positionals.shift(); // Bun
positionals.shift(); // Script name

async function main() {
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  if (values.display) {
    const result = Bun.JSONL.parse(await Bun.file(values.display).text());
    for (const event of result) {
      process.stdout.write(displayClaudeEvent(event, values));
    }
    return 0;
  }

  if (values.help || positionals.length === 0 || !(values.launcher in Launchers)) {
    // TODO: Write better help text
    process.stdout.write(
      `Usage: ${Object.keys(pkg.bin)[0]} [--launcher=claude|ollama] [--model=<model>] [--quiet] "call to action"\n`
    );
    return 0;
  }

  let exited = false;

  const claude = await spawnClaude({
    launcher: values.launcher as Launcher,
    model: values.model,
    callToAction: positionals.join(' '),
    permissionMode: 'acceptEdits',
  });

  if (values.verbose || values.debug) {
    process.stdout.write(`${claude.sessionJsonlPath}\n`);
  }

  if (values.quiet) {
    await claude.subprocess.exited;
  } else {
    const watcher = watch(claude.projectHomePath);
    const basename = path.basename(claude.sessionJsonlPath);
    for await (const event of watcher) {
      if (event.filename === basename || exited) {
        break;
      }
    }

    let buffer = "";
    const tail = new TailFile(claude.sessionJsonlPath, { startPos: 0 });
    tail
      .on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');

        const result = Bun.JSONL.parseChunk(buffer);
        for (const event of result.values) {
          process.stdout.write(displayClaudeEvent(event, values));
        }

        buffer = buffer.slice(result.read);
      })
      .start();

    await claude.subprocess.exited;
    await tail.quit();

    if (buffer.length > 0) {
      const final = Bun.JSONL.parseChunk(buffer);
      for (const event of final.values) {
        process.stdout.write(displayClaudeEvent(event, values));
      }
      if (final.error) {
        process.stderr.write(`unable to parse final jsonl chunk: ${final.error.message}:\n\n${buffer}`);
      }
    }
  }

  return 0;
}

process.exitCode = await main();
