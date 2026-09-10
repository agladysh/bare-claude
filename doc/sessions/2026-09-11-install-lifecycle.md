# 2026-09-11 — install lifecycle

Claude Code 2.1.268, macOS, Bun 1.3.13. Started at `main` (2a8b437): version 0.8.6 in
`package.json`, with the whole 2026-07-26 pass sitting under `[Unreleased]`. Work done by Fable 5.1,
no subagents, on branch `install-lifecycle`.

The ask: the operator's estate note (2026-08-27) lists bare-claude as "not installed, that should
be repaired". Bring the checkout to the lifecycle level of the estate's installed tools (`arret`,
`sc-tool`): a command on `PATH` via `~/.local/bin`, an installer with status and uninstall, a
doctor that says what is missing, help an agent can read without the README. Reference
implementation: `sc-tool/bin/install-sc-tool.ts` + `sc-tool/src/install.ts`.

## Measured

**Bun runs a `.ts` file through an extension-less symlink.** Probe:

```bash
ln -s /path/to/checkout/bin/bare-claude.ts /tmp/linkbin/bare-claude
cd / && /tmp/linkbin/bare-claude --version        # 0.8.6, exit 0
PATH=/tmp/linkbin:$PATH bare-claude --help          # real help, exit 0
```

Bun realpaths the entry point before choosing a loader, and package-name imports
(`@agladysh/bare-claude/display`) resolve against the real location. The installer rests entirely
on this; `src/install.test.ts` re-asserts it on every run ("the installed command runs under the
system bun from anywhere"), so a Bun release that stops doing it fails the suite rather than the
operator's shell.

**Bun strips a leading `--` from argv, and only a leading one.** Probe, with a script that prints
`Bun.argv.slice(2)`:

```
bun argv.ts -- --x a        -> ["--x","a"]          stripped
bun argv.ts --quiet -- x    -> ["--quiet","--","x"] kept
bun argv.ts a -- b          -> ["a","--","b"]       kept
bun argv.ts -- -- x         -> ["--","x"]           one stripped
```

Consequence: `bare-claude -- doctor` reaches `parseArgs` as the one-word prompt `doctor`, and
`bare-claude --quiet -- doctor` reaches it as `--quiet -- doctor`, which `parseArgs` also reads as
the positional `doctor`. A positional subcommand cannot be told apart from a call to action, which
is why the doctor is `--doctor` — a flag, like every other mode this CLI has (`--usage`,
`--display`, `--version`). The comment in `test/spawn.test.ts` saying Bun "strips a literal `--`"
is true only of a leading one; the test it annotates is unaffected.

**Package-name imports resolve at runtime without an `exports` entry.** Probe: a `src/zz-probe.ts`
imported as `@agladysh/bare-claude/zz-probe` from `bin/` ran fine before any `exports` change —
tsconfig `paths` does it. Adding `./doctor` and `./install` to `exports` is therefore API policy,
not plumbing; both are added and documented because CLAUDE.md wants every exported symbol in the
README.

**`bun run <script> --flag value` passes the flags through unchanged**, so
`bun run install:user --bin-dir DIR` needs nothing beyond the script entry.

**`claude` here is 2.1.268.** CLAUDE.md's measured facts are from 2.1.220 and were not re-verified
this session; nothing here touches the spawn path, the settings file, or the flag matrix.

## Decisions, and why

- **`--doctor`, not `doctor`.** Above. The brief asked for the reason to be stated.
- **The install item is required, but any `bare-claude` on `PATH` satisfies it.** The estate note
  is about the command being absent, so absence fails the doctor. A `bun add -g` install resolves
  on `PATH` to something that is not this checkout's symlink and is reported `ok` with that said —
  the README lists that route first, and a doctor that fails on it would be wrong. Installed in
  `~/.local/bin` but with that directory not on `PATH` fails, with the `export PATH=` line as the
  hint: the operator's real complaint is "not runnable", not "no symlink".
- **A missing token is `fail`, downgraded to `warn` when `ANTHROPIC_API_KEY` or
  `ANTHROPIC_AUTH_TOKEN` is present.** The LM Studio example in the README authenticates through
  `ANTHROPIC_AUTH_TOKEN`; an ollama or LM Studio user must not get exit 1 from the doctor. The
  setup-token guidance is printed in both cases, verbatim from the README. An empty variable counts
  as absent. The value is never printed; a test asserts that.
- **`git` is a sixth item.** The brief listed five. `git` is in the README's assumptions, and
  without it the preset check would have crashed inside `locateConfig` instead of reporting.
- **`locateConfig()` moved into `src/config.ts`.** The doctor must report the file a run would
  load; the only way that holds by construction is one function for both. Side effect: running
  outside a Git working copy now says so and exits 1, instead of the shell helper's
  "Failed with exit code 128" under git's own `fatal:` line.
- **The doctor takes `env`/`cwd`/`binDir`/`claudePath`, not probe callbacks.** The tests assemble
  a machine — temporary HOME with the checkout installed, temporary working copy, a `PATH` built
  from the fake `claude`, the running bun and git — and drive the real `Bun.which` + spawn path.
  Callback injection would have tested the callbacks. The fake `claude` learned `--version` for
  this, which SessionBuilder's probe also uses. `runCli` in `test/helpers.ts` now builds on
  `options.env.PATH` when given, still with the fake `claude` first.
- **Foreign means anything that is not a symlink resolving into this checkout**, including a
  dangling link from a moved checkout. `--force` replaces a symlink or a regular file; a directory
  is never replaced, forced or not, because `rm -r` on a bin entry is not what an installer should
  be able to do.
- **`install()` chmods the source to 0755**, as sc-tool does. Git tracks the bit and it is already
  set, but the shebang is the entire mechanism and a checkout is not the only way the file arrives.
- **Version 0.9.0.** The `[Unreleased]` block carries bold-marked breaking changes from the
  2026-07-26 pass (`sandbox.failIfUnavailable`, the `events.ts` guard renames), so the next release
  is a minor bump, not the patch bumps the changelog shows before it. The `chore: v0.9.0` commit is
  the last on the branch and carries nothing else, so it can be dropped or tagged independently.
  No tag was created; that is the operating session's call.

## Where the brief and the code disagreed

- The brief's step 5 says to run `bare-claude doctor`. The CLI's argument model made that a flag
  (above), so `bare-claude --doctor` is what was run. The brief allowed for this.
- The brief's item list for the doctor has five entries; there are six (`git`, above).

## State at the end

274 tests across 14 files, typecheck clean, `bun pm pack --dry-run` clean. Installed for real:
`~/.local/bin/bare-claude -> /Users/agladysh/projects/bare-claude/bin/bare-claude.ts`; nothing
foreign was at that path. `bare-claude --doctor` from another working copy reports every item `ok`
except `auth`, which fails because `CLAUDE_CODE_OAUTH_TOKEN` is not in the operator's shell — the
doctor doing its job, not a defect. From `/private/tmp`, which is no working copy, `preset` is a
`warn` on top of that and nothing else changes.

## Open

- Which of the operator's two claude accounts a bare run's token belongs to is undecided. Out of
  scope here by instruction: no credential storage, no account switching was designed.
- Nothing automated exercises `--doctor` against the real `claude`, the same gap the spawn tests
  have; both are exercised by hand only.
- `install` reports a non-checkout `bare-claude` on `PATH` as "not an install of this checkout".
  Accurate, but if the operator intends the global package to be the one on `PATH`, the checkout's
  own doctor will keep saying so.
- CLAUDE.md's measured facts still say 2.1.220; the machine is on 2.1.268. Re-verification is a
  separate session.
