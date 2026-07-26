# Changelog

## [Unreleased]

### Added

- `claudePath` launch option and `--claude-path`, selecting the Claude Code executable. It also
  governs the `claude --version` probe and `--usage`. It does not apply to the `ollama` launcher,
  where `claude` names what ollama launches rather than a path.
- Tool results are attributed to the call they answer. A result is tagged `[ToolName]` only while
  more than one call is outstanding, so an ordinary call-then-result turn reads exactly as before.
- A black-box test suite driving the real CLI as a subprocess, with committed session fixtures and
  a fake `claude`, covering exit codes, the transcript, and failure paths without touching a model
- `bare-claude.yaml` is schema-validated with arktype, via `parseConfig()` from
  `@agladysh/bare-claude/config`. Unknown keys are an error. `--effort` is validated too.
- Pure, exported launch-configuration builders — `LaunchConfig()`, `buildArgv()`,
  `buildSettings()`, `buildEnv()` — so the whole flag, environment and settings matrix is
  testable without spawning a subprocess
- `TranscriptRenderer` from `@agladysh/bare-claude/display`: a renderer that owns the
  `tool_use`/`tool_result` pairing for one stream, replacing a module-global map shared by every
  consumer of the library
- Rendering for event types 2.1.220 emits that had none: `mode`, `ai-title`, `file-history-delta`,
  `agent-setting`, and the `fallback` and `image` content blocks. `custom-title` turns out to have
  no records at all, so sessions were rendering untitled.
- The `changelog` preset now preloads its own git history and carries a measured tool policy
- Typed preload descriptors — `file`, `glob`, `shell`, `ls`, `inline` — configurable as `preload`
  in a preset and available as `emitPreload()` from `@agladysh/bare-claude/preload`. Shell and
  directory listings land as real Bash tool results. `--read` now resolves through the same path,
  so both share one raw-content byte budget; an entry over budget is skipped whole rather than
  truncated.
- Typed launch options for flags callers previously could not reach: `tools`, `disallowedTools`,
  `addDirs`, `maxBudgetUsd`, `maxTokens`, and their command-line equivalents `--tools`,
  `--disallowed-tools`, `--add-dir`, `--max-budget-usd`, `--max-tokens`, plus `--effort` and
  `--max-output-length`. `--claude-arg` forwards anything else to `claude` verbatim.
- The call to action is read from stdin when no positional one is given
- `assertSafeCallToAction()`, refusing a prompt starting with `-` before spawning: `claude` parses
  it as a flag and the run does nothing
- `linkAuth` launch option, symlinking the credential file into the ephemeral config directory
- `SessionBuilder.emitAssistant()` and `emitContext()`; `emitUser()` now records the last prompt,
  so the session epilogue is real; `commit()` takes an optional budget and warns on pathological
  serialized size
- Subscription usage introspection: `--usage` on the command line, `readUsage()` from
  `@agladysh/bare-claude/usage`. Reports per-window utilization, reset times and whether
  consumption is outrunning the clock. Costs no tokens.
- `dispose()` on the value returned by `spawnClaude`, removing the ephemeral Claude home directory
  it created
- Test suite (`bun test`) and GitHub Actions CI running typecheck, tests and a packaging check
- `CLAUDE.md` agent instructions, including the measured Claude Code behaviours this project
  depends on
- Documentation: authentication — a temporary config directory does not inherit the ambient login
  session, so an explicit `CLAUDE_CODE_OAUTH_TOKEN` is required for subscription use
- Documentation: exit status of the `bare-claude` command
- Real `--help` output, replacing the one-line placeholder

### Changed

- **`sandbox.failIfUnavailable` is now `true`.** A host without sandbox support fails loudly at
  startup instead of silently running unsandboxed — where `autoAllowBashIfSandboxed` also stops
  applying, leaving a headless run needing a permission nobody can grant. This matches what Claude
  Code's own programmatic sandbox path already forces. Escape hatch:
  `extraSettings: { sandbox: { failIfUnavailable: false } }`.
- **`extraSettings` is deep-merged last**, so it can now override anything Bare Claude derives,
  rather than only the three keys it happened to reach before. Note the inverted precedence:
  `extraSettings.env.X` now beats the flag-derived value, where it used to lose.
- **`spawnOptions.env` and `spawnOptions.cwd` are honoured** instead of silently discarded.
- **Every `displayClaudeEvent` guard in `events.ts` is now a content-block guard**
  (`isBashBlock`, `isReadBlock`, …). `isSynthetic`, `isAssistant`, `isThinking` and `isUserArray`
  are gone, subsumed by `isTextBlock`; `isUser` is `isUserText`, `isToolUse` is `isToolUseBlock`,
  and `isOtherToolUse` is `isAnyToolUseBlock`.
- Tool results render with a `>` prefix on every line, not `>` then `|`.
- `SessionBuilder`'s constructor takes a sixth optional argument, `effort`, defaulting to `'high'`.
- IDE integration is disabled through `CLAUDE_CODE_AUTO_CONNECT_IDE` and
  `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` rather than two settings keys that do not exist. Extension
  auto-install defaults to on in Claude Code's config store, so `noIntegrations` was not
  suppressing it.
- Runs now pass `--setting-sources user`. Project and local `.claude/settings*.json` were still
  being loaded into a session that is supposed to be bare.
- The ephemeral Claude home is kept, and its path reported, when a run fails or is inspected with
  `--verbose`/`--debug`; it is removed otherwise.
- The session markers Claude Code injects into its children (`CLAUDECODE`, `CLAUDE_CODE_*`,
  `CLAUDE_PID`, `CLAUDE_EFFORT`) are stripped from the inherited environment, so a run launched
  from inside Claude Code no longer reports its parent's session id and entrypoint. Authentication
  variables are untouched.

### Fixed

- **No transcript was rendered at all for any run without preloaded files.** `Bun.file()` caches
  its stat, so the handle taken before the subprocess created the session file reported it missing
  forever and rendering bailed out. Runs using `--read` were unaffected, because those write the
  session file before spawning.
- A `TaskUpdate` call without `status` — a partial update — rendered as nothing
- Every documented `import` example named a package that does not exist: `bare-claude` rather than
  `@agladysh/bare-claude`
- Fabricated session records claimed a usage of one token. Claude Code reads the last assistant
  record's usage back on resume — a zero input-plus-cache total means "no measurement", anything
  nonzero is believed — so every preloaded run was telling the resumed session its context was one
  token, and feeding the same number to the auto-compaction threshold. Records now carry Claude
  Code's own zero-usage shape.
- Fabricated records now match real ones on key set: `session_id` on non-sidechain records,
  `effort` on assistant records, `message.diagnostics`, `leafUuid` on `last-prompt` (which resume
  uses to pick the conversation head), and `origin`/`promptSource` on typed prompts.
- Message and tool ids are Anthropic-shaped — `msg_`/`toolu_` plus 24 base62 characters. The
  previous base64url form could contain `-` and `_`, which no real id does.
- An assistant record mixing text with a tool call, or carrying two tool calls, rendered as
  nothing at all. Rendering now dispatches per content block. A corpus sweep of 101,984 records
  afterwards found no unrecognized block and no unrecognized `assistant` or `user` record.
- Thinking blocks that carry both readable text and a signature rendered as nothing (87 of 16,503).
- Known tool calls with unexpected input — a `TaskUpdate` without `status`, a `Read` whose input
  failed to parse — matched neither their own rule nor the catch-all, and rendered as nothing.
- Preloaded `--read` files are numbered `1<tab>line` the way real Read results are. They were
  0-based and space-padded, so every line number the model saw was off by one and Claude Code
  could not strip the prefix back off.
- `noMothership` no longer defaults to disabling attribution and telemetry when `launcher` is left
  unset. It tested the raw option rather than the resolved default, so omitting `launcher` behaved
  differently from passing `claude`.
- `disableBypassPermissionsMode` and `defaultMode` are written under `permissions`, where Claude
  Code reads them, with the former as the string `disable`. At the settings root both were unknown
  keys and were silently ignored.
- Synthetic session data ends with a newline, so the subprocess' first record is no longer
  concatenated onto the last preloaded one
- Preloaded events are marked with a `<bare-claude>` model instead of `<synthetic>`, which Claude
  Code reserves for API-error messages and which made preloaded tool calls render as raw JSON
- Transcript decoding no longer corrupts multi-byte characters split across chunk boundaries
- The transcript tail reports open and read errors instead of crashing the process, and no longer
  double-prints when the subprocess exits before the tail has started
- Truncated blocks no longer render more lines than they replace, and count them correctly
- Multi-block `Edit` and `Grep` events are joined instead of rendering a stray comma
- `--launcher` is validated at parse time instead of failing later inside `spawnClaude`
- User mistakes — a refused call to action, an unknown preset or launcher — are reported as a
  message and exit 1, instead of a raw stack trace. `--debug` still shows the trace.
- `SessionBuilder.emitBash()` is no longer `async` with nothing to await, so it chains like the
  other emitters
- Exit code of the `claude` subprocess is propagated instead of always reporting success
- Subprocess output is echoed to stderr on failure instead of being discarded, so a failed launch
  reports why
- The CLI no longer hangs when the subprocess exits without ever creating a session file
- Presets listed in `use` are merged left to right as documented; previously earlier presets
  overrode later ones and inherited arrays concatenated in reverse
- `extraSettings.env` is no longer silently discarded
- The ephemeral Claude home directory is created before the session file is written into it
- `--read` failures (missing or binary file) exit nonzero instead of reporting success
- `preset` subpath is exported from `package.json`
- Type of the tool name in the unrecognized-tool event shape

## [v0.8.6] - 2026-05-05

### Added
- Print resulting configuration when `--debug` flag is used

### Fixed
- Removed CLI option defaults (no change in semantics) that were preventing boolean CLI flags in presets from working

### Changed
- Refined bare-claude.yaml for better readability

## [v0.8.5] - 2026-05-05

### Added

- Сonfiguration file and presets
- `--print` flag to print Claude Code console output
- `--read` flag now supports Git pathspec patterns
- Documentation: mention the BYOLLM (Bring Your Own LLM) keyword
- Documentation: use `--print` with `--quiet` to get only the last message
- Documentation: documented some of the assumptions Bare Claude makes
- Documentation: corrected project name to "Bare Claude" (not "bare-claude")

### Fixed

- Assistant messages are no longer truncated in the transcript

## [v0.8.4] - 2026-05-05

### Added

- `--read` flag to pre-read files
- Rudimentary SessionBuilder to create synthetic Claude Code NDJSON session data
- Permission-mode event
- SessionEvent union type
- Documentation for global installation in README.md
- Documentation for displayClaudeEvent in README.md

### Changed

- Removed inconsistent Assistant prefix from tool call events
- Graduated src/{display,events}.ts from bin/bare-claude.ts

## [v0.8.3] - 2026-05-05

- Official first release
