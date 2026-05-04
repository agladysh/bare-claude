interface FileHistorySnapshot {
  type: 'file-history-snapshot';
}

// TODO: This code might benefit from arktype, valibot, or even zod.
export function isFileHistorySnapshot(e: unknown): e is FileHistorySnapshot {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'file-history-snapshot';
}

interface LastPrompt {
  type: 'last-prompt';
  lastPrompt: string;
}

export function isLastPrompt(e: unknown): e is LastPrompt {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'last-prompt'
    && 'lastPrompt' in e && typeof e.lastPrompt === 'string';
}

interface EnqueueOperation {
  type: 'queue-operation';
  operation: 'enqueue';
  content: string;
}

export function isEnqueueOperation(e: unknown): e is EnqueueOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'enqueue'
    && 'content' in e && typeof e.content === 'string';
}

interface DequeueOperation {
  type: 'queue-operation';
  operation: 'dequeue';
}

export function isDequeueOperation(e: unknown): e is DequeueOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'dequeue';
}

interface RemoveOperation {
  type: 'queue-operation';
  operation: 'remove';
}

export function isRemoveOperation(e: unknown): e is RemoveOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'remove';
}

interface PopAllOperation {
  type: 'queue-operation';
  operation: 'popAll';
  content: string;
}

export function isPopAllOperation(e: unknown): e is PopAllOperation {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'queue-operation'
    && 'operation' in e && e.operation === 'popAll'
    && 'content' in e && typeof e.content === 'string';
}

interface CustomTitle {
  type: 'custom-title';
  customTitle: string;
}

export function isCustomTitle(e: unknown): e is CustomTitle {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'custom-title'
    && 'customTitle' in e && typeof e.customTitle === 'string';
}

interface AgentName {
  type: 'agent-name';
  agentName: string;
}

export function isAgentName(e: unknown): e is AgentName {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'agent-name'
    && 'agentName' in e && typeof e.agentName === 'string';
}

interface TurnDuration {
  type: 'system';
  subtype: 'turn_duration';
  durationMs: number;
  messageCount: number;
  timestamp: string;
}

export function isTurnDuration(e: unknown): e is TurnDuration {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'system'
    && 'subtype' in e && e.subtype === 'turn_duration'
    && 'durationMs' in e && typeof e.durationMs === 'number'
    && 'messageCount' in e && typeof e.messageCount === 'number'
    && 'timestamp' in e && typeof e.timestamp === 'string';
}

interface ApiError {
  type: 'system';
  subtype: 'api_error';
}

export function isApiError(e: unknown): e is ApiError {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'system'
    && 'subtype' in e && e.subtype === 'api_error';
}

interface Synthetic {
  type: 'assistant';
  message: {
    model: '<synthetic>';
    content: {
      text: string;
    }[];
  };
}

export function isSynthetic(e: unknown): e is Synthetic {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'model' in e.message && e.message.model === '<synthetic>'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
    );
}

interface Thinking {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'thinking';
      thinking: string;
    }[];
  };
}

export function isThinking(e: unknown): e is Thinking {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'thinking'
        && 'thinking' in c && typeof c.thinking === 'string' && c.thinking !== ''
        && (!('signature' in c) || c.signature === '')
    );
}

interface EncryptedThinking {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'thinking';
      thinking: '';
      signature: string;
    }[];
  };
}

export function isEncryptedThinking(e: unknown): e is EncryptedThinking {
  return e !== null && typeof e === 'object'
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
    );
}

// TODO: Technically different content types can be mixed in one event, support that
interface Bash {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Bash';
      input: { command: string; description?: string; };
    }[];
  };
}

export function isBash(e: unknown): e is Bash {
  return e !== null && typeof e === 'object'
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
    );
}

interface Write {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Write';
      input: { file_path: string; content: string; };
    }[];
  };
}

export function isWrite(e: unknown): e is Write {
  return e !== null && typeof e === 'object'
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
    );
}

interface Read {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Read';
      input: { file_path: string; };
    }[];
  };
}

export function isRead(e: unknown): e is Read {
  return e !== null && typeof e === 'object'
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
    );
}

interface Edit {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Edit';
      input: { file_path: string; old_string: string; new_string: string; replace_all?: boolean; };
    }[];
  };
}

export function isEdit(e: unknown): e is Edit {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'Edit'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'file_path' in c.input && typeof c.input.file_path === 'string'
        && 'old_string' in c.input && typeof c.input.old_string === 'string'
        && 'new_string' in c.input && typeof c.input.new_string === 'string'
        && (!('replace_all' in c.input) || typeof c.input.replace_all === 'boolean')
    );
}

interface Skill {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Skill';
      input: { skill: string; args: string | undefined; };
    }[];
  };
}

export function isSkill(e: unknown): e is Skill {
  return e !== null && typeof e === 'object'
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
    );
}

interface Agent {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Agent';
      input: { description: string; subagent_type?: string; prompt: string; model?: string; };
    }[];
  };
}

export function isAgent(e: unknown): e is Agent {
  return e !== null && typeof e === 'object'
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
        && (!('subagent_type' in c.input) || typeof c.input.subagent_type === 'string')
        && 'prompt' in c.input && typeof c.input.prompt === 'string'
        && (!('model' in c.input) || typeof c.input.model === 'string')
    );
}

interface ToolSearch {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'ToolSearch';
      input: { query: string; };
    }[];
  };
}

export function isToolSearch(e: unknown): e is ToolSearch {
  return e !== null && typeof e === 'object'
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
    );
}

interface Grep {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'Grep';
      input: { pattern: string; path?: string; output_mode?: string; };
    }[];
  };
}

export function isGrep(e: unknown): e is Grep {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'Grep'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'pattern' in c.input && typeof c.input.pattern === 'string'
        && (!('path' in c.input) || typeof c.input.path === 'string')
        && (!('output_mode' in c.input) || typeof c.input.output_mode === 'string')
    );
}

interface AskUserQuestion {
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
  };
}

export function isAskUserQuestion(e: unknown): e is AskUserQuestion {
  return e !== null && typeof e === 'object'
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
    );
}

interface TaskCreate {
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
  };
}

export function isTaskCreate(e: unknown): e is TaskCreate {
  return e !== null && typeof e === 'object'
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
    );
}

interface TaskUpdate {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'TaskUpdate';
      input: {
        taskId: string;
        status: string;
      };
    }[];
  };
}

export function isTaskUpdate(e: unknown): e is TaskUpdate {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'TaskUpdate'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
        && 'taskId' in c.input && typeof c.input.taskId === 'string'
        && 'status' in c.input && typeof c.input.status === 'string'
    );
}

interface ExitPlanMode {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'ExitPlanMode';
    }[];
  };
}

export function isExitPlanMode(e: unknown): e is ExitPlanMode {
  return e !== null && typeof e === 'object'
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
    );
}

interface EnterPlanMode {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'tool_use';
      name: 'EnterPlanMode';
    }[];
  };
}

export function isEnterPlanMode(e: unknown): e is EnterPlanMode {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c && c.name === 'EnterPlanMode'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
    );
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
  };
}

export function isOtherToolUse(e: unknown): e is OtherToolUse {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_use'
        && 'name' in c // Make sure to list all supportedtools here.
        && c.name !== 'Bash'
        && c.name !== 'Grep'
        && c.name !== 'Write'
        && c.name !== 'Edit'
        && c.name !== 'Read'
        && c.name !== 'Skill'
        && c.name !== 'Agent'
        && c.name !== 'ToolSearch'
        && c.name !== 'AskUserQuestion'
        && c.name !== 'TaskCreate'
        && c.name !== 'TaskUpdate'
        && c.name !== 'EnterPlanMode'
        && c.name !== 'ExitPlanMode'
        && 'input' in c && c.input !== null && typeof c.input === 'object'
    );
}

interface Assistant {
  type: 'assistant';
  message: {
    content: {
      text: string;
    }[];
  };
}

export function isAssistant(e: unknown): e is Assistant {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type !== 'thinking'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
    );
}

interface ToolResult {
  type: 'user';
  message: {
    content: {
      type: 'tool_result';
      content: string;
    }[];
  };
}

// TODO: This should be grouped by the tool_use_id in the output
export function isToolResult(e: unknown): e is ToolResult {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'tool_result'
        && 'content' in c && typeof c.content === 'string'
    );
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
  };
}

// TODO: This should be grouped by the tool_use_id in the output
export function isToolResultArray(e: unknown): e is ToolResultArray {
  return e !== null && typeof e === 'object'
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
    );
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
  };
}

// TODO: This should be grouped by the tool_use_id in the output
export function isToolReference(e: unknown): e is ToolReference {
  return e !== null && typeof e === 'object'
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
    );
}

interface User {
  type: 'user';
  message: {
    content: string;
  };
}

// TODO: This should be grouped by the tool_use_id in the output
export function isUser(e: unknown): e is User {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && typeof e.message.content === 'string';
}

interface UserArray {
  type: 'user';
  message: {
    content: {
      text: string;
    }[];
  };
}

export function isUserArray(e: unknown): e is UserArray {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'user'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
    );
}

interface SkillListingAttachment {
  type: 'attachment';
  attachment: {
    type: 'skill_listing';
    content: string;
  };
}

export function isSkillListingAttachment(e: unknown): e is SkillListingAttachment {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'attachment'
    && 'attachment' in e && e.attachment !== null && typeof e.attachment === 'object'
    && 'type' in e.attachment && e.attachment.type === 'skill_listing'
    && 'content' in e.attachment && typeof e.attachment.content === 'string';
}

interface CommandPermissionsAttachment {
  type: 'attachment';
  attachment: {
    type: 'command_permissions';
    allowedTools: string[];
  };
}

export function isCommandPermissionsAttachment(e: unknown): e is CommandPermissionsAttachment {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'attachment'
    && 'attachment' in e && e.attachment !== null && typeof e.attachment === 'object'
    && 'type' in e.attachment && e.attachment.type === 'command_permissions'
    && 'allowedTools' in e.attachment && Array.isArray(e.attachment.allowedTools)
    && e.attachment.allowedTools.every(t => typeof t === 'string');
}

export type SessionEvent =
  | FileHistorySnapshot
  | LastPrompt
  | EnqueueOperation
  | DequeueOperation
  | RemoveOperation
  | PopAllOperation
  | CustomTitle
  | AgentName
  | TurnDuration
  | ApiError
  | Synthetic
  | Thinking
  | EncryptedThinking
  | Bash
  | Write
  | Read
  | Edit
  | Skill
  | Agent
  | ToolSearch
  | Grep
  | AskUserQuestion
  | TaskCreate
  | TaskUpdate
  | ExitPlanMode
  | EnterPlanMode
  | OtherToolUse
  | Assistant
  | ToolResult
  | ToolResultArray
  | ToolReference
  | User
  | UserArray
  | SkillListingAttachment
  | CommandPermissionsAttachment;
