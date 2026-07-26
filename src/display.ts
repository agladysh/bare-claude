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
  // The marker occupies one of the allotted lines, so a truncated block never
  // renders more lines than the block it stands in for.
  const headLength = Math.ceil((maxLines - 1) / 2);
  const tailLength = maxLines - 1 - headLength;
  const head = lines.slice(0, headLength);
  const tail = tailLength > 0 ? lines.slice(-tailLength) : [];
  const hidden = lines.length - head.length - tail.length;
  return [...head, `... [${hidden} ${hidden === 1 ? 'line' : 'lines'} truncated] ...`, ...tail];
}

/**
 * How much of the stream to render.
 * @property verbose - Include bookkeeping records and un-collapse tool results.
 * @property debug - Render *only* what no rule recognizes, plus unhandled tools.
 */
export interface RenderOptions {
  verbose: boolean;
  debug: boolean;
}

/**
 * What a content-block rule gets on top of {@link RenderOptions}: the little
 * bit of enclosing-record context a single block cannot see for itself.
 * @property synthetic - The record's `message.model` is Claude Code's
 *   `<synthetic>` marker, so its text is fabricated rather than generated.
 * @property toolName - Name of the tool a `tool_result` block answers, or
 *   `undefined` when the call was never seen.
 * @property outstandingCalls - How many `tool_use` calls this renderer is
 *   still waiting on a result for, as of just before this record. A result
 *   whose call is the only one outstanding needs no tag to be unambiguous.
 */
interface BlockOptions extends RenderOptions {
  synthetic: boolean;
  toolName: (toolUseId: string | undefined) => string | undefined;
  outstandingCalls: () => number;
}

type Rule<O extends RenderOptions> = (e: unknown, o: O) => string | null;

function Rule<T, O extends RenderOptions>(
  guard: (e: unknown) => e is T, run: (e: T, o: O) => string
): Rule<O> {
  return (e: unknown, o: O) => {
    if (!guard(e)) {
      return null;
    }
    return (!o.debug) ? run(e, o) : '';
  }
}

// A Verbose rule *matches* whenever its guard does and merely renders nothing
// at low verbosity. Matching is what stops the walk, and the walk must stop:
// otherwise a quiet `ToolSearch` block would fall through to the catch-all
// tool rule below it and get dumped as raw input — and a recognized record
// would reach the JSON fallback under `--debug`, which is supposed to print
// only what no rule understands.
function Verbose<T, O extends RenderOptions>(
  guard: (e: unknown) => e is T, run: (e: T, o: O) => string
): Rule<O> {
  return (e: unknown, o: O) => {
    if (!guard(e)) {
      return null;
    }
    return (o.verbose && !o.debug) ? run(e, o) : '';
  }
}

function Debug<T, O extends RenderOptions>(
  guard: (e: unknown) => e is T, run: (e: T, o: O) => string
): Rule<O> {
  return (e: unknown, o: O) => {
    if (!guard(e)) {
      return null;
    }
    return run(e, o); // No debug guard
  }
}

function VerboseDebug<T, O extends RenderOptions>(
  guard: (e: unknown) => e is T, run: (e: T, o: O) => string
): Rule<O> {
  return (e: unknown, o: O) => {
    if (!guard(e)) {
      return null;
    }
    return o.verbose ? run(e, o) : ''; // No debug guard
  }
}

// TODO: Improve layout, add some colors, wrap lines etc.

/**
 * Records with no `message.content` array. Tried before block dispatch; the
 * two sets are disjoint, so order between the tables does not matter.
 */
const EventRules: Rule<RenderOptions>[] = [
  Verbose(Event.isFileHistorySnapshot, () =>
    `• File History Snapshot\n`
  ),
  Verbose(Event.isFileHistoryDelta, (e) =>
    `• File History Delta\n| ${e.trackingPath}\n`
  ),
  Verbose(Event.isPermissionMode, (e) =>
    `• Permission Mode ${e.permissionMode}\n`
  ),
  Verbose(Event.isMode, (e) =>
    `• Mode ${e.mode}\n`
  ),
  Verbose(Event.isAgentSetting, (e) =>
    `• Agent Setting ${e.agentSetting}\n`
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
  Rule(Event.isAiTitle, (e) =>
    `• AI Title\n| ${truncateText(e.aiTitle).join('\n| ')}\n`
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
  Rule(Event.isUserText, (e) =>
    `• User\n| ${truncateText(e.message.content).join('\n| ')}\n`
  ),
  Rule(Event.isTurnDuration, (e) =>
    `• Turn Duration\n| ${e.durationMs}ms, ${e.messageCount} messages\n`
  ),
  Rule(Event.isApiError, () =>
    `• API Error\n`
  ),
];

/**
 * One entry of an `assistant` record's `message.content`. The text rule is the
 * catch-all and must stay last: every other block type is discriminated by a
 * `type` the text guard rejects.
 */
const AssistantBlockRules: Rule<BlockOptions>[] = [
  Verbose(Event.isEncryptedThinkingBlock, () =>
    `• Encrypted Thinking\n`
  ),
  Rule(Event.isThinkingBlock, (c) =>
    `• Thinking\n| ${truncateText(c.thinking).join('\n| ')}\n`
  ),
  Rule(Event.isFallbackBlock, (c) =>
    `• Model Fallback\n| ${c.from.model} → ${c.to.model}\n`
  ),
  Rule(Event.isBashBlock, (c) =>
    `• Bash\n| ${[
      ...(c.input.description ? [ truncateLine(c.input.description) ] : []),
      ...truncateText(c.input.command),
    ].join('\n| ')}\n`
  ),
  Rule(Event.isWriteBlock, (c) =>
    `• Write\n| ${[
      c.input.file_path,
      ...truncateText(c.input.content),
    ].join('\n| ')}\n`
  ),
  Rule(Event.isReadBlock, (c) =>
    `• Read\n| ${c.input.file_path}\n`
  ),
  Rule(Event.isEditBlock, (c) =>
    `• Edit\n| ${[
      c.input.file_path,
      ...(c.input.replace_all ? [ 'Replace All' ] : []),
      'Old',
      ...truncateText(c.input.old_string),
      'New',
      ...truncateText(c.input.new_string),
    ].join('\n| ')}\n`
  ),
  Rule(Event.isSkillBlock, (c) =>
    `• Skill\n| ${[
      c.input.skill,
      ...(c.input.args ? [ c.input.args ] : []),
    ].join('\n| ')}\n`
  ),
  Rule(Event.isAgentBlock, (c) =>
    `• Agent\n| ${[
      ...(c.input.subagent_type ? [ c.input.subagent_type ] : []),
      ...(c.input.model ? [ c.input.model ] : []),
      truncateLine(c.input.description),
      ...truncateText(c.input.prompt),
    ].join('\n| ')}\n`
  ),
  Verbose(Event.isToolSearchBlock, (c) =>
    `• Tool Search\n| ${c.input.query}\n`
  ),
  Rule(Event.isGrepBlock, (c) =>
    `• Grep\n| ${[
      c.input.pattern,
      ...(c.input.path ? [ `in ${c.input.path}` ] : []),
      ...(c.input.output_mode ? [ `mode: ${c.input.output_mode}` ] : []),
    ].join('\n| ')}\n`
  ),
  // TODO: This especially is in dire need of additional formatting for readability
  Verbose(Event.isAskUserQuestionBlock, (c) =>
    `• Ask User Question\n| ${c.input.questions.map(q => [
      truncateLine(q.header),
      truncateText(q.question),
      q.options.map(o => [ truncateLine(o.label), truncateText(o.description) ])
    ]).flat(Infinity).join('\n| ')}\n`
  ),
  Rule(Event.isTaskCreateBlock, (c) =>
    `• Task Create\n| ${[
      truncateLine(c.input.subject),
      ...truncateText(c.input.description),
    ].join('\n| ')}\n`
  ),
  Rule(Event.isTaskUpdateBlock, (c) =>
    `• Task Update\n| ${[
      c.input.status ? `${c.input.taskId}: ${c.input.status}` : c.input.taskId,
      ...(c.input.addBlockedBy ? [ `Blocked By ${c.input.addBlockedBy.join(', ')}` ] : []),
      ...(c.input.description ? truncateText(c.input.description) : []),
    ].join('\n| ')}\n`
  ),
  Rule(Event.isEnterPlanModeBlock, () =>
    `• Enter Plan Mode\n`
  ),
  Rule(Event.isExitPlanModeBlock, () =>
    `• Exit Plan Mode\n`
  ),
  // Last among the tool rules on purpose: it fires only for a call none of
  // them accepted, which is what makes `--debug` "show the tools nothing
  // renders" without an exclusion list to keep in sync.
  Debug(Event.isAnyToolUseBlock, (c) =>
    `• Tool\n| ${c.name}\n| ${JSON.stringify(c.input)}\n`
  ),
  Rule(Event.isTextBlock, (c, o: BlockOptions) => o.synthetic
    ? `• Synthetic\n| ${truncateText(c.text).join('\n| ')}\n`
    : `• Assistant\n| ${truncateText(c.text, Infinity).join('\n| ')}\n`
  ),
];

/**
 * One entry of a `user` record's `message.content`. Tool results carry the `>`
 * prefix on *every* line, tool calls and prose carry `|`, so a transcript can
 * be split into "what Claude did" and "what came back" with one grep.
 */
const UserBlockRules: Rule<BlockOptions>[] = [
  Verbose(Event.isToolReferenceBlock, (c, o: BlockOptions) => {
    const tag = resultTag(o, c.tool_use_id);
    return `• Tool Reference${tag ? ` ${tag}` : ''}\n| ${c.content.map(r => r.tool_name).join('\n| ')}\n`;
  }),
  Rule(Event.isToolResultBlock, (c, o: BlockOptions) =>
    `> ${tagFirstLine(resultTag(o, c.tool_use_id), collapseRead(o, c.tool_use_id)
      ? [ lineCount(c.content.split('\n').length) ]
      : truncateText(c.content)
    ).join('\n> ')}\n`
  ),
  Rule(Event.isToolResultTextBlock, (c, o: BlockOptions) =>
    `> ${tagFirstLine(resultTag(o, c.tool_use_id), collapseRead(o, c.tool_use_id)
      ? [ lineCount(c.content.reduce((n, t) => n + t.text.split('\n').length, 0)) ]
      : c.content.flatMap(t => truncateText(t.text))
    ).join('\n> ')}\n`
  ),
  Rule(Event.isToolResultImageBlock, (c, o: BlockOptions) =>
    `> ${tagFirstLine(
      resultTag(o, c.tool_use_id), c.content.map(i => `[${i.source.media_type}]`)
    ).join('\n> ')}\n`
  ),
  Rule(Event.isImageBlock, (c) =>
    `• Image\n| ${c.source.media_type}\n`
  ),
  Rule(Event.isTextBlock, (c) =>
    `• User\n| ${truncateText(c.text).join('\n| ')}\n`
  ),
];

/**
 * A `Read` result is the file the renderer already announced by path, so by
 * default it collapses to its size. `--verbose` wants the text itself.
 */
function collapseRead(o: BlockOptions, toolUseId: string | undefined): boolean {
  return !o.verbose && o.toolName(toolUseId) === 'Read';
}

function lineCount(n: number): string {
  return `[${n} ${n === 1 ? 'line' : 'lines'}]`;
}

/**
 * `[ToolName]`, when this result's call is one of more than one still
 * outstanding, so a busy transcript still lets a reader tell which call a
 * result answers. `''` whenever at most one call is outstanding — which
 * covers both the ordinary single-call-then-result turn and a result whose
 * call this renderer never saw — so the overwhelmingly common case renders
 * exactly as it did before grouping existed. See "Pairing `tool_use` with
 * `tool_result`" in `doc/session-event-stream.md` for the full rule.
 */
function resultTag(o: BlockOptions, toolUseId: string | undefined): string {
  const name = o.toolName(toolUseId);
  return (name !== undefined && o.outstandingCalls() > 1) ? `[${name}]` : '';
}

/**
 * Prepends `tag` to a block's first line instead of adding a line of its
 * own, so tagging never changes a result's line count.
 */
function tagFirstLine(tag: string, lines: string[]): string[] {
  return (tag === '' || lines.length === 0) ? lines : [ `${tag} ${lines[0]}`, ...lines.slice(1) ];
}

/** Any content block carrying the back-reference to the call it answers. */
interface PairedBlock {
  tool_use_id: string;
}

function isPairedBlock(c: unknown): c is PairedBlock {
  return c !== null && typeof c === 'object'
    && 'tool_use_id' in c && typeof c.tool_use_id === 'string';
}

function firstMatch<O extends RenderOptions>(rules: Rule<O>[], e: unknown, o: O): string | null {
  for (const r of rules) {
    const out = r(e, o);
    if (out !== null) {
      return out;
    }
  }
  return null;
}

/**
 * Renders a session NDJSON stream, one record at a time, in stream order.
 *
 * Owns the `tool_use` → `tool_result` pairing table that lets a `Read` result
 * collapse to its line count and lets a busy stretch of calls tag each result
 * with the tool it answers, so two streams rendered at once cannot see each
 * other's calls. Construct one per stream; a renderer is only as long-lived as
 * the transcript it is reading.
 */
export class TranscriptRenderer {
  private readonly options: RenderOptions;

  /**
   * Tool name by `tool_use.id`. Entries are dropped as their results arrive,
   * so the table holds only outstanding calls, and its size is exactly how
   * many calls are still awaiting a result — the signal {@link resultTag}
   * uses to decide whether a result needs tagging. Measured 2026-07-26 over
   * the five largest local transcripts: a result follows its call by 1.05
   * records on average and 5 at worst, and exactly one call in 1 498 was
   * never answered — the table stays effectively empty.
   */
  private readonly toolNamesById = new Map<string, string>();

  /**
   * @param options - Verbosity for every record this renderer will be given.
   */
  constructor(options: RenderOptions) {
    this.options = { verbose: options.verbose, debug: options.debug };
  }

  /**
   * Renders one parsed NDJSON record.
   * @param e - The record, straight from the transcript. Untrusted shape.
   * @returns Terminal-ready text ending in a newline, or `''` when this record
   *   is suppressed at the current verbosity.
   */
  display(e: unknown): string {
    this.learnPairings(e);
    const out = firstMatch(EventRules, e, this.options)
      ?? this.displayBlocks(e)
      ?? ((this.options.verbose || this.options.debug) ? `${JSON.stringify(e)}\n` : '');
    this.consumePairings(e);
    return out;
  }

  /** Forgets every outstanding `tool_use` → `tool_result` pairing. */
  reset(): void {
    this.toolNamesById.clear();
  }

  /**
   * Dispatches each content block of an `assistant`/`user` record through its
   * own rule table, so a record mixing prose with a tool call renders both.
   * @returns `null` when the record has no block array, or when not one of its
   *   blocks was recognized — the caller then falls back to whole-record JSON,
   *   which keeps the envelope visible for a genuinely unknown shape.
   */
  private displayBlocks(e: unknown): string | null {
    if (!Event.isBlockMessage(e)) {
      return null;
    }

    const rules = e.type === 'assistant' ? AssistantBlockRules : UserBlockRules;
    const options: BlockOptions = {
      ...this.options,
      synthetic: e.message.model === Event.syntheticModel,
      toolName: id => id === undefined ? undefined : this.toolNamesById.get(id),
      outstandingCalls: () => this.toolNamesById.size,
    };

    let recognized = false;
    let out = '';
    for (const c of e.message.content) {
      const rendered = firstMatch(rules, c, options);
      if (rendered !== null) {
        recognized = true;
        out += rendered;
      } else if (options.verbose || options.debug) {
        out += `${JSON.stringify(c)}\n`;
      }
    }

    return recognized ? out : null;
  }

  /** Remembers which tool each `tool_use` block in this record called. */
  private learnPairings(e: unknown): void {
    if (!Event.isBlockMessage(e) || e.type !== 'assistant') {
      return;
    }
    for (const c of e.message.content) {
      if (Event.isToolUseBlock(c)) {
        this.toolNamesById.set(c.id, c.name);
      }
    }
  }

  /** Drops the pairings this record's results just answered. */
  private consumePairings(e: unknown): void {
    if (!Event.isBlockMessage(e) || e.type !== 'user') {
      return;
    }
    for (const c of e.message.content) {
      if (isPairedBlock(c)) {
        this.toolNamesById.delete(c.tool_use_id);
      }
    }
  }
}

/**
 * Renders a single record with no memory of the stream it came from.
 *
 * A convenience for one-off inspection. Because it keeps no pairing table, a
 * `Read` result rendered this way prints in full instead of collapsing to its
 * line count — use {@link TranscriptRenderer} to render a stream.
 * @param e - The record, straight from the transcript. Untrusted shape.
 * @param o - Verbosity.
 * @returns Terminal-ready text ending in a newline, or `''` when suppressed.
 */
export function displayClaudeEvent(e: unknown, o: RenderOptions): string {
  return new TranscriptRenderer(o).display(e);
}
