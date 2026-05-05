import * as Event from './events.ts';

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

// TODO: Improve layout, add some colors, wrap lines etc.
const Rules: Rule[] = [
  Verbose(Event.isFileHistorySnapshot, (e) =>
    `• File History Snapshot\n`
  ),
  Verbose(Event.isPermissionMode, (e) =>
    `• Permission Mode ${e.permissionMode}\n`
  ),
  Verbose(Event.isLastPrompt, (e) =>
    `• Last Prompt\n| ${truncateText(e.lastPrompt).join('\n| ')}\n`
  ),
  Verbose(Event.isEnqueueOperation, (e) =>
    `• Enqueue\n| ${truncateText(e.content).join('\n| ')}\n`
  ),
  Verbose(Event.isDequeueOperation, () =>
    `• Dequeue\n`
  ),
  Verbose(Event.isPopAllOperation, (e) =>
    `• Pop All\n| ${truncateText(e.content).join('\n| ')}\n`
  ),
  Verbose(Event.isRemoveOperation, () =>
    `• Remove\n`
  ),
  Rule(Event.isCustomTitle, (e) =>
    `• Custom Title\n| ${truncateText(e.customTitle).join('\n| ')}\n`
  ),
  Rule(Event.isAgentName, (e) =>
    `• Agent Name\n| ${truncateText(e.agentName).join('\n| ')}\n`
  ),
  Verbose(Event.isSkillListingAttachment, (e) =>
    `• Skill Listing\n| ${truncateText(e.attachment.content).join('\n| ')}\n`
  ),
  Verbose(Event.isCommandPermissionsAttachment, (e) =>
    `• Allowed Tools\n| ${e.attachment.allowedTools.join('\n| ')}\n`
  ),
  Rule(Event.isSynthetic, (e) =>
    `• Synthetic\n| ${e.message.content.flatMap(t => truncateText(t.text)).join('\n| ')}\n`
  ),
  Verbose(Event.isEncryptedThinking, () =>
    `• Encrypted Thinking\n`
  ),
  Rule(Event.isThinking, (e) =>
    `• Thinking\n| ${e.message.content.flatMap(t => truncateText(t.thinking)).join('\n| ')}\n`
  ),
  Rule(Event.isBash, (e) =>
    `• Bash\n| ${e.message.content.map(t => [
      t.input.description && truncateLine(t.input.description),
      truncateText(t.input.command) ]
    ).filter(Boolean).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(Event.isWrite, (e) =>
    `• Write\n| ${e.message.content.map(t => [ t.input.file_path, truncateText(t.input.content) ]).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(Event.isRead, (e) =>
    `• Read\n| ${e.message.content.map(t => t.input.file_path).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(Event.isEdit, (e) =>
    `• Edit\n| ${e.message.content.map(t => [
      t.input.file_path,
      t.input.replace_all ? 'Replace All' : undefined,
      'Old',
      truncateText(t.input.old_string),
      'New',
      truncateText(t.input.new_string),
    ].filter(Boolean).flat(Infinity).join('\n| '))}\n`
  ),
  Rule(Event.isSkill, (e) =>
    `• Skill\n| ${e.message.content.flatMap(t => [ t.input.skill, t.input.args ].filter(Boolean)).join('\n| ')}\n`
  ),
  Rule(Event.isAgent, (e) =>
    `• Agent\n| ${e.message.content.map(t => [
      t.input.subagent_type,
      t.input.model,
      truncateLine(t.input.description),
      truncateText(t.input.prompt),
    ]).flat(Infinity).filter(Boolean).join('\n| ')}\n`
  ),
  Verbose(Event.isToolSearch, (e) =>
    `• Tool Search\n| ${e.message.content.flatMap(t => t.input.query).join('\n| ')}\n`
  ),
  Rule(Event.isGrep, (e) =>
    `• Grep\n| ${e.message.content.map(t => [
      t.input.pattern,
      t.input.path && `in ${t.input.path}`,
      t.input.output_mode && `mode: ${t.input.output_mode}`
    ].filter(Boolean).flat(Infinity).join('\n| '))}\n`
  ),
  Verbose(Event.isToolReference, (e) =>
    `• Tool Reference\n| ${e.message.content.map(t => t.content.map(r => r.tool_name)).flat(Infinity).join('\n| ')}\n`
  ),
  // TODO: This especially is in dire need of additional formatting for readability
  Verbose(Event.isAskUserQuestion, (e) =>
    `• Ask User Question\n| ${e.message.content.map(t => t.input.questions.map(q => [
      truncateLine(q.header),
      truncateText(q.question),
      q.options.map(o => [ truncateLine(o.label), truncateText(o.description) ])
    ])).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(Event.isTaskCreate, (e) =>
    `• Task Create\n| ${e.message.content.map(t => [
      truncateLine(t.input.subject),
      truncateText(t.input.description),
    ]).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(Event.isTaskUpdate, (e) =>
    `• Task Update\n| ${e.message.content.map(t => [
      `${t.input.taskId}: ${t.input.status}`,
    ]).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(Event.isEnterPlanMode, () =>
    `• Enter Plan Mode\n`
  ),
  Rule(Event.isExitPlanMode, () =>
    `• Exit Plan Mode\n`
  ),
  Debug(Event.isOtherToolUse, (e) =>
    `• Tool\n| ${e.message.content.flatMap(t => [ t.name, JSON.stringify(t.input) ]).join('\n| ')}\n`
  ),
  Rule(Event.isAssistant, (e) =>
    `• Assistant\n| ${e.message.content.flatMap(t => truncateText(t.text, Infinity)).join('\n| ')}\n`
  ),
  Rule(Event.isToolResult, (e) =>
    `> ${e.message.content.flatMap(t => truncateText(t.content)).join('\n| ')}\n`
  ),
  Rule(Event.isToolResultArray, (e) =>
    `> ${e.message.content.flatMap(t => t.content.flatMap(c => truncateText(c.text))).join('\n| ')}\n`
  ),
  Rule(Event.isUser, (e) =>
    `• User\n| ${truncateText(e.message.content).join('\n| ')}\n`
  ),
  Rule(Event.isUserArray, (e) =>
    `• User\n| ${e.message.content.flatMap(t => truncateText(t.text)).join('\n| ')}\n`
  ),
  Rule(Event.isTurnDuration, (e) =>
    `• Turn Duration\n| ${e.durationMs}ms, ${e.messageCount} messages\n`
  ),
  Rule(Event.isApiError, () =>
    `• API Error\n`
  ),
] as const;

export function displayClaudeEvent(e: unknown, o: RuleOptions): string {
  for (const r of Rules) {
    const result = r(e, o);
    if (result !== null) {
      return result;
    }
  }
  return (o.verbose || o.debug) ? `${JSON.stringify(e)}\n` : '';
}
