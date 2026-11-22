# Output schema

`--output-schema FILE` / `outputSchemaFile`: a JSON Schema the final answer must satisfy, passed
to Claude Code as `--json-schema <text>`, with a typed `SchemaOutcome` read back from the result.
No live `claude` run was made in this session. The native facts below came from a requester's
earlier observation and from reading the installed binary.

## What is known, and how

Claude Code 2.1.328, 2026-11-22.

- `claude --help | grep -i schema` gives `--json-schema <schema>  JSON Schema for structured
  output`: inline JSON text, not a path.
- Observed by the requester, not here. The run was
  `claude -p --model haiku --output-format stream-json --verbose --json-schema '<schema>'`, the
  schema an object with one required string `answer` and `additionalProperties: false`. The init
  `tools` held `StructuredOutput`, also with `--tools Read`. The final `result` had
  `is_error: false`, subtype `success`, `structured_output: {"answer":"ok"}` and
  `result: "{\"answer\":\"ok\"}"`. Re-reading those captures (data only, not copied here) showed
  one more thing. The model first answered in text, then native appended a user message,
  `[structured-output-enforce] You MUST call the StructuredOutput tool …`, and the model called
  the tool. `--output-format json` with a schema was not run; that it prints the same result
  object is read from the bundle's print path, not observed.
- Read from the bundle, not observed. The probe was
  `grep -a -b -o 'error_max_structured_output_retries' <versions/2.1.328>`, then `dd` around each
  offset; a `grep -o -E '.{0,250}…' | sort -u` over the 354 MB file had printed nothing after a few
  minutes and was stopped.
  - The result-message zod schema lists the error subtypes `error_during_execution`,
    `error_max_turns`, `error_max_budget_usd` and `error_max_structured_output_retries`, with
    `errors: string[]` and no `result`.
  - The two give-up sites yield `is_error: true`, subtype `error_max_structured_output_retries`,
    `terminal_reason: "structured_output_retry_exhausted"` and one `errors` entry.
  - The text printer writes `Error: ${errors[0] ?? "Failed to provide valid structured output
    after maximum retries"}`.
  - `MAX_STRUCTURED_OUTPUT_RETRIES` is named.

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
  result, and text output cannot tell a give-up from a model that wrote `Error: …`. The CLI's
  option is the caller's explicit choice; the library leaves formats to its caller. A forwarded
  non-JSON format is refused rather than overridden.
- **Exit statuses.** 0 only for conforming with claude exiting 0; 65 for a give-up, whatever
  claude exited with; 66 for claude exiting 0 with no structured output; otherwise claude's own.
  Chosen, not derived from anything native does.
- **Readers must be told a schema was given.** `readResult` takes `{ outputSchema }`, because a
  result without `structured_output` cannot distinguish "no schema" from "no answer". Custody
  knows from `invocation.json`. `--outcome` takes `--outcome-schema` and a batch line takes
  `outputSchema`. Inferring a schema from the result's own fields was rejected: it would report
  nothing for exactly the runs that failed.
- **`wrapper` variants are in the type although Bare Claude never fills them**, so that a sibling
  wrapper without native enforcement reports the same shape.

## Where earlier text was wrong or is now incomplete

- `src/outcome.ts` said `subtype` is "never read as an outcome". The schema outcome reads it,
  beside `terminal_reason`, and only on `is_error: true`. Header and README updated.
- CLAUDE.md records Bun 1.3.13; `bun test` here reported Bun 1.4.5. Nothing in this change
  depends on the difference.

## Open

- No run that gave up on its schema has been observed. The `not-conforming` reading rests on the
  bundle. A probe: an unsatisfiable schema (`{"type":"object","required":["x"],"properties":
  {"x":{"type":"string","maxLength":0,"minLength":1}}}`), with `MAX_STRUCTURED_OUTPUT_RETRIES`
  low if it is an environment variable, and `--output-format json`.
- Whether claude's exit code on a give-up is 1 is not known. The CLI exits 65 either way.
- Whether `structured_output` can appear on an error result is not known. It would read as
  `conforming`, with `status: "error"` beside it.
- Baseline: 6 tests failed before and after this change, the "outside a Git working copy"
  doctor/config tests. The test host's `TMPDIR` lies inside another Git working copy.
