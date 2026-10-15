# 2026-10-15 — explicit invocation, caller-managed auth, file session seed

Started at public `main` 90a7ff6 (0.9.0, `[Unreleased]` carrying the token file and
`noBashEditDiff`). Opus 5.5, no subagents, no shell: files were read and written, and nothing was
run — no typecheck, no tests, no `claude`, no model. Everything below that says "verified" was
verified by reading; the suite has not run against these changes.

The ask: a consumer driving the CLI from another repository needs to declare one invocation —
cwd, a home it keeps, tool and read scope, environment, auth and a continuation seed — without
copying a TypeScript launcher, and without the repository it runs in contributing configuration
it did not ask for.

## The concrete failure

A first attempt ran the CLI from a checkout of this repository. `bare-claude.yaml` here has
`use: default` at its root, and `default` uses `lmstudio`, whose `extraEnv` sets
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`. Every CLI run from a checkout therefore carries
an alternate provider's credential, and the caller's own launcher correctly refused the
competing credential, exit 5 before any model work. There was no way to say "not that file":
the CLI always read `bare-claude.yaml` at the Git root and refused to run outside a working copy.

## What already worked, and was not rebuilt

- **A retained home.** `ephemeralClaudeHomePath` is a preset key, and `dispose()` never removed
  a caller's home. What was missing was a flag, absolute resolution, and a report of where the
  journal is.
- **A scrubbed environment.** `noProcessEnv` plus `spawnOptions.env` in the library; `env -i` in
  front of the command line. An inherit-only-these allowlist was considered and rejected: it
  would be a second knob for what `env -i` already says.
- **Tool and read scope.** `tools`, `disallowedTools`, `addDirs` were already typed preset keys.

## Decisions, and why

- **`ConfigSource` is a tagged union**, `located | file | none`, not `string | null` for
  `--config`. `tokenFile: null` already means "resolve the default", not "none", and the same
  shape here would mean the opposite. A named file must exist (a typo must not silently become
  "no configuration"); `none` ignores even an invalid located file.
- **`auth: 'fallback' | 'caller'`, not `tokenFile: false`.** The 2026-09-11 report rejected an
  opt-out switch on the grounds that a caller without a file either has a credential already or
  can name a path that does not exist. A managed launcher breaks the first premise: it brings its
  own credential, so the environment it is handed has none, and that absence is exactly what
  triggered the fallback. The second is a workaround, not a contract. One field covers both of
  Bare Claude's own sources — the token file and `linkAuth` — because "the caller owns auth" is
  one decision; `linkAuth` now defaults from it. Explicit `linkAuth: true` or a `tokenFile`
  beside `'caller'` throws in `LaunchConfig`, which the CLI calls before any preload so a preload
  shell command never runs for a refused invocation.
- **The doctor's auth item under `'caller'` is `warn`, not `ok`.** It has inspected nothing;
  reporting the caller's route as healthy from a mode label would be inference.
- **No environment variable stripping in either mode.** Whatever credential variables reach the
  child are the caller's layers' doing; the fix for an unwanted one is choosing the configuration,
  not filtering.
- **The file seed is ported from the unpublished 2026-10-14 work, not invented.** Same contract:
  regular single-link non-symlink source, optional full lowercase digest, hash before and after,
  forced clone into a private staging directory beside the destination, clone hashed, exclusive
  hard-link publication, staging always removed, no byte-copy fallback. Rewritten in this
  repository's style; three changes. The destination is checked before cloning as well as at
  publication, so "already exists" is reported the same way on a host that cannot clone. A
  failed clone is wrapped in a message that says no byte copy was made, instead of the bare
  errno. The module is imported relatively and kept out of `exports`: it is internal.
- **CLI preloads refuse to extend a file seed.** The earlier work read the seed file into a string
  when preloads were present, which is the byte copy the file route exists to avoid, made
  silently. Refusing is explicit and reversible; cloning and then appending the synthetic records
  is the obvious extension if someone needs it.
- **The in-memory seed writes exclusively (`wx`, 0600)** and `history.jsonl` is appended. Both
  were truncating writes, which was harmless while every home was a fresh temporary directory
  and is destructive now that a caller's home is a supported thing to reuse. The journal is
  published before the history line, so a refused seed leaves no history behind.
- **A spawn that fails before the child starts removes the temporary home it made.** The token
  file refusal from 2026-09-11 leaked one, unnoticed because the CLI test only asserted the
  message.
- **The CLI's preload cwd follows `preset.cwd`.** With a declared `cwd`, `--read` resolved
  against the launching directory and the synthetic records claimed it, while the child ran
  elsewhere.
- **Kept homes are reported with a second stderr line, `Claude session journal at …`**, only when
  the file exists. A CLI consumer needs the path to seed the next run, and the project-directory
  naming (`pathToFilename`) is not something a consumer should reimplement.
- **`--debug` redacts credential variables by key, at any depth of the dumped preset.** The
  token file was already kept out of it; a credential a caller passes through `extraEnv` was
  not. Redacted by name (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`),
  not by pattern: a provider credential under another variable name is still printed. Values a
  caller writes into `extraSettings.env` still land in the home's `settings.json`, as before.
- **No signal handling was added.** On SIGTERM the CLI dies without forwarding it; the child is
  orphaned and may keep appending to the journal for a while. A caller's home survives either
  way, which is what is tested. Forwarding signals would change the interrupted run's exit
  status in ways not measured here.

## Where earlier records were wrong or incomplete

- README and `LaunchOptions` said of `noProcessEnv` that "authentication variables are never
  stripped". With `noProcessEnv: true` they are dropped along with everything else.
- The 2026-09-11 rationale for no token-file opt-out (above).
- `spawnClaude`'s comment "Assumes directory to be created if path is supplied" was not what the
  code did: the project directory was created recursively, home included, but only after the
  credential link had silently failed to land in the missing home.

## Not measured, and open

- **Clone behaviour.** The zero-private-bytes observation is the 2026-10-14 work's (APFS, Bun
  1.3.13, an 8 MiB synthetic journal), not re-made here. CI runs on ubuntu-latest, whose ext4 cannot
  clone; the seed tests branch on a probe and assert the explicit refusal there, so CI will
  exercise only the refusal path. The successful path is only exercised on a cloning filesystem
  (APFS, Btrfs, XFS with reflink).
- **Whether Bun honours `COPYFILE_FICLONE_FORCE` as refuse-rather-than-copy on Linux.** Node's
  contract is that the flag fails when cloning is unsupported. If Bun quietly copied bytes
  instead, the tests' own clone probe would report "can clone" and every test would pass while
  the no-byte-copy guarantee was false. Probe on a Linux host: `copyFileSync(a, b,
  constants.COPYFILE_FICLONE_FORCE)` on ext4 must throw, and on Btrfs `du`/`filefrag -v` of the
  result must show shared extents.
- **Whether real Claude Code accepts a resumed journal under a session id other than the one its
  records carry.** The seed takes `sessionId` from the caller; the README example uses the prior
  session's own id. Not probed.
- **Whether real Claude Code keys `projects/` by the realpath of cwd.** `cwd` is now
  `path.resolve`d, not realpath'd; on macOS `/var` vs `/private/var` could differ. Unchanged
  behaviour for absolute input; not probed.
- **Signal forwarding** (above).
- **This repository's own `bare-claude.yaml`** still applies LM Studio to every run from a
  checkout. Whether its root should stop doing so is the author's call; `--no-config` removes the
  hazard for callers either way.
- **Lineage.** The file seed's prior art sits on an unpublished branch whose ownership and
  attribution are not settled; this change carries its design, not its history.
