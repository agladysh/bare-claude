# CLAUDE.md: AI Agent's Instructions for Claude Code

Bare Claude runs Claude Code headless with as little ambient context as the CLI permits, against
the user's own subscription. Everything in this repository serves that one sentence. A change that
makes a run less hermetic, less reproducible, or less bare is a regression even when it adds a
feature.

Claude is a TypeScript savant. Claude always thinks hard. Claude verifies against the installed
`claude` binary rather than against memory of what its flags used to do.

## About the project

A published library (`@agladysh/bare-claude`, MIT) with a CLI on top, not a CLI with a library
bolted on. The library is the product; `bin/bare-claude.ts` is its first consumer and its worked
example.

Three mechanisms, in order of importance:

1. **Hermetic spawn** — `spawnClaude()` builds an ephemeral `CLAUDE_CONFIG_DIR`, writes a
   `settings.json` into it, and execs the system `claude --print`. Ambient context (CLAUDE.md
   files, memory, skills, hooks, plugins, MCP, agents) is switched off by construction.
2. **Synthetic session** — `SessionBuilder` fabricates Claude Code session NDJSON so a run starts
   with files already read, at zero model cost, in the model's native transcript format.
3. **Transcript rendering** — `events.ts` type guards plus the `display.ts` rule table turn a
   session NDJSON stream into legible terminal output.

Presets (`bare-claude.yaml`, `src/preset.ts`) exist to make an invocation reproducible and
nameable. They configure the run; they must never dictate it. A preset that forces a caller's
output format or tool policy has overstepped.

## Ground truth

The codebase, and then the installed `claude`. Documentation written by agents — including this
file — lags. When they disagree, the code wins and the doc gets fixed in the same change.

- `README.md` — the public API contract. Every exported symbol and CLI flag lives here.
- `doc/session-event-stream.md` — what `displayClaudeEvent` recognizes and renders.
- `src/events.ts` + `src/display.ts` — source of truth for the event vocabulary.
- `bare-claude.yaml` — the elaborate preset example the README points at; keep it presentable.
- `CHANGELOG.md` — Keep a Changelog shape, one section per released version.
- `doc/sessions/` — what past sessions measured, decided, and got wrong. Read the most recent one
  before starting anything substantial; it is the cheapest context you will get.

## Runtime and commands

Bun only. Never `npm`, never `pnpm`, never `node`. The package ships TypeScript source; there is
no build step and no `dist/`.

- `bun install` — dependencies.
- `bunx tsc --noEmit` — typecheck. Must be clean before any commit.
- `bun test` — the test suite.
- `bun bin/bare-claude.ts --help` — run the CLI from source.
- `bun bin/bare-claude.ts --display <session.jsonl>` — render an existing transcript. Free, offline,
  and the fastest way to check a rendering change against a real session.

There is no linter and no formatter in this repository. Do not install one, and do not import the
eslint/prettier/markdownlint/tap stack from the author's pnpm repositories — this is a Bun package
and the toolchain is deliberately thin. Match the surrounding style by reading it.

## Implementation requirements

- Idiomatic, rigorously strongly typed, cutting-edge TypeScript.
- Use of `any` is strictly forbidden. Every use of `unknown` must be rigorously defensible — at the
  guard boundary it is; anywhere else it is a smell.
- Type guards, never `as`. The `is*` form is the established idiom in `src/events.ts`; follow it.
- TSDoc on exported symbols. `src/index.ts` sets the bar.
- Inline `// TODO:` comments are used in this repository as deliberate design markers. Leave them
  alone unless you are resolving one, and delete the marker when you do.
- Never leave transient change-history comments in code. The commit message is the history.
- A comment that records a *measured* fact about Claude Code's behaviour is worth more than three
  comments explaining what the code obviously does. Date those.
- Backwards compatibility is not a goal before 1.0. Clean breaks, no deprecation shims, no
  convenience re-exports. Bump the version and write the changelog entry instead.

## Measured facts about Claude Code — do not re-derive these

Verified against `claude` 2.1.220 on macOS. Re-verify, with a dated note, when they stop holding.

- An ephemeral `CLAUDE_CONFIG_DIR` **loses the subscription session**: `claude auth status` reports
  `loggedIn: false`, and a run dies with `Not logged in · Please run /login`. On macOS the OAuth
  credential lives in the login keychain under the service `Claude Code-credentials` and is not
  read when the config dir is redirected. Restoring it requires an explicit route:
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the child environment is the one that
  works on this platform.
- `--print` must be the last flag before the prompt text (measured by `thai/oracle-runtime`).
- A call-to-action beginning with `-` is consumed by the flag parser even after `--print`. On
  2.1.220 that is `error: unknown option '…'` on stderr and exit 1 with empty stdout; older
  versions failed silently with exit 0. Either way the run does nothing — refuse such a
  call-to-action before spawning.
- `--allowedTools ''` **fails open**: measured 2026-07-26 on 2.1.220, a run so restricted still read
  a file off disk and returned its contents. `--disallowedTools '*'` and `--tools ''` both actually
  block — the model then emits a `<function_calls>` tool-reach instead of an answer, so a caller
  that blocks tools must also strip that syntax out of the response.
- `--bare` is not our `bare`: it forces `ANTHROPIC_API_KEY`/`apiKeyHelper` auth and never reads the
  OAuth session, so it cannot serve a subscription user. `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` is the
  OAuth-compatible way to suppress CLAUDE.md discovery. `--system-prompt` does *not* suppress it.
- A settings file that fails validation is discarded **whole and silently** under `--print`. One
  bad value takes `disableAllHooks`, `enabledPlugins` and the entire `env` block with it. Probe it
  with `CLAUDE_CONFIG_DIR=<dir> claude doctor`: a working `env` block shows up as
  `Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)`. Measured: `cleanupPeriodDays: 0`
  voids the file; `effortLevel` is *not* validated there, so even a nonsense level does not.
- `permissionMode` is written to both `--permission-mode` and `permissions.defaultMode`, which
  accept different sets. Only their intersection is safe: `acceptEdits`, `auto`,
  `bypassPermissions`, `dontAsk`, `plan`.
- `sandbox.enabled` without `failIfUnavailable` degrades quietly: no sandbox means Bash runs
  unsandboxed, and `autoAllowBashIfSandboxed` then stops applying, so a headless run needs a
  permission nobody can grant. Claude Code's own programmatic path forces `failIfUnavailable` on.
- `autoConnectIde` and `autoInstallIdeExtension` are not settings keys — they live in Claude Code's
  global config store. Written to `settings.json` they do nothing. The env vars
  `CLAUDE_CODE_AUTO_CONNECT_IDE` and `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` are what it reads.
- Claude Code reads the last assistant record's `usage` back when resuming a session. A zero
  input-plus-cache total reads as "no measurement"; anything nonzero is believed. Fabricated turns
  must use zeros, or they lie to the resumed run about its context size.
- Real Read tool results are `1<tab>line` — 1-based, one tab, no padding. Real message ids are
  `msg_` plus 24 base62 characters, tool ids `toolu_` plus 24; neither ever contains `-` or `_`.
- `claude` exits 1 on auth failure. Anything this project builds must propagate that; a wrapper
  that returns 0 when the run failed is worse than no wrapper.

## Measured facts about Bun

- `Bun.file(path)` caches its stat. A handle taken before the file exists reports `exists()` as
  false forever, however many times you await it. Take a fresh handle per check when the file is
  being written by someone else — this silently disabled transcript rendering for months.

## Session reports

A substantial session ends by writing `doc/sessions/YYYY-MM-DD-slug.md`. Substantial means: you
measured something about Claude Code, you made a design decision someone could reasonably reverse,
or you ran subagents. A bug fix with a changelog entry is not substantial.

The report exists because this project's hard-won knowledge is *measurements against a moving
target*. Re-deriving "does `--allowedTools ''` actually restrict anything" costs real tokens and a
real risk of getting it wrong. Record what you measured, **and the probe you used**, so the next
agent can re-run it against a newer Claude Code instead of trusting a stale claim.

Write down, in whatever order serves:

- What you measured, how, and on which Claude Code version. The probe matters as much as the result.
- Decisions and the reason, especially where you rejected the obvious option.
- Root causes worth remembering — not a changelog, which `CHANGELOG.md` already is.
- **Where a review, a subagent, or a previous report was wrong.** This is the highest-value
  section and the one you will be most tempted to omit.
- What is still open, and what nothing verifies.

Keep it factual and dense. This is a record, not an essay: no narrative arc, no lessons-learned
section, no restating what the code already says. If a normative fact emerges, its home is the
measured-facts section above — the report says how it was established, `CLAUDE.md` says what holds.

Do not grow this practice into a process. No templates beyond this list, no index file, no
per-session directories, no reports about reports.

`doc/sessions/` is excluded from the published package (`files` in `package.json`) — these are
records for whoever works on this repository, not documentation for its consumers. Keep it that
way as the directory grows.

## Git

- Never `git add -A`, `git add .`, or any bulk staging command. Stage deliberately.
- Never commit with `--no-verify`.
- Conventional commits, lowercase subject, no trailing period: `feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `test:`. Scopes are file or feature names — `fix(package.json):`, `docs(README):`.
- One logical change per commit — describable in one sentence without "and".
- Typecheck and tests pass before every commit.
- Releases: changelog entry, `chore: vX.Y.Z` commit, tag `vX.Y.Z`.

## Downstream

This package is load-bearing for the author's other work. `okno` vendors a fork of it, `flywheel`
vendors an older one, and `bore` drives it as a subprocess. Those forks were merged back on
2026-07-26; each vendored copy carries an `UPSTREAM.md` recording what moved, what upstream chose
differently, and what is still broken there.

Before designing anything here, read what the forks already solved — reinventing it is waste, and
diverging from them without cause splits the lineage again. When a consumer needs a capability,
add it here. Working around this library with a raw `claude` call is the failure mode.
