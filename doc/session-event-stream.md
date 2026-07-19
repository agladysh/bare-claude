# Bare Claude — Session Event Stream Rendering Reference

Source of truth: `src/events.ts` (type guards, one per recognized shape) and `src/display.ts` (the ordered `Rules` table + fallback). Real transcript sampled from `session-events-example.txt`; project context from `README.md`. This reference describes what `displayClaudeEvent(e, { verbose, debug })` recognizes and renders.

## Rule combinators (from `display.ts`)

The dispatcher walks `Rules` in array order and returns the first non-`null` result; a matched-but-suppressed rule returns `''` (empty string), which still stops the walk.

- **Always** — `Rule(guard, run)`: renders when the guard matches, *except* under `--debug`, where it matches but returns `''`. So: shown by default and under `--verbose`; silenced under `--debug`.
- **Verbose** — `Verbose(guard, run)`: renders only when `o.verbose`; under `--debug` it matches but returns `''`. So: shown only with `--verbose` and not `--debug`.
- **Debug** — `Debug(guard, run)`: renders whenever the guard matches, with *no* flag gate — it is the only family that still prints under `--debug` when everything else goes silent. In this table only `OtherToolUse` uses it, giving `--debug` its "show unrecognized/other tools only" behavior (README: "displays only unsupported events").
- **VerboseDebug** — `VerboseDebug(guard, run)`: renders when `o.verbose` regardless of `debug` (no debug suppression). **Defined but unused** — no rule in `Rules` uses it.
- **Fallback** — end of `displayClaudeEvent`: any event matching no rule is serialized via `JSON.stringify(e)` only when `o.verbose || o.debug`, else `''`.

Truncation helpers: `truncateLine(s, max=80)` cuts to `max-3` chars + `'...'`; `truncateText(s, maxLines=16)` keeps 8 head + 8 tail lines with a `... [N lines truncated] ...` marker between. `Assistant` text passes `Infinity` (no line-count truncation).

Cross-cutting quirk (all `tool_use` shapes): every guard uses `content.every(...)`, so an assistant event whose `content` mixes text with a tool call, or mixes two different tools, matches *no* specific guard and falls to `OtherToolUse` or the fallback. `events.ts:206` flags this: `// TODO: Technically different content types can be mixed in one event, support that`.

---

## type: `file-history-snapshot`

**FileHistorySnapshot** (`isFileHistorySnapshot`)
- Shape: `type === 'file-history-snapshot'`. No payload fields are read.
- Emitted: Claude Code records a working-copy file-history snapshot (session start / checkpoint). Exact trigger beyond that is unknown.
- Display: Verbose — `• File History Snapshot\n`.
- Notes: Body is discarded; renderer prints only the header. Suppressed unless `--verbose`.

## type: `permission-mode`

**PermissionMode** (`isPermissionMode`)
- Shape: `type === 'permission-mode'`; reads `permissionMode: string`.
- Emitted: when the session permission mode is set/changed (e.g. `default`, `acceptEdits`, `plan`, `bypassPermissions`).
- Display: Verbose — `• Permission Mode ${permissionMode}\n`.
- Notes: No truncation; value printed inline.

## type: `last-prompt`

**LastPrompt** (`isLastPrompt`)
- Shape: `type === 'last-prompt'`; reads `lastPrompt: string`.
- Emitted: records the most recent user prompt text; exact lifecycle point is unknown.
- Display: Verbose — `• Last Prompt\n| ${truncateText(lastPrompt)}\n`.
- Notes: 16-line window truncation.

## type: `queue-operation`

**EnqueueOperation** (`isEnqueueOperation`)
- Shape: `type === 'queue-operation'`, `operation === 'enqueue'`; reads `content: string`.
- Emitted: user queues a message mid-turn; `content` is the queued text.
- Display: Verbose — `• Enqueue\n| ${truncateText(content)}\n`.
- Notes: 16-line window truncation.

**DequeueOperation** (`isDequeueOperation`)
- Shape: `type === 'queue-operation'`, `operation === 'dequeue'`. No further fields read.
- Emitted: a queued message is consumed.
- Display: Verbose — `• Dequeue\n`.
- Notes: Header only.

**RemoveOperation** (`isRemoveOperation`)
- Shape: `type === 'queue-operation'`, `operation === 'remove'`. No further fields read.
- Emitted: a queued message is removed without being consumed.
- Display: Verbose — `• Remove\n`.
- Notes: Header only. In `Rules`, `PopAll` is listed before `Remove`; both discriminate on `operation`, so no collision.

**PopAllOperation** (`isPopAllOperation`)
- Shape: `type === 'queue-operation'`, `operation === 'popAll'`; reads `content: string`.
- Emitted: all queued messages flushed at once; `content` is the combined text.
- Display: Verbose — `• Pop All\n| ${truncateText(content)}\n`.
- Notes: Guard key is literal `'popAll'` (camelCase). 16-line truncation.

## type: `custom-title`

**CustomTitle** (`isCustomTitle`)
- Shape: `type === 'custom-title'`; reads `customTitle: string`.
- Emitted: a custom session title is set.
- Display: Always — `• Custom Title\n| ${truncateText(customTitle)}\n`.
- Notes: One of the few non-verbose metadata rules. Suppressed under `--debug`.

## type: `agent-name`

**AgentName** (`isAgentName`)
- Shape: `type === 'agent-name'`; reads `agentName: string`.
- Emitted: a named (sub)agent is identified for the turn.
- Display: Always — `• Agent Name\n| ${truncateText(agentName)}\n`.
- Notes: `truncateText` on a normally-single-line value; harmless.

## type: `attachment`

**SkillListingAttachment** (`isSkillListingAttachment`)
- Shape: `type === 'attachment'`, `attachment.type === 'skill_listing'`; reads `attachment.content: string`.
- Emitted: a skills catalog is attached to context.
- Display: Verbose — `• Skill Listing\n| ${truncateText(attachment.content)}\n`.
- Notes: 16-line truncation of a typically long listing.

**CommandPermissionsAttachment** (`isCommandPermissionsAttachment`)
- Shape: `type === 'attachment'`, `attachment.type === 'command_permissions'`; reads `attachment.allowedTools: string[]`.
- Emitted: a slash command declares its allowed-tools.
- Display: Verbose — `• Allowed Tools\n| ${allowedTools.join('\n| ')}\n`.
- Notes: No truncation; each tool on its own `|` line.

## type: `system`

**TurnDuration** (`isTurnDuration`)
- Shape: `type === 'system'`, `subtype === 'turn_duration'`; reads `durationMs: number`, `messageCount: number` (also guards `timestamp: string`, but does not print it).
- Emitted: end of an assistant turn; timing/message-count stats.
- Display: Always — `• Turn Duration\n| ${durationMs}ms, ${messageCount} messages\n`.
- Notes: `timestamp` is validated but never rendered.

**ApiError** (`isApiError`)
- Shape: `type === 'system'`, `subtype === 'api_error'`. No payload fields read.
- Emitted: the provider/API returned an error during the turn.
- Display: Always — `• API Error\n`.
- Notes: Header only; any error detail in the event is discarded.

## type: `assistant`

Ordering in `Rules`: `Synthetic` → `EncryptedThinking` → `Thinking` → `Bash` → `Write` → `Read` → `Edit` → `Skill` → `Agent` → `ToolSearch` → `Grep` → (`ToolReference`/`AskUserQuestion` etc.) → `OtherToolUse` → `Assistant`. `Assistant` (plain text) is the catch-all and must stay last among `assistant` shapes.

**Synthetic** (`isSynthetic`)
- Shape: `type === 'assistant'`, `message.model === '<synthetic>'`, `message.content[].text: string`.
- Emitted: non-model assistant content injected by bare-claude — e.g. preloaded `--read` files in the synthetic session (README "Pre-read files").
- Display: Always — `• Synthetic\n| ${content.flatMap(t => truncateText(t.text))}\n`.
- Notes: Checked before all other `assistant` shapes; every other `assistant` guard explicitly excludes `model === '<synthetic>'`.

**EncryptedThinking** (`isEncryptedThinking`)
- Shape: `type === 'assistant'`, `message.type === 'message'`, each `content[]` is `type === 'thinking'` with `thinking === ''` and `signature: string`.
- Emitted: redacted/encrypted extended-thinking (signature present, no plaintext).
- Display: Verbose — `• Encrypted Thinking\n`.
- Notes: Header only; the signature is not printed. Listed before `Thinking`, which requires the opposite (`signature` absent/empty).

**Thinking** (`isThinking`)
- Shape: `type === 'assistant'`, `message.type === 'message'`, each `content[]` is `type === 'thinking'` with non-empty `thinking: string` and no/empty `signature`.
- Emitted: extended-thinking block(s) with visible reasoning text (seen in `session-events-example.txt`).
- Display: Always — `• Thinking\n| ${content.flatMap(t => truncateText(t.thinking))}\n`.
- Notes: 16-line truncation per block; the `... [N lines truncated] ...` marker appears in the sample transcript.

**Bash** (`isBash`)
- Shape: `tool_use`, `name === 'Bash'`; reads `input.command: string`, optional `input.description: string`.
- Emitted: Claude runs a shell command.
- Display: Always — `• Bash\n| ${description? truncateLine + command(truncateText)}\n`.
- Notes: `description` line-truncated (80); `command` 16-line truncated. Falsy description filtered out.

**Write** (`isWrite`)
- Shape: `tool_use`, `name === 'Write'`; reads `input.file_path: string`, `input.content: string`.
- Emitted: Claude writes a file.
- Display: Always — `• Write\n| ${file_path}\n| ${truncateText(content)}\n`.
- Notes: File body 16-line truncated; path untruncated.

**Read** (`isRead`)
- Shape: `tool_use`, `name === 'Read'`; reads **only** `input.file_path: string`.
- Emitted: Claude reads a file (seen in `session-events-example.txt`).
- Display: Always — `• Read\n| ${file_path}\n`.
- Notes: The interface and guard capture only `file_path`; the file *text* is not in this event — it arrives later in the paired `tool_result`. The "Read should display file text only in verbose mode" TODO therefore cannot be satisfied from this event alone; it needs the `tool_use`↔`tool_result` pairing described below.

**Edit** (`isEdit`)
- Shape: `tool_use`, `name === 'Edit'`; reads `input.file_path`, `input.old_string`, `input.new_string`, optional `input.replace_all: boolean`.
- Emitted: Claude edits a file.
- Display: Always — `• Edit\n| ${file_path}\n| [Replace All]\n| Old\n| ${truncateText(old_string)}\n| New\n| ${truncateText(new_string)}\n`.
- Notes: `Replace All` label shown only when `replace_all` truthy; both strings 16-line truncated.

**Skill** (`isSkill`)
- Shape: `tool_use`, `name === 'Skill'`; reads `input.skill: string`, optional `input.args: string`.
- Emitted: Claude invokes a skill.
- Display: Always — `• Skill\n| ${skill}\n| ${args?}\n`.
- Notes: `args` line dropped when falsy; no truncation.

**Agent** (`isAgent`)
- Shape: `tool_use`, `name === 'Agent'`; reads `input.description: string`, `input.prompt: string`, optional `input.subagent_type`, `input.model`.
- Emitted: Claude launches a sub-agent.
- Display: Always — `• Agent\n| ${subagent_type?}\n| ${model?}\n| ${truncateLine(description)}\n| ${truncateText(prompt)}\n`.
- Notes: `description` line-truncated (80); `prompt` 16-line truncated; optional fields filtered when falsy.

**ToolSearch** (`isToolSearch`)
- Shape: `tool_use`, `name === 'ToolSearch'`; reads `input.query: string`.
- Emitted: Claude searches for a dynamically-loadable tool.
- Display: Verbose — `• Tool Search\n| ${query}\n`.
- Notes: No truncation.

**Grep** (`isGrep`)
- Shape: `tool_use`, `name === 'Grep'`; reads `input.pattern: string`, optional `input.path`, `input.output_mode`.
- Emitted: Claude runs a search.
- Display: Always — `• Grep\n| ${pattern}\n| in ${path?}\n| mode: ${output_mode?}\n`.
- Notes: Optional lines emitted only when present. No truncation.

**AskUserQuestion** (`isAskUserQuestion`)
- Shape: `tool_use`, `name === 'AskUserQuestion'`; reads `input.questions[]` with `question`, `header`, `options[]{ label, description }`.
- Emitted: Claude asks the user a multiple-choice question.
- Display: Verbose — `• Ask User Question\n| ${per-question: truncateLine(header), truncateText(question), options[truncateLine(label), truncateText(description)]}\n`.
- Notes: `display.ts:155` flags this: `// TODO: This especially is in dire need of additional formatting for readability`. The nested arrays are flattened via `.flat(Infinity)`, so structure is largely lost.

**TaskCreate** (`isTaskCreate`)
- Shape: `tool_use`, `name === 'TaskCreate'`; reads `input.subject`, `input.description` (also guards `activeForm`, not printed).
- Emitted: Claude creates a task.
- Display: Always — `• Task Create\n| ${truncateLine(subject)}\n| ${truncateText(description)}\n`.
- Notes: `activeForm` validated but not rendered.

**TaskUpdate** (`isTaskUpdate`)
- Shape: `tool_use`, `name === 'TaskUpdate'`; reads `input.taskId`, `input.status`.
- Emitted: Claude updates a task's status.
- Display: Always — `• Task Update\n| ${taskId}: ${status}\n`.
- Notes: No truncation.

**EnterPlanMode** (`isEnterPlanMode`)
- Shape: `tool_use`, `name === 'EnterPlanMode'`; only `input` object presence is guarded.
- Emitted: Claude enters plan mode.
- Display: Always — `• Enter Plan Mode\n`.
- Notes: Header only.

**ExitPlanMode** (`isExitPlanMode`)
- Shape: `tool_use`, `name === 'ExitPlanMode'`; only `input` object presence is guarded.
- Emitted: Claude exits plan mode (presenting a plan).
- Display: Always — `• Exit Plan Mode\n`.
- Notes: Header only; the plan text (if any in `input`) is not rendered.

**OtherToolUse** (`isOtherToolUse`)
- Shape: `tool_use` whose `name` is none of the enumerated tools (guard lists Bash/Grep/Write/Edit/Read/Skill/Agent/ToolSearch/AskUserQuestion/TaskCreate/TaskUpdate/EnterPlanMode/ExitPlanMode); reads `name` and `input`.
- Emitted: Claude calls any tool without a dedicated renderer.
- Display: Debug — `• Tool\n| ${name}\n| ${JSON.stringify(input)}\n`. Renders regardless of flags and is the one shape that still prints under `--debug`.
- Notes: `events.ts:630` comment `// Make sure to list all supported tools here.` — the exclusion list must be kept in sync with the specific guards, or a supported tool could double-match. `ToolReference` is *not* excluded here because it is a `user` event, not `assistant`.

**Assistant** (`isAssistant`)
- Shape: `type === 'assistant'`, `message.type !== 'thinking'`, `message.content[].text: string`, `model !== '<synthetic>'`.
- Emitted: normal assistant message text (seen in `session-events-example.txt`).
- Display: Always — `• Assistant\n| ${content.flatMap(t => truncateText(t.text, Infinity))}\n`.
- Notes: Catch-all for `assistant`; `truncateText(..., Infinity)` disables line-count truncation, so full text is printed. Because `tool_use` blocks lack a `text` field, this guard does not swallow tool calls.

## type: `user`

Ordering in `Rules`: `ToolReference` (Verbose) → `Assistant`/`OtherToolUse` (assistant only) → `ToolResult` → `ToolResultArray` → `User` → `UserArray`. `ToolReference` precedes `ToolResultArray`; their `content[].type` values (`tool_reference` vs `text`) keep them disjoint.

**User** (`isUser`)
- Shape: `type === 'user'`, `message.content: string`.
- Emitted: a user message with plain-string content (the opening `• User` in `session-events-example.txt`).
- Display: Always — `• User\n| ${truncateText(content)}\n`.
- Notes: 16-line truncation. `events.ts:760` carries the `// TODO: This should be grouped by the tool_use_id in the output` marker (mis-placed on a plain user message).

**UserArray** (`isUserArray`)
- Shape: `type === 'user'`, `message.content[].text: string`.
- Emitted: a user message whose content is an array of text blocks.
- Display: Always — `• User\n| ${content.flatMap(t => truncateText(t.text))}\n`.
- Notes: Same header as `User`.

**ToolResult** (`isToolResult`)
- Shape: `type === 'user'`, each `message.content[]` is `type === 'tool_result'` with `content: string`. **No `tool_use_id` is read.**
- Emitted: a tool returns a plain-string result to Claude (the `> …` lines in the sample transcript).
- Display: Always — `> ${content.flatMap(t => truncateText(t.content))}\n`.
- Notes: `events.ts:679` — `// TODO: This should be grouped by the tool_use_id in the output`. 16-line truncation. Rendered with a bare `>` prefix and no owning-tool header.

**ToolResultArray** (`isToolResultArray`)
- Shape: `type === 'user'`, each `message.content[]` is `type === 'tool_result'` whose `content[]` is `type === 'text'` with `text: string`. **No `tool_use_id` is read.**
- Emitted: a tool returns a result as an array of text blocks.
- Display: Always — `> ${content.flatMap(t => t.content.flatMap(c => truncateText(c.text)))}\n`.
- Notes: `events.ts:704` — same `tool_use_id` TODO. 16-line truncation.

**ToolReference** (`isToolReference`)
- Shape: `type === 'user'`, each `message.content[]` is `type === 'tool_result'` whose `content[]` is `type === 'tool_reference'` with `tool_name: string`. **No `tool_use_id` is read.**
- Emitted: a tool result that references other tools by name (e.g. `ToolSearch`/dynamic tool loading).
- Display: Verbose — `• Tool Reference\n| ${content.map(t => t.content.map(r => r.tool_name))}\n`.
- Notes: `events.ts:735` — same `tool_use_id` TODO. When *not* `--verbose`, this event matches no rule (the `text`-typed `ToolResultArray` guard rejects `tool_reference`) and hits the fallback (JSON only under `--verbose`/`--debug`, else `''`).

---

## Pairing tool_use with tool_result

**How the pairing is supposed to work (raw NDJSON / Anthropic Messages tool-use schema).** A tool call and its result live in two separate top-level events:

- The call is an `assistant` event: `message.content[]` block with `type: "tool_use"`, carrying the call identifier field **`id`** (e.g. `"toolu_01…"`), plus `name` and `input`.
- The result is a `user` event: `message.content[]` block with `type: "tool_result"`, carrying **`tool_use_id`**, plus `content`.

A result is matched to the call that produced it by equality of the identifiers: **`tool_result.tool_use_id === tool_use.id`**. The `id` lives on the `assistant` `tool_use` block; the `tool_use_id` lives on the `user` `tool_result` block.

**What the current guards do with those ids — they drop both.** Reading `src/events.ts` directly:

- The `tool_use` interfaces (`Bash`, `Write`, `Read`, `Edit`, `Skill`, `Agent`, `ToolSearch`, `Grep`, `AskUserQuestion`, `TaskCreate`, `TaskUpdate`, `EnterPlanMode`, `ExitPlanMode`, `OtherToolUse`) declare each content block as `{ type: 'tool_use'; name; input }` and their guards check exactly `c.type === 'tool_use'`, `c.name`, and `c.input`. **None references `id`.** The call identifier is present in the raw event but never captured or typed.
- The `tool_result` interfaces (`ToolResult`, `ToolResultArray`, `ToolReference`) declare each block as `{ type: 'tool_result'; content }` and their guards check exactly `c.type === 'tool_result'` and `c.content`. **None references `tool_use_id`.** The back-reference is present in the raw event but never captured or typed.

So both halves of the pairing key are discarded at the guard boundary. This is exactly what the four `// TODO: This should be grouped by the tool_use_id in the output` markers in `events.ts` (on `isToolResult:679`, `isToolResultArray:704`, `isToolReference:735`, and `isUser:760`) are pointing at: the renderer emits every `tool_result` as a free-floating `> …` line with no way to attach it to its originating `tool_use`, because the discriminating id was thrown away.

**Why this blocks "Read should display file text only in verbose mode."** The `Read` event (`isRead`) carries only `input.file_path`; the file *text* is only ever present in the paired `tool_result`. To render that text under the `Read` entry (and gate it behind `--verbose`), the renderer must join the `Read` `tool_use.id` to the `tool_result.tool_use_id` — but `isRead` never captures `id` and the `tool_result` guards never capture `tool_use_id`. The pairing id is dropped on both sides, so the join is impossible with the current guards. Closing that gap (adding `id` to the `tool_use` shapes and `tool_use_id` to the `tool_result` shapes, then grouping on it) is the prerequisite the TODO needs.

*Sourcing note:* field names on the guards (`type`, `name`, `input`, `content`, and the absence of `id`/`tool_use_id`) are quoted directly from `src/events.ts`, which I read. The raw-NDJSON field names `id` and `tool_use_id` are the Anthropic Messages tool-use schema names; the example file accessible to me (`session-events-example.txt`) was already-rendered transcript output (`• User` / `• Thinking` / `> …`), not raw NDJSON, so those two literals are cited from the schema rather than transcribed from a raw sample.
