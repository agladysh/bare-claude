# 2026-07-26 — infrastructure pass

Claude Code 2.1.220, macOS, Bun 1.3.13. Started at v0.8.6 + uncommitted `bare-claude.yaml` edits.
Work done by Opus 5 with four Opus and four Sonnet subagents. Nothing committed during the session.

The ask: figure out what this project is, survey the sibling approaches and the vendored forks,
make it high-grade infrastructure, and close the subscription-introspection gap.

## What the project is

A hermetic invocation of Claude Code as a subroutine. Three mechanisms, in dependency order:

1. **Hermetic spawn** — ephemeral `CLAUDE_CONFIG_DIR`, generated `settings.json`, `claude --print`.
2. **Synthetic session** — `SessionBuilder` fabricates session NDJSON so a run starts with files
   already read and commands already run, at zero model cost.
3. **Transcript rendering** — type guards plus a rule table over the session NDJSON.

Presets make an invocation reproducible and nameable. It is a library first; `bin/bare-claude.ts`
is its first consumer. It is not a general-purpose Claude Code toolkit, and proposals that make a
run less hermetic or less reproducible are regressions however much they add.

## The lineage

```
fantastic-octo-system  (2026-04, experiments, archived)
  └─ special-octo-engine  (2026-05, direct ancestor of spawnClaude/preset/SessionBuilder)
       └─ bare-claude  (this repo, published as @agladysh/bare-claude)
            ├─ flywheel/vendor/bare-claude        (0.8.6 + local patches; flywheel tombstoned)
            ├─ okno/okno-bootstrap/tools/bare-claude  (2026-07-15, two generations behind)
            └─ okno/okno/packages/bare-claude     (hard fork, @okno/bare-claude; 4 checkouts)

parallel, independent, better-engineered:
claude-code-companion/bin/poc.sh → thai/co-telescope → thai/oracle-runtime
  → rs-claude-code-companion  (Rust, typed argv/env builders, error taxonomy)
```

Consumers: `okno` (constitutionally — "if bare-claude lacks a feature you need, add it to
bare-claude"), `flywheel`, `bore`. Each vendored copy now carries an `UPSTREAM.md` recording what
moved upstream, what upstream chose differently, and what is still broken locally.

`rs-claude-code-companion/crates/claude-code-runner/doc/design.md` is worth reading before any
redesign here. Its pure-argv/env split is the shape this repo adopted this session.

## Measured facts

The normative list lives in `CLAUDE.md`. What follows is how they were established, because the
probes are reusable and the facts drift between Claude Code releases.

**Settings-file validity probe.** Claude Code silently discards a settings file that fails
validation under `--print` — one bad value takes `disableAllHooks`, `enabledPlugins` and the whole
`env` block with it, with no diagnostic. To test whether a given key or value voids the file:

```bash
mkdir -p /tmp/probe
echo '{"suspectKey":"suspectValue","env":{"DISABLE_AUTOUPDATER":"1"}}' > /tmp/probe/settings.json
CLAUDE_CONFIG_DIR=/tmp/probe claude doctor | grep -i auto-update
# "disabled (set by env: DISABLE_AUTOUPDATER)"  -> file was read
# "enabled"                                     -> file was rejected whole
```

Control: `cleanupPeriodDays: 0` rejects. Measured this way: `effortLevel` is *not* validated there
(even a nonsense level is accepted), which killed a suspected `--effort max` bug.

**Tool restriction.** Write a file with a distinctive token, then ask a restricted run to read and
return it. Result on 2.1.220: `--allowedTools ''` **fails open** — it returned the token.
`--disallowedTools '*'` and `--tools ''` both block, and the model then emits a `<function_calls>`
tool-reach instead of an answer, so a caller that blocks tools must strip that syntax. This
refutes an earlier note in `flywheel` and confirms a later one in `okno`; `okno-bootstrap`'s
`receptor` preset is built on the flag that does not work.

**Auth.** `CLAUDE_CONFIG_DIR=<empty dir> claude auth status` reports `loggedIn: false`, and a run
dies with `Not logged in · Please run /login` and exit 1. Seeding `oauthAccount`/`userID` into the
ephemeral `.claude.json` does not help. `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) does
— verified. On macOS the credential is in the login keychain under service
`Claude Code-credentials` and there is no `.credentials.json`, so `linkAuth` has nothing to link
here; it remains useful where credentials are file-based.

`claude --safe-mode --setting-sources ''` gives most of bare mode *while keeping the ambient login
session* — verified working. That is a live strategic option this repo has not taken: it would
trade hermeticity (no trace in `~/.claude/projects`) for not needing an explicit token.

**Usage introspection.** `claude -p "/usage"` is a local slash command: no model turn, no tokens.
It refreshes `~/.claude.json` → `cachedUsageUtilization`, which carries integer percentages and ISO
reset timestamps. Claude Code throttles that write to 5 minutes and discards the cache past 1 hour.
Reading the cache without refreshing first is the trap — it was 9 days stale on this machine.
Every source is a *percentage of an opaque window*; `limit_dollars` is null for subscriptions, so
no absolute number is available anywhere. `GET /api/oauth/usage` is the authoritative source and is
undocumented; reaching it directly means lifting the OAuth token out of the keychain, so this
project does not.

## Decisions, and why

- **`--` stays the call-to-action separator.** The okno fork repurposed it to forward flags to
  `claude`. Upstream cannot: every README example and `flywheel`'s Makefile use it as the
  separator. Forwarding got `--claude-arg` instead, plus typed options for the flags that matter.
- **`claudePath` does not apply to the `ollama` launcher.** In `ollama launch claude …`, `claude`
  is an agent identifier ollama resolves, not a filesystem path.
- **Unknown keys in `bare-claude.yaml` are an error.** Hand-written file, read by nothing but this
  program; a silently-ignored typo is only ever a wrong run, and a warning is what a
  `--quiet --print` pipeline discards.
- **`sandbox.failIfUnavailable: true`.** Without it, no sandbox means Bash runs unsandboxed and
  `autoAllowBashIfSandboxed` stops applying, leaving a headless run needing a permission nobody can
  grant. Claude Code's own programmatic path forces this on. Breaking for hosts without sandbox
  support; escape hatch is `extraSettings`.
- **Preloaded `file_path` stays as the caller wrote it**, though real records are always absolute.
  It is the one field of that record the model sees; `toolUseResult.file.filePath` is already
  absolute and is what Claude Code's own machinery keys on.
- **`<bare-claude>`, not `<synthetic>`, as the preload model marker.** Claude Code reserves
  `<synthetic>` for API-error messages and excludes it from usage and cost accounting.

## Defects worth remembering

Root causes, not a changelog — `CHANGELOG.md` has the full list.

- **`Bun.file()` caches its stat.** A handle taken before the file exists reports `exists()` false
  forever. This disabled transcript rendering for every run without `--read` (runs with `--read`
  write the session file before spawning, so their handle was taken after it existed). Found by a
  subagent reporting the symptom and misdiagnosing it as a poll race; only trying its fix exposed
  the real cause.
- **Fabricated `usage: {input_tokens: 1, output_tokens: 1}` was not inert.** Claude Code reads the
  last assistant record's usage back on resume; a zero input+cache total means "no measurement",
  anything nonzero is believed. Every preloaded session was claiming a one-token context and
  feeding that to the auto-compaction threshold.
- **Settings written where Claude Code does not read them.** `disableBypassPermissionsMode` at the
  root as a boolean (it lives under `permissions` and is the string `'disable'`); `autoConnectIde`
  and `autoInstallIdeExtension` in `settings.json` at all (they live in the global config store,
  and the latter defaults to *true*, so extension auto-install was never suppressed).
- **The CLI exited 0 on every failure**, so a run that died with `Not logged in` was
  indistinguishable from success.
- **Preloaded `Read` line numbers were 0-based and space-padded.** Real results are `1<tab>line`.
  Every line number the model saw was off by one, in the feature whose whole job is "review this
  file", and Claude Code's un-numbering regex could not strip the padded prefix.
- **Preset inheritance was inverted** relative to its own documentation.

## Where a review was wrong

Recorded because these cost time and would cost it again.

- A review asserted real user records do not carry `permissionMode`. Inverted: all 507 real typed
  prompts carry it; the 3,100 tool-result records do not, and the code was already right.
- The same review flagged `--effort max` as voiding the settings file. It does not — see the probe
  above.
- A subagent diagnosed empty transcripts as a `TailFile` poll race. The symptom was real, the
  cause was `Bun.file` caching.

The pattern: symptom reports from agents are reliable, diagnoses are not. Reproduce before fixing,
and if a fix does not take, distrust the diagnosis rather than adding a second fix on top.

## How the swarm was run

Eight subagents in two waves, four Opus then four Sonnet. What mattered:

- **Strict, disjoint file ownership, stated in every brief.** No worktree isolation: nothing was
  committed, so a fresh worktree would have been missing every new file.
- **Each brief said that typecheck errors outside its own files are another agent's work in
  progress — ignore them, never fix them.** Without that, agents "helpfully" repair each other.
- **Nobody but the integrator touches `README.md` and `CHANGELOG.md`.** Four agents editing two
  shared documents is the one guaranteed collision. They report; the integrator writes.
- **Agents were warned the vendored forks' tests encode bugs upstream has already fixed**, and told
  not to import an assertion without checking it. Blind absorption would have re-asserted the
  0-based `Read` numbering.
- **Every brief ended with an explicit verification list**, commands included. Smaller models
  especially do better when "done" is a command whose output they can paste.
- **One agent died mid-run on an API error** with correct but unfinished work — grouping and the
  `TaskUpdate` fix complete, TODO markers and the sample transcript not. "Failed" does not mean
  "discard": check the tree before redoing anything.

## State at the end

233 tests across 10 files, typecheck clean, `bun pm pack` clean, live end-to-end runs correct.
Everything uncommitted.

Open, in `TODO.md`: the second half of the config-consolidation item — presets and CLI options
still resolve separately from the new typed builders in `src/index.ts`. Also `emitBash`'s
stdout/stderr question, which has no local evidence to settle it.

Untested by anything automated: the live `claude` path itself. Every test uses `--display` replay
or a fake `claude` on `PATH`; the real binary is exercised only by hand.
