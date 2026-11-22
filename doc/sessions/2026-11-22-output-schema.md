# Output schema

`--output-schema FILE` / `outputSchemaFile`: a JSON Schema the final answer must satisfy, passed
to Claude Code as `--json-schema <text>`, with a typed `OutputSchemaOutcome` read back from the result.
Two passes: the change itself, then repairs after an independent check. No live `claude` run was
made in either pass. The native facts below came from a requester's observations, re-read here as
data, and from reading the installed binary.

## What is known, and how

Claude Code 2.1.328, 2026-11-22.

- `claude --help | grep -i schema` gives `--json-schema <schema>  JSON Schema for structured
  output`: inline JSON text, not a path.
- Observed by the requester, not here:
  `claude -p --model haiku --output-format stream-json --verbose --json-schema '<schema>'`, the
  schema an object with one required string `answer` and `additionalProperties: false`. The init
  `tools` held `StructuredOutput`, also with `--tools Read`. The final `result` had
  `is_error: false`, subtype `success`, `structured_output: {"answer":"ok"}` and
  `result: "{\"answer\":\"ok\"}"`. The model first answered in text, then native appended a user
  message, `[structured-output-enforce] You MUST call the StructuredOutput tool …`, and the model
  called the tool.
- Observed by the requester, not here, after the first pass:
  `claude -p --model haiku --output-format json --json-schema '<schema>'`.
  - Satisfiable schema: exit 0. Stdout a 7-element array (`system`/`init`, `assistant`,
    `rate_limit_event`, `user`, `assistant`, `user`, `result`). The last element: `is_error:
    false`, subtype `success`, `terminal_reason: "completed"`, `structured_output` the parsed
    value, `result` the same as JSON text.
  - Unsatisfiable schema (a string with `minLength: 3` and `maxLength: 1`) with
    `MAX_STRUCTURED_OUTPUT_RETRIES=1` in the environment: exit 1. Stdout a 10-element array, the
    last element `is_error: true`, subtype `error_max_structured_output_retries`,
    `terminal_reason: "structured_output_retry_exhausted"`, no `result`, no `structured_output`,
    and one `errors` string beginning `Failed to provide valid structured output after 1 attempts
    — last StructuredOutput error: Output does not match required schema: `.
  - The arrays are the host's settings at `"verbose": true`. Re-read here with
    `jq -c 'if type=="array" then {len:length, types:[.[]|[.type,.subtype]], last:(.[-1]|del(.usage,.modelUsage,.permission_denials))} else {obj:keys} end'`
    over the two captures; the exit codes are the requester's report, not in the captures.
- Read from the bundle, still not observed. The probe was
  `grep -a -b -o 'error_max_structured_output_retries' <versions/2.1.328>`, then `dd` around each
  offset; a `grep -o -E '.{0,250}…' | sort -u` over the 354 MB file had printed nothing after a few
  minutes and was stopped.
  - The result-message zod schema's other error subtypes: `error_during_execution`,
    `error_max_turns`, `error_max_budget_usd`.
  - The text printer writes `Error: ${errors[0] ?? "Failed to provide valid structured output
    after maximum retries"}`.
  - A schema run's `--output-format json` without verbose prints the lone result object.
- Re-probe: the same two `--output-format json` runs, once with the settings' `verbose` off and
  once with `--verbose` forwarded, to pin the lone-object form and the forwarded-flag array.

## Decisions

- **The library option is a path, read in `LaunchConfig`.** `buildArgv` stays filesystem-free:
  `LaunchConfig` now carries `outputSchema` (file, verbatim text, size, digest), and it is the one
  file `LaunchConfig` reads. The conflict with a forwarded `--json-schema` is checked before the
  read. Decoding is fatal and keeps a BOM, so the text re-encodes to the bytes digested, and a
  BOM file is refused as not JSON.
- **Custody keeps a copy and spawns with it.** `runInCustody` resolves the config once and
  `spawnClaude` resolves it again. Pointing the spawn at `output-schema.json`, written exclusively
  from the bytes recorded, makes the recorded digest the bytes passed, whatever the caller's file
  does in between.
- **Not a preset field.** `DynamicPreset` omits `outputSchemaFile`, and the config drift guard then
  keeps it out of YAML. Reason: CLAUDE.md's rule that a preset must not dictate the caller's output
  format.
- **The CLI asks for `--output-format json`; the library does not.** The exit status needs the
  result, and text output cannot tell a give-up from a model that wrote `Error: …`. A forwarded
  non-JSON format is refused rather than overridden.
- **Exit statuses.** 0 only for conforming with claude exiting 0; 65 for a give-up, whatever
  claude exited with; 66 for claude exiting 0 with no structured output; otherwise claude's own.
  Chosen, not derived from anything native does. The observed give-up exits 1, so 65 replaces it.
- **Readers must be told a schema was given.** `readResult` takes `{ outputSchema }`, because a
  result without `structured_output` cannot distinguish "no schema" from "no answer". Custody
  knows from `invocation.json`. `--outcome` takes `--outcome-schema` and a batch line takes
  `outputSchema`. Inferring a schema from the result's own fields was rejected: it would report
  nothing for exactly the runs that failed.
- **The verbose array is read in `readResult`, nowhere else.** Every reader (custody, `--outcome`,
  `--outcome-batch`, the live exit status) goes through it, so one change covers all. Only the
  last element is read; a result anywhere else in the array is not looked for, since the form
  observed has it last and anything else is not that form. `ResultReading.form` (`object` | `array` | null) says which
  form was read, for every reading, not only schema runs. `bytes` and `sha256` stay those of the
  whole file.
- **One shape across wrappers.** Renamed to the sibling bare-kimi's names: `OutputSchemaOutcome`,
  `OutputSchemaEnforcer`, `OutputSchemaNoMessageReason`, `OutputSchemaError` (the validator error)
  and `finalMessage`. That collided with this package's refusal class, `OutputSchemaError`; it is
  now `OutputSchemaFileError`, bare-kimi's name for its own. `OutputSchemaRefusal` and the class's
  `reason`/`file` fields are unchanged and differ from bare-kimi's `problem`/`path`; the refusal is
  not part of the outcome. The `reason` codes stay this wrapper's own.
- **`schemaSha256: string | null` on every kind.** Required in bare-kimi, where the wrapper always
  has the schema. Here a reader of a bare result file does not, so null means "the reader was not
  told which schema": `--outcome --outcome-schema`, a batch line, `readResult` with
  `outputSchema: true`, and a custody run whose directory could not be read back. Making the field
  optional was rejected: an absent key and a null would both have to be handled, and the shape
  would differ by reader. `ResultOptions.outputSchema` became `boolean | { sha256 }`, so the
  spawn's new `outputSchema` (an `OutputSchema`) or a custody record passes straight in. The live
  CLI and custody always know it. The brief carries no digest; it stays a classification.

## Where earlier text was wrong or is now incomplete

- **The first pass read only a lone result object.** Its answer said `--output-format json` prints
  the same result object as stream-json's last event, read from the bundle. Under native verbose
  it prints an array, and a conforming run then read `no-final-message`/`unreadable-result` and
  exited 66. The check's probe (fake claude, array on stdout, `--claude-arg=--verbose`) found it.
  A test in `src/outcome.test.ts` had pinned `[ result ]` as `not-a-result`; it now reads.
- `src/outcome.ts` once said `subtype` is "never read as an outcome". The schema outcome reads it,
  beside `terminal_reason`, and only on `is_error: true`.
- The first pass's open question, whether claude exits 1 on a give-up: it did, in the run observed.
- The check reported 56 failures in `bun test`, mostly EPERM on `chmod` of `bin/bare-claude.ts` in
  install/doctor tests. On this host the same tree failed 6 at the start of the second pass (the
  five "outside a Git working copy" tests and one timing failure in
  `src/stdin-prompt.test.ts`, which passed alone), and 5 after the repairs. The EPERM failures are
  the check's host, not reproduced here.
- CLAUDE.md records Bun 1.3.13; `bun test` here reported Bun 1.4.5. Nothing in this change
  depends on the difference.

## Test runs

- `bun test`, second pass end: 564 pass, 1 skip, 5 fail, the five "outside a Git working copy"
  tests. `TMPDIR` lies inside another Git working copy here, and `/private/tmp` refused writes.
- `GIT_CEILING_DIRECTORIES="$TMPDIR" bun test`: 569 pass, 1 skip, 0 fail. The ceiling stops Git's
  discovery at `TMPDIR`, so the tests' temporary directories are outside any working copy as Git
  sees them; they are still physically inside one.

## Open

- Whether `structured_output` can appear on an error result is not known. It would read as
  `conforming`, with `status: "error"` beside it.
- The offline readers cannot name the schema (`schemaSha256: null`). Letting `--outcome-schema`
  and a batch line take the schema file or digest would close that.
- `--output-format stream-json` with `--output-schema` is still refused, not read from its final
  line; `readCustody` does not check `output-schema.json` against the recorded digest.
