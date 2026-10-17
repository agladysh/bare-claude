# 2026-10-17 — waiting, stopping and cleaning up

Base: `9ddc716` (v0.14.0). Documentation, TSDoc and `--help` text only: `README.md`,
`CHANGELOG.md` (`[Unreleased]`), the limit options' TSDoc in `src/index.ts` and their help lines in
`bin/bare-claude.ts`. No behaviour, API or version change.

The text is model work: Opus 5.5, medium effort, file tools only. It ran no shell, typecheck,
test, `claude` or provider call. An independent reader with the same tools received the first
candidate, and the commissioning reviewer read that candidate and the reception before the
revision.

## The occasion

A downstream consumer took the README's stop mechanics — signal, grace, SIGKILL to the group —
and used them to end a model's reading task once a fixed number of seconds had passed. An earlier
review of that consumer had listed "no run timeout" as a defect, and the timed stop was the answer
to it. The README's supervisor passage was conditional and mechanically right; its worked case was
`timeout -k 20 60 bare-claude …`. It did not cause the design. But it taught only how to stop
well. It did not say how to stop *waiting* without stopping the run, or what a stop on a chosen
duration amounts to for a task whose length is not known in advance.

## Decisions

- **Four things kept apart:** waiting (the caller's), execution, a stop (an intervention), and
  cleanup (a stop when it is reached while the run is still going). The code already kept them
  apart; the README did not say so.
- **Holding the run is documented; no detach is added.** `release()` stays refused once a run is
  attached. A detach or hand-off API, or a daemon, was rejected. It would need a new owner of
  supervision and custody, and nothing in the request needed one: the process holding the
  supervisor keeps the run and returns a handle.
- **The held-run example waits for admission.** It resolves on the custody `started` event, or on
  `completion` settling first, and rejects on refusal. A handle returned before that could read an
  existing directory's records, which `runInCustody` refuses with EEXIST, as this run's.
- **The native limits stay ordinary options.** Refusing or deprecating `maxBudgetUsd`, `maxTokens`,
  `maxOutputLength` or a forwarded `--max-turns` in the public API was rejected. They are Claude
  Code's own controls and a general wrapper carries them; what a particular consumer allows is that
  consumer's composition policy. The README says what each makes Bare Claude pass or set, and why
  none is a completion condition.
- **The supervisor passage's worked case changed from a timed kill to a decided stop**, with the
  allowance unchanged: `--stop-grace-ms` plus 6 seconds (two 2-second waits after SIGKILL, up to
  1 s rechecking an EPERM group, 1 s for the last output), 16 s with the default grace. The
  `timeout -k 20` / `-k 5` comparison stays as a kill-after allowance.
- **No banned words and no rule.** A deadline someone actually has, or a constraint outside the
  run, is left to the caller as a different reason.

## Where the documentation was wrong

**Before this change:**

- `maxTokens` "errors the turn rather than truncating it", in the README, the `LaunchOptions` TSDoc
  and `--help`. Nothing in this repository measured it: no session report, test or probe. Withdrawn
  in all three.
- `--max-budget-usd`, "stop the run once it has spent this much" in `--help`, "hard spend ceiling"
  in TSDoc. These are effects of Claude Code's that were never measured here. Each now names what is
  passed.
- `maxOutputLength`, "maximum output length for various Claude components". The code sets three
  named environment variables; the text now names them.

**In the first candidate, found by the independent reception:**

- The held-run example returned a handle before admission and read the directory at once. Before
  `mkdir` that reads `unreadable`, then `unknown`, then `invocation-only`, so its comment
  "`start-only` from the start" was false for its own first read. On EEXIST the handle would have
  read an earlier run's records, possibly as `exited`.
- It promised that the promise settles "once the run has been seen to end and `completion.json` is
  written". In fact it resolves when that write fails (`custodyError`), resolves for `not-started`
  and for a `custody-error` stop whose waits ran out without the run being seen to end, rejects on
  refusal, and settles only after the observation is written.
- It treated the program calling the CLI as the owner of supervision. Supervision lives in the
  `bare-claude` process. The caller's departure loses the handle and exit status, and stops the run
  only if it signals `bare-claude`. `start.json` names the spawned `claude`'s group, so a later stop
  through it is recorded as `exited` by someone else's signal, not `stopped`.
- "Its stdout may go unread" merged two cases. The tested one is a reader that goes away and closes
  the pipe. An open pipe nobody reads was not examined.
- "Nothing in it ends a run on its own account" was wrong: custody stops a run whose start it could
  not record, and cleanup after an error stops a run still going.
- "Recorded: exit 128+n, …, completion `stopped`" holds only by route. A `finish()` stop leaves
  `stoppedBy` null, and the CLI then exits 1 with the error.
- "The outcome reads like a failure" contradicted the README's own point that a stopped run is
  recorded as stopped.
- The default `signals` and `source` were not stated where a signal to the holder was said to stop
  every run it holds.
- An abort while custody prepares still spawns the run and then stops it; this was not stated.
- It kept the unmeasured `maxTokens` claim, and described `--max-budget-usd` and `--max-turns` from a
  Claude Code reference the next reader cannot re-run against the installed version. They are now
  named only as Claude Code's own options.

## Checks

- **On the first candidate**, the commissioning reviewer ran the offline typecheck (passed) and `bun test`
  (515 pass, 1 skip, 0 fail), and compiled that candidate's README sample against the API without
  running it.
- **On this revision**, the commissioning reviewer compiled the revised README sample against the
  actual API without executing it, and ran the full typecheck: both passed. The local suite passed
  with 515 tests, 1 skip, no failures and 1,940 assertions (69.73 s). The candidate was based on
  `9ddc716`; no source writes occurred between the author return and those checks. Source hashes
  were retained after the checks, not presented as a pre-run measurement. This paragraph only
  records those results. The independent reader then accepted all seven specified corrections
  for publication. These checks establish no native limit behaviour or provider outcome.

## Not established

- What Claude Code does when a run reaches `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `--max-budget-usd` or
  `--max-turns`; the units of the three output-length variables, and what Claude Code does with the
  excess and tells the model. No experiment was made, and none is implied to be owed.
- What a closed stderr pipe does to the CLI under custody: there is no stderr error handler.
- Whether an open stdout pipe nobody reads can block the CLI, and what happens when the CLI starts
  with SIGPIPE at its default disposition; the custody CLI test leaves the latter open itself.
- Whether a stop's reason should be recordable, for example from `AbortSignal.reason`. Today
  custody records the signal or `cancelled` only. That would be an API change, outside this one.
