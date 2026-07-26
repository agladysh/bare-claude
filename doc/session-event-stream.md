# Bare Claude — Session Event Stream Rendering Reference

Source of truth: `src/events.ts` (type guards, one per recognized shape) and `src/display.ts` (the ordered rule tables + fallback). This reference describes what `TranscriptRenderer` recognizes and renders. Symbols are cited by name, never by line number — line numbers rot within a commit.

Corpus figures below were measured on 2026-07-26 against `~/.claude/projects/**/*.jsonl` on the author's machine: 954 session files, ~102 000 records, written by `claude` 2.1.220 and its predecessors. Re-measure, and re-date, when they stop holding.

## Rendering is per content block, not per record

A record is dispatched in two stages.

1. **Standalone events** — `EventRules` is walked first. These are the metadata records that carry no `message.content` array, plus `user` records whose content is a bare string.
2. **Content blocks** — if the record is a `BlockMessage` (`type` is `assistant` or `user` and `message.content` is an array), every block in that array is dispatched independently through `AssistantBlockRules` or `UserBlockRules`, and the results are concatenated in order.

The two stages are disjoint, so their relative order is not load-bearing; order *within* a table is.

This matters because the guards used to be written with `content.every(...)`, which meant a record only matched when *all* of its blocks agreed. A record mixing prose with a tool call, or carrying two tool calls, matched no specific guard, was rejected by the catch-all tool guard (a known tool name was present) and by the prose guard (a `tool_use` block has no `text`), and therefore rendered as **nothing**. Measured: 11 such records, every one of them in a subagent transcript or from a non-Opus model (`glm-5.2`, `claude-fable-5`, `claude-opus-4-8`). All 11 render now.

Single-block records — 99.98% of the corpus — render byte-for-byte as they did before the split.

### Falling through

- A block no rule matches renders as `JSON.stringify(block)` under `--verbose`/`--debug`, and as `''` otherwise.
- A record where **not one** block matched falls through to the whole-record fallback instead, so the envelope (model, uuid, timestamps) stays visible for a genuinely unknown shape.
- The whole-record fallback is `JSON.stringify(record)` under `--verbose`/`--debug`, `''` otherwise.

Measured after the split: **zero** unrecognized content blocks across the corpus, and zero unrecognized `assistant`/`user` records.

## Rule combinators (from `display.ts`)

Each table is walked in array order; the first rule to return a non-`null` value wins, and `''` is a value. "Matching" and "rendering" are separate: a rule that matches but has nothing to say at the current verbosity returns `''`, which still stops the walk. That is what keeps a quiet block from leaking into a later catch-all.

- **Always** — `Rule(guard, run)`: renders when the guard matches, except under `--debug`, where it matches and returns `''`. Shown by default and under `--verbose`; silent under `--debug`.
- **Verbose** — `Verbose(guard, run)`: matches whenever the guard matches; renders only when `o.verbose && !o.debug`, and returns `''` otherwise.
- **Debug** — `Debug(guard, run)`: renders whenever the guard matches, with no flag gate. It is the only family that still prints under `--debug` when everything else goes quiet. Only the catch-all tool rule uses it, which is what gives `--debug` its "show me the tool calls nothing renders" behaviour (README: "displays only unsupported events").
- **VerboseDebug** — `VerboseDebug(guard, run)`: like `Verbose` but without the debug suppression. **Defined but unused.**

Truncation helpers: `truncateLine(s, max = 80)` cuts to `max - 3` chars plus `'...'`; `truncateText(s, maxLines = 16)` keeps 8 head and 7 tail lines with a `... [N lines truncated] ...` marker between, so a truncated block never renders more lines than the block it stands in for. Assistant prose passes `Infinity` and is never line-truncated.

## Line prefixes

Three, and only three:

| Prefix | Meaning |
| --- | --- |
| `• ` | Header: what happened. |
| `\| ` | Body of a header — what Claude said, thought, or asked a tool to do. |
| `> ` | A tool result — what came back. |

Every line of a multi-line body carries its prefix, including the first line after the header and including every continuation line of a `>` block. The transcript is greppable: `grep '^> '` is exactly the tool output, `grep '^• '` is exactly the event spine.

---

## Standalone events

Walked in this order. Guards discriminate on `type` (and `subtype`/`operation`), so the order is documentation rather than disambiguation.

| Guard | Level | Renders | Notes |
| --- | --- | --- | --- |
| `isFileHistorySnapshot` | Verbose | `• File History Snapshot` | Header only; the snapshot body is discarded. |
| `isFileHistoryDelta` | Verbose | `• File History Delta` + `trackingPath` | 661 records measured. One tracked file's change against the last snapshot. |
| `isPermissionMode` | Verbose | `• Permission Mode <mode>` | `default`, `acceptEdits`, `plan`, `bypassPermissions`. |
| `isMode` | Verbose | `• Mode <mode>` | 2 231 records, every one `normal`. Introduced by 2.1.220; distinct from the permission mode. |
| `isAgentSetting` | Verbose | `• Agent Setting <setting>` | 219 records, every one `claude`. |
| `isLastPrompt` | Verbose | `• Last Prompt` + text | 16-line truncation. |
| `isEnqueueOperation` | Verbose | `• Enqueue` + text | `type: 'queue-operation'`, `operation: 'enqueue'`. |
| `isDequeueOperation` | Verbose | `• Dequeue` | Header only. |
| `isPopAllOperation` | Verbose | `• Pop All` + text | Guard key is literal `'popAll'`, camelCase. |
| `isRemoveOperation` | Verbose | `• Remove` | Header only. |
| `isCustomTitle` | Always | `• Custom Title` + text | **Zero records measured.** Claude Code writes `ai-title` unless a title is set by hand. |
| `isAiTitle` | Always | `• AI Title` + text | 2 272 records. The title a real transcript actually carries. |
| `isAgentName` | Always | `• Agent Name` + text | |
| `isSkillListingAttachment` | Verbose | `• Skill Listing` + text | `type: 'attachment'`, `attachment.type: 'skill_listing'`. |
| `isCommandPermissionsAttachment` | Verbose | `• Allowed Tools` + one tool per line | `attachment.type: 'command_permissions'`. No truncation. |
| `isUserText` | Always | `• User` + text | `type: 'user'` with `message.content` a bare string. 16-line truncation. |
| `isTurnDuration` | Always | `• Turn Duration` + `<ms>ms, <n> messages` | `type: 'system'`, `subtype: 'turn_duration'`. `timestamp` is guarded but not printed. |
| `isApiError` | Always | `• API Error` | `type: 'system'`, `subtype: 'api_error'`. Any detail in the record is discarded. |

## `assistant` content blocks

Walked in this order. The two catch-alls are last for a reason, and moving them breaks the table.

| Guard | Level | Renders |
| --- | --- | --- |
| `isEncryptedThinkingBlock` | Verbose | `• Encrypted Thinking` |
| `isThinkingBlock` | Always | `• Thinking` + `truncateText(thinking)` |
| `isFallbackBlock` | Always | `• Model Fallback` + `<from> → <to>` |
| `isBashBlock` | Always | `• Bash` + `truncateLine(description)?` + `truncateText(command)` |
| `isWriteBlock` | Always | `• Write` + `file_path` + `truncateText(content)` |
| `isReadBlock` | Always | `• Read` + `file_path` |
| `isEditBlock` | Always | `• Edit` + `file_path` + `Replace All`? + `Old` + old + `New` + new |
| `isSkillBlock` | Always | `• Skill` + `skill` + `args`? |
| `isAgentBlock` | Always | `• Agent` + `subagent_type`? + `model`? + `truncateLine(description)` + `truncateText(prompt)` |
| `isToolSearchBlock` | Verbose | `• Tool Search` + `query` |
| `isGrepBlock` | Always | `• Grep` + `pattern` + `in <path>`? + `mode: <output_mode>`? |
| `isAskUserQuestionBlock` | Verbose | `• Ask User Question` + flattened questions/options |
| `isTaskCreateBlock` | Always | `• Task Create` + `truncateLine(subject)` + `truncateText(description)` |
| `isTaskUpdateBlock` | Always | `• Task Update` + `<taskId>: <status>`? + `Blocked By <ids>`? + `truncateText(description)`? |
| `isEnterPlanModeBlock` | Always | `• Enter Plan Mode` |
| `isExitPlanModeBlock` | Always | `• Exit Plan Mode` |
| `isAnyToolUseBlock` | Debug | `• Tool` + `name` + `JSON.stringify(input)` |
| `isTextBlock` | Always | `• Synthetic` or `• Assistant` + text |

### Notes

**`isThinkingBlock` vs `isEncryptedThinkingBlock`.** They discriminate on whether `thinking` is empty, and on nothing else. The guard used to additionally require the signature to be absent or empty on the readable shape; measured, 87 of 16 503 thinking blocks carry *both* readable text and a non-empty signature, and every one of them matched neither shape and rendered as nothing. 16 070 blocks are genuinely encrypted (empty `thinking`, signature present); the remaining 346 are readable with no signature.

**`isFallbackBlock`.** `{ type: 'fallback', from: { model }, to: { model } }` — the turn was served by a different model than the one it started on. 16 blocks measured, every one a downgrade away from `claude-fable-5`. Rendered at Always level on purpose: a hermetic run cannot let the model change underneath it silently.

**`isAnyToolUseBlock` is the catch-all, and it excludes nothing.** It matches every `tool_use` block whatever its name. It is correct only because it sits after every specific tool rule, and because a `Verbose` rule *matches* even when it renders nothing — so a quiet `ToolSearch` block stops the walk rather than falling through to be dumped as raw input.

The previous design kept a hardcoded list of "tools that have their own guard" and subtracted it. That list had to be kept in sync by hand, and it was wrong in a way no sync could fix: originally measured, 9 calls in the corpus named a *known* tool but carried input the specific guard rejected — a `TaskUpdate` carrying `{ taskId, addBlockedBy }` with no `status`, a `Read` whose arguments arrived as `input.__unparsedToolInput` because the model emitted invalid JSON. Being a known name, they were excluded from the catch-all; failing the specific guard, they matched nothing. All nine rendered as nothing. Ordering catches them and prints the input the model actually sent.

Re-measured 2026-07-26 after `isTaskUpdateBlock` was loosened to accept a partial update (see below): only **2** calls remain in this state, both the same `Read`/`__unparsedToolInput` shape. The 7 `TaskUpdate` calls that used to land here now match their own rule instead.

**`isTaskUpdateBlock` accepts a partial update.** `taskId` is the only field every call carries. Measured 2026-07-26 over the local corpus, a call touches exactly one of `status` (64 calls), `addBlockedBy` (6 calls, a `string[]` of task ids), or `description` (1 call) — never more than one alongside `taskId`, and this is presumably how the tool is actually invoked turn over turn, but the guard does not enforce it: the type declares all three optional so a future call combining them still matches. The renderer prints whichever of the three are present — `status` inline with the id, `addBlockedBy` and `description` each on their own `| ` line — falling back to the bare `taskId` when none are. Before this, a call missing `status` (7 of the 71 measured) matched neither this guard nor any other and fell to the `isAnyToolUseBlock` catch-all above.

**`isTextBlock` is the prose catch-all and must stay last.** It accepts a bare `{ text }` block with no `type`, which is what `SessionBuilder` and the vendored forks emit; every block in the measured corpus does carry `type: 'text'`. It branches on the enclosing record: `message.model === '<synthetic>'` renders `• Synthetic` with 16-line truncation, anything else renders `• Assistant` untruncated. `<synthetic>` is Claude Code's own marker for fabricated assistant content — 157 records measured.

Note that the `<synthetic>` check now applies only to *prose*. A preloaded `Read` in a synthetic session renders as `• Read` like any other, because block guards see one block and cannot see the model. Under per-record dispatch every non-synthetic guard excluded `<synthetic>`, so a preloaded tool call rendered as raw JSON or not at all.

## `user` content blocks

| Guard | Level | Renders |
| --- | --- | --- |
| `isToolReferenceBlock` | Verbose | `• Tool Reference` + `[ToolName]`? + one `tool_name` per line |
| `isToolResultBlock` | Always | `> ` + `[ToolName]`? + `truncateText(content)`, or `> [ToolName]`? + `[N lines]` |
| `isToolResultTextBlock` | Always | `> ` + `[ToolName]`? + text of each block, or `> [ToolName]`? + `[N lines]` |
| `isToolResultImageBlock` | Always | `> [ToolName]`? + `[<media_type>]` per image |
| `isImageBlock` | Always | `• Image` + `media_type` |
| `isTextBlock` | Always | `• User` + `truncateText(text)` |

### Notes

All four `tool_result` guards read `tool_use_id` when present and tolerate its absence.

**The three array-shaped `tool_result` guards each reject an empty array**, because `[].every(...)` is vacuously true and all three would otherwise match. No empty ones exist in the corpus.

**Images.** 206 `tool_result` blocks and 3 top-level `user` blocks carry a base64 image. None of them rendered at all before; both now do, by media type. No inner `tool_result` content array in the corpus mixes block kinds — text arrays are all text, image arrays are all images — so the three inner shapes are guarded separately rather than dispatched recursively. A mixed array would fall to the block fallback.

**`[ToolName]`** is the grouping tag described below — every one of these four guards can carry it, prepended to the first rendered line.

## Pairing `tool_use` with `tool_result`

A tool call and its result live in two separate records:

- the call is an `assistant` record with a `message.content[]` block of `type: 'tool_use'`, carrying **`id`**, plus `name` and `input`;
- the result is a `user` record with a `message.content[]` block of `type: 'tool_result'`, carrying **`tool_use_id`**, plus `content`.

They match on `tool_result.tool_use_id === tool_use.id`. Both halves of that key are declared and read: `ToolUseBlock` requires `id`, and every `tool_result` shape declares an optional `tool_use_id`.

`TranscriptRenderer` maintains the join in a private `Map<string, string>` from `tool_use.id` to tool name:

- **learn** — before rendering, every `tool_use` block of an `assistant` record with an `id` is recorded. This happens per block, so a record mixing prose with a tool call teaches the renderer just as well as a pure tool-call record does. The old pairing guard demanded that *every* block be a `tool_use`, so mixed records taught it nothing.
- **use** — a `tool_result` whose call was a `Read` collapses to `> [N lines]` instead of printing the file back, unless `--verbose`; and every result's first line may carry a `[ToolName]` grouping tag (below).
- **consume** — after rendering, every `tool_use_id` the record referenced is deleted. Measured over the five largest local transcripts: a result follows its call by 1.05 records on average and 5 at worst, and exactly one call in 1 498 went unanswered. The table therefore holds only outstanding calls and stays effectively empty for the life of a stream.

The table used to be a module-level `Map` shared by every consumer of the library and never cleared. It is now owned by the renderer instance, so two streams rendered in one process cannot see each other's calls, and a renderer can be dropped or `reset()` to forget everything at once.

`displayClaudeEvent(e, options)` remains, as a one-shot for inspecting a single record. It constructs a throwaway renderer, so it has **no pairing memory**: a `Read` result rendered through it prints in full, and — since the grouping tag below needs that same memory across two `display()` calls — a result rendered through it never carries a tag either. Use `TranscriptRenderer` to render a stream.

### Grouping a result with its call

Before this, a `tool_result` was a free-floating `> ` block with no visible link to the call it answered. In a quiet transcript that link is implicit — a call and its result are almost always adjacent — but a busy one can interleave several outstanding calls (parallel `tool_use` blocks in one record, or a slow call whose result lands several records after a second call has already started), and at that point position alone no longer tells a reader which result goes with which call.

The rule: **a result's first rendered line is prefixed with `[ToolName] ` exactly when more than one call is outstanding at the moment it renders; otherwise the line is untouched.** "Outstanding" is read straight off the pairing table's size, captured once per record before that record's own results are consumed, so every result in a single multi-result record sees the same count and either all of them are tagged or none are. Concretely:

- **The ordinary case — one call, then its result — is untouched.** The pairing table holds exactly one entry throughout, so `outstandingCalls() === 1` and no tag is added. This is true even when several unrelated records (thinking, permission changes, an unrelated later call answered first) separate the call from its result: as long as only one call is unanswered at a time, there is nothing to disambiguate. This is the overwhelmingly common shape, and it renders byte-for-byte as it did before grouping existed.
- **Parallel calls tag every one of their results.** Two `tool_use` blocks in one `assistant` record push the table to size 2; whichever result answers first still sees size 2 (the other call's entry is still outstanding), so both get tagged — `> [Bash] total 4` / `> [Grep] no matches`, say — even if the two calls share no other relationship.
- **A call that is never answered (measured: 1 in 1 498) keeps tagging every later result until the table is `reset()`.** The stale entry never leaves the table, so any subsequent call, however solitary in intent, finds itself sharing the table with that orphan and its result is tagged too. This over-tags relative to a hypothetical omniscient reader, but never under-tags: erring toward "here's which call this is" is the safer failure mode for a rendering tool built to make a transcript legible.
- **The tag never adds a line.** It is prepended to the existing first line — `total 4` becomes `[Bash] total 4`, not a new `[Bash]` line above it — so a tagged multi-line result has exactly as many lines as an untagged one. `isToolReferenceBlock` is the one exception in placement, not in trigger: it renders `•`/`| ` rather than `>`, so its tag is appended to the header line (`• Tool Reference [ToolSearch]`) instead of the body.
- **A call this renderer never saw gets no tag.** `toolName(id)` returns `undefined` for an id outside the pairing table (unpaired result, or the call happened before this renderer existed), and `resultTag` requires a known name before it looks at the outstanding count at all.

Every collapsed `Read` result can still carry a tag on top of its collapse — `> [Read] [3 lines]` — since collapsing and tagging answer different questions (how much to show, versus which call this is) and compose without conflict.

## Deliberately not recognized

Every record type below still falls to the JSON fallback. Counts measured 2026-07-26.

| Type | Count | Why not |
| --- | --- | --- |
| `attachment` (19 further subtypes) | 2 392 | `task_reminder`, `deferred_tools_delta`, `hook_success`, `edited_text_file`, `read_truncation_notice`, `agent_listing_delta`, `queued_command`, `plan_mode*`, `budget_usd`, `date_change`, … Each carries a differently-shaped payload. A generic `• Attachment <subtype>` rule would suppress 2 392 raw dumps at the cost of throwing their content away, which is worse than the dump under `--verbose`. |
| `started`, `result` | 991 | Only ever found in `*/subagents/workflows/*/journal.jsonl` — a workflow journal, not a session transcript. `result.result` is arbitrary caller-defined JSON with no stable shape. |
| `system` (7 further subtypes) | 276 | `stop_hook_summary` (163), `away_summary` (97), `local_command` (7), `model_refusal_fallback` (5), `informational` (2), `model_refusal_no_fallback` (1), `compact_boundary` (1). Same trade-off as `attachment`. `compact_boundary` is the one worth a dedicated rule when it becomes common — it marks a discontinuity in the transcript. |
| `last-prompt` with `lastPrompt: null` | 5 | The guard requires a string. |
| `relocated`, `worktree-state`, `frame-link` | 5 | Too rare to design against. |
