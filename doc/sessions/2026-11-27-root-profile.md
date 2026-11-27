# Root profile, setting sources, unforced effort

`profile: 'root'` / `--profile root`, `settingSources` / `--setting-sources`, effort passed only
when given, and six more parent-session variables stripped. The change rests on a probe made by a
requester the same day, before this change, and on one run of that probe against this branch.

## What is known, and how

Claude Code 2.1.332, macOS, 2026-11-27. The native binary was run directly, not through any
launcher shim. Auth was `auth: caller`, with the account's native-store variables in the caller's
environment.

The fixture is a scratch Git repository with no remote. It holds:

- a `CLAUDE.md` with a codeword;
- a `.claude/settings.json` with an allow rule, two deny rules (`Bash(./probe-denied.sh:*)` and
  `Read(./secret-denied.txt)`), `effortLevel: low`, `SessionStart` and `PostToolUse(Bash)` hooks
  that append to marker files, and `enabledMcpjsonServers: [probe-mcp]`;
- the skill `.claude/skills/probe-skill`, the subagent `.claude/agents/probe-agent.md`, and a
  `.mcp.json` naming a one-tool stdio MCP server;
- `counter.sh` and `test.sh`.

The brief has nine steps. The run states the codeword, runs the allowed and the denied script,
reads the denied file, invokes the skill, the subagent and the MCP tool, edits, tests and commits,
and quotes every refusal.

### The requester's runs (before this change, 0.15.1)

- **A, stock.** `--setting-sources user`, every `no*` switch false. Nothing of the project reached
  the run: no CLAUDE.md, skill, subagent, hook or project MCP. The denied script **ran** and the
  denied file **was read and quoted**, both by classifier accept. Effort was the forced `high`.
- **B, shimmed.** The argv was A's with only `--setting-sources user,project,local`. Everything
  arrived. Both deny rules refused, with decision `reject`, rule source `projectSettings`. The
  project's `effortLevel: low` was overridden by the forced `--effort high`: `"effort":"high"`
  ×14 in the journal.
- **Inherited variables.** A Bash call in the requesting session showed
  `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ATTENDED`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_SUBAGENT_EFFORT` and `CLAUDE_CODE_CHILD_NOTES_DIR`
  in its environment. All of these passed through 0.15.1's strip. The requester's runs removed
  them by hand.

### Run C: this branch, `profile: root`, no shim

The configuration was `cwd: <fixture>`, `claudePath: <native claude>`, `profile: root`,
`auth: caller`, `extraArgs: [--output-format, stream-json, --verbose]`. It was run as
`bun bin/bare-claude.ts --config root.yaml --custody runs/C-root --max-budget-usd 3 -- "$(cat
brief.txt)"`, with the fixture reset to its base commit. The six variables above were left in
the caller's environment, so this branch's strip had to remove them.

The run exited 0 after 14 turns, at $0.25.

- `invocation.json`: `effortLevel: null`, `permissionMode: auto`, `profile: root`,
  `settingSources: [user, project, local]`.
- Init event: `permissionMode: auto`, skill `probe-skill` and agent `probe-agent` present, MCP
  `probe-mcp` connected, `compact`/`autocompact` among the slash commands.
- Instruction file loaded: STEP 1 gave the codeword.
- Both deny rules refused, each `reject`, rule source `projectSettings`. Their messages were
  `Permission to use Bash with command ./probe-denied.sh has been denied.` and `File is in a
  directory that is denied by your permission settings.`. A combined command containing the
  denied script was refused too.
- The skill phrase, the subagent's reply and the MCP codeword were all quoted.
- Hook markers: one SessionStart line and three PostToolUse lines.
- The edit, test and commit worked: `PASS`, commit made.
- **Effort unforced:** the journal has `"effort":"low"` ×22, the project's setting, and the
  generated `settings.json` has no `effortLevel`.
- `messaging_socket_path` named the child's own pid (`/tmp/cc-socks/<child pid>.sock`), not the
  parent's socket.

## Decisions

- **`user` is required in `settingSources`.** It is the tier where this library writes every
  switch, so a list without it would silently drop the sandbox, permission and env settings.
- **The profile sets defaults only.** Any option given explicitly wins.
- **The root profile leaves four switches as they are**: `noIntegrations`, `noHousekeeping`,
  `noBashEditDiff` and `noMothership`. They are not project capability. `noBashEditDiff` guards
  against tens of gigabytes of snapshot stores.
- **The worker's `no*` defaults are unchanged.** Choosing a profile per dispatched job kind is the
  consumer's call.
- **The CLI's worker default stays `acceptEdits`.** Under `--profile root` the CLI no longer
  applies it, so the profile's `auto` holds.

## Open, and not verified by anything

- **A worker now loads project settings, and nothing measures how they meet its `no*` switches.**
  Those switches are written into the user tier, and the project tier sits above it. Whether a
  project's `disableAllHooks: false`, `enabledMcpjsonServers` or `enableAllProjectMcpServers` can
  undo them was not measured. Deny rules applying was measured only with every switch off (B, C).
- **Is `CLAUDE_CODE_SUBAGENT_MODEL` something an operator sets on purpose?** It is stripped as a
  parent-session variable. A caller who wants it passes it through `spawnOptions.env` or
  `extraEnv`.
- **Not measured:** a mid-run inbox message, a compaction actually happening, survival past the
  starting session, and the classifier on a push.
