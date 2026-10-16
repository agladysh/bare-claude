# 2026-10-16 — reading a finished run's result and journal

Opus 5.5, Read/Grep/Glob only, over two rounds; nothing was run at authoring. Root then
integrated onto 0fa4f8a (v0.10.0), corrected the join contract and ran typecheck and tests:
clean, 449 pass, 1 skip, 1500 assertions.

## What was measured, how

Read, not executed, from retained records of a private estate, written by Claude Code 2.1.292 on
one macOS host. The probe was a text search over `--output-format json` results and session
journals, with field values compared by hand.

- **Replay.** One CLI process read seven retained result/journal pairs, offline: five joined,
  one of another session `no-match`, one with no measured call `not-comparable`. No `process`
  carried a `prompt`. The receipt does not record `lastCallPromptTokensAgree` or the reader version.
- **Version.** Every journal record envelope that carries one says `"version":"2.1.292"`. Neither
  the result nor a `cost-state` record has a version field.
- **`cost-state` records.** Keys: `type, sessionId, totalCostUSD, totalAPIDuration,
  totalAPIDurationWithoutRetries, totalToolDuration, totalLinesAdded, totalLinesRemoved,
  totalDuration, startTime, modelUsage, hasUnknownModelCost`. There is no `uuid` and no
  `timestamp`. In one journal there were twelve; `startTime` was constant and the totals only
  grew. Each result's `total_cost_usd` and `duration_api_ms` equalled one of them exactly.
  `duration_ms` was far below the record's `totalDuration`, so it belongs to the process.
- **Segments are not processes.** Another session's journal had three `cost-state` records,
  while six run directories used that session. Some processes wrote no closing record; other
  journal copies were seeded from earlier branches. In one retained copy, a resumed process
  ending on an account limit with no API call wrote a second `cost-state` record with identical
  totals. A later copy, seeded before it, did not hold it. The independent delta reception
  established this; the earlier crash-merge-only account was too broad.
- **The context limit in the journal.** It is an assistant record with `model:"<synthetic>"`,
  `isApiErrorMessage:true`, `error:"invalid_request"` and text "Prompt is too long". The result
  has `terminal_reason:"blocking_limit"`, `is_error:true`, `subtype:"success"` and
  `api_error_status:null`. Where the limit is enforced is not established.
- **`usage.iterations`** held one entry in every result read.
- **Other result fields.** `stop_reason` and `safety_stops` are present on results.
  `total_tokens_reminder` attachments count a separate token budget, not context.
- **`compact_boundary`.** No retained journal read held one.

## Decisions

- **An offline reader, not live capture.** Under `--print` stdout is inherited, so the CLI never
  holds the result bytes. A supervising launcher that keeps native output reads them at the end.
- **A missing count is null.** Zero is a measured value. A prompt is a measurement only when all
  three input counts are present and their total is nonzero: Claude Code's own resume rule,
  applied on purpose.
- **A join needs the session, exact totals and a measured last call on both sides.**
  Records carry no invocation identifier; this is a correlation, not proof of process identity. A refusal is
  one of `no-match`, `ambiguous` (several cost-state records state the same totals),
  `disagrees` (the measured last-call prompt token totals differ) or `not-comparable`.
- **A batch reader.** Repeated private use should not start one Bun process per file. Each path
  is read once per batch.
- **`no-error` is not delivery.** A completed run can deliver part of a task. `stop_reason` and
  `safety_stops` are carried verbatim and not classified.

## Where a previous report was wrong

- `lastCallAgrees` named agreement of the whole last call; the code compares prompt token totals
  only. It is now `lastCallPromptTokensAgree`: `false` compared and different, `true` on a join,
  `null` not compared. Equal counts show neither the same prompt nor the same call.

- The first round said the native version was "recorded in neither" result nor journal. It is on
  every journal record envelope.
- The first round called segments processes.
- It read missing counts as zero.
- It joined without a session check and despite disagreement.
- It described its fixtures as shaped after retained records while carrying their figures. This
  round's test data is constructed and labelled so.

## Not established

- What several `usage.iterations` entries mean.
- Whether `cost-state` is written anywhere other than at process end.
- What `compact_boundary` holds.
- Whether `num_turns` counts earlier processes.
- How often totals repeat beyond the observed case.
- None of this is measured on a build other than 2.1.292. A native probe (a run that hits the
  limit, a run with compaction on, a resume after a failure) should be recorded here before any
  of it moves to CLAUDE.md's measured facts.
