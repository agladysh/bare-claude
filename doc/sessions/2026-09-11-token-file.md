# 2026-09-11 — token file

Claude Code 2.1.268, macOS, Bun 1.3.13. Started at `main` (30e0163, v0.9.0 unreleased) on branch
`token-file`, straight after the install-lifecycle session. Fable 5.1, no subagents.

The ask: the operator's OAuth token is not in the shell and is not going to be — in this estate
credentials live in dotenv files, a known way to end up with `Not logged in`. The operating
session wrote the bare token to `~/.config/bare-claude/oauth` (mode 0600). Make a bare run read
it when the environment has no token, make the doctor report it, and keep the value out of every
output.

## Measured

Nothing about Claude Code. Everything here is on our side of the spawn: the child's environment
is built by `buildEnv`, and the token joins it as the last step in `spawnClaude`. The real token
file was never read by anything but the installed `bare-claude --doctor` at the end (which reads
it to tell blank from present, and prints the path). Its mode and size were checked with `stat`;
its content was not printed, copied or grepped into anything visible.

Confirmation the doctor leaks nothing, run from a directory outside the checkout with the output
captured to a shell variable: `grep -qFf ~/.config/bare-claude/oauth` over the output found no
match, and no run of 40+ `[A-Za-z0-9_-]` characters appears in it. The `auth` line reads
`ok   auth: token file /Users/agladysh/.config/bare-claude/oauth`.

## Decisions, and why

- **Read at spawn time, in `spawnClaude`, not in the CLI.** The CLI's `--debug` prints the
  resolved preset, and `extraEnv` is part of it; a token placed there would be printed. Reading
  after `buildEnv` and writing straight into the env handed to `Bun.spawn` means the value exists
  in this process for the spawn and nowhere else. A black-box test runs `--debug` with a token
  file and asserts the value is in neither stdout, stderr, nor the kept ephemeral home's
  `settings.json`.
- **Resolved against the child's environment, not the wrapper's.** `HOME`, `XDG_CONFIG_HOME` and
  `BARE_CLAUDE_TOKEN_FILE` are taken from the env `buildEnv` produced. That makes the whole thing
  a function of the run's environment plus the option: `noProcessEnv` runs resolve from what the
  caller supplied (falling back to `os.homedir()` for `HOME`), and the tests inject everything
  through `extraEnv` without touching `process.env`.
- **Not beside an alternate credential, and not for the `ollama` launcher.** The brief said "when
  `CLAUDE_CODE_OAUTH_TOKEN` is absent"; this is narrower. A run with `ANTHROPIC_AUTH_TOKEN` and an
  `ANTHROPIC_BASE_URL` (the README's LM Studio example) is about to talk to something that is not
  Anthropic, and which credential Claude Code would prefer if both were present was not measured
  — so the subscription token is simply not handed over. Same for `ollama launch`. The gate is
  `hasCredential(env)`, the same predicate the doctor's warning uses.
- **An empty or unreadable file throws before the spawn**, naming the path only. The brief made
  empty a doctor failure; making the run fail on it too, with a message, beats letting `claude`
  say `Not logged in`. A missing file is silent: that is the ordinary state for everyone who is
  not this operator.
- **Exposed means any group/other permission bit** (`mode & 0o077`), reported as the three
  `chmod` digits. "Readable" alone would misdescribe a `0620` file. The doctor's wording is
  "readable beyond its owner"; the remedy is `chmod 600 <path>`.
- **`BARE_CLAUDE_TOKEN_FILE`** is the variable's name. Empty counts as unset at every step of
  the precedence, which is also how `runCli` in the black-box helpers keeps every test away from
  the real file: it defaults the variable to a nonexistent path, and a test wanting the default
  location sets it to `''` together with its own `HOME`.
- **`tokenFile` is a `LaunchOptions` field and a preset key**, `string | null`, null meaning
  "resolve it". No `noTokenFile` switch: a caller that does not want the file either has a
  credential already (gate above) or can name a path that does not exist.
- **CHANGELOG under `[Unreleased]`**, above the untagged `[v0.9.0]`. Whether to fold it into
  0.9.0 before tagging is the operating session's call.

## Where the brief and the code disagreed

- Narrower trigger than "absent from the environment": also requires no alternate credential and
  the `claude` launcher (above).
- The run fails on an empty file, not only the doctor.

## State at the end

314 tests across 16 files, typecheck clean. `bare-claude --doctor` from
`/Users/agladysh/projects/zq-traffic-research`: every item `ok`, exit 0, `auth` via the file.

## Open

- No live run was made against the real `claude` with the file-sourced token; the doctor is the
  only thing that touched the real file. A `bare-claude --quiet --print -- '…'` is the end-to-end
  proof and costs subscription usage; left to the operator.
- Which credential Claude Code prefers when `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN`
  are both set is unmeasured; the gate above makes the question moot for this code path.
- Account selection (two accounts) remains open from the previous session; the file holds one
  token and nothing here decides which.
