# 2026-10-15 — explicit invocation, caller-managed auth, file session seed, stopping a run

Started at public `main` 90a7ff6 (0.9.0, `[Unreleased]` carrying the token file and
`noBashEditDiff`). Written over two rounds by Opus 5.5 with file tools only: the author ran no
shell, no typecheck, no tests, no `claude`. Between the rounds an independent source review was
made, and the operating session ran the checks recorded under "What was run".

The ask: a consumer driving the CLI from another repository needs to declare one invocation —
cwd, a home it keeps, tool and read scope, environment, auth and a continuation seed — without
copying a TypeScript launcher, without the repository it runs in contributing configuration it did
not ask for, and with a run it stops actually stopping.

## The concrete failure

A first attempt ran the CLI from a checkout of this repository. `bare-claude.yaml` here had
`use: default` at its root, and `default` uses `lmstudio`, whose `extraEnv` sets
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`. Every CLI run from a checkout therefore carried an
alternate provider's credential, and the caller's own launcher correctly refused the competing
credential, exit 5 before any model work. There was no way to say "not that file".

## What was run, and what it establishes

- **By the operating session, after round one plus its own platform guard (bd3ef2a):** `bun run
  typecheck && bun test` on Bun 1.3.13 (bf2e2cec), macOS: typecheck clean, 363 pass, 0 fail, 1035
  `expect()` calls. The seed tests then named no branch, so that log does not say whether the
  clone or the refusal branch ran.
- **This round:** nothing. Every test added here is unrun as written. Where a test rests on a Bun
  behaviour not read in its source, that is listed under "Not established".

## Bun's forced clone, from source

Method: read, not executed. The file is Bun's `src/bun.js/node/node_fs.zig` at tag `bun-v1.3.13`,
fetched from `https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.13/src/bun.js/node/node_fs.zig`,
sha256 `3150ccdbf18c9ed1fd5b8dc9e774fd4faaa613b0347e2a76e401181bd88291a1`. `copyFileSync` reaches
`copyFileInner` (line 3519):

- macOS, lines 3530–3532: with the force-clone mode, the result of `clonefile()` is returned,
  error or success; nothing falls back.
- Linux, lines 3635–3645: with the force-clone mode, `ioctl_ficlone`; on error the destination is
  closed, unlinked and the error returned.
- Windows, line 3737: `CopyFileW`, which the force-clone mode does not reach — a byte copy.

`_copySingleFileSync` (line 6271, with a `.todo()` for the Linux force branch at 6400–6401) is a
different function, used by `cp`; it says nothing about `copyFileSync`. Where `isForceClone()`
maps the numeric flag was not read: it is defined in another file. Hence the platform guard in
`cloneSessionSeed`, and "source-read at Bun 1.3.13" rather than "verified" wherever the docs speak
of it; `engines` admits any Bun from 1.3, and later versions have not been read.

## What already worked, and was not rebuilt

- **A retained home.** `ephemeralClaudeHomePath` was already a preset key, and `dispose()` never
  removed a caller's home.
- **A scrubbed environment.** `noProcessEnv` plus `spawnOptions.env` in the library; `env -i` in
  front of the command line. An inherit-only-these allowlist was rejected as a second knob for
  what `env -i` already says.
- **Tool and read scope.** `tools`, `disallowedTools`, `addDirs` were typed preset keys.

## Decisions, and why

- **`ConfigSource` is a tagged union**, `located | file | none`, not `string | null`: `tokenFile:
  null` already means "resolve the default", and the same shape here would mean the opposite. A
  named file must exist; `none` ignores even an invalid located file.
- **`auth: 'fallback' | 'caller'`, not `tokenFile: false`.** The 2026-09-11 report rejected an
  opt-out on the grounds that a caller without a file either has a credential already or can name
  a path that does not exist. A managed launcher breaks the first premise: it brings its own
  credential, so the environment it is handed has none, and that absence is exactly what
  triggered the fallback. One field covers both of Bare Claude's own sources, the token file and
  `linkAuth`. `LaunchConfig` now also refuses any other value at run time: an untyped caller's
  `'none'` turned every fallback off without a word.
- **The doctor resolves the invocation, not the shell.** Round one gave it `--config`, `--auth`
  and `--token-file` but still looked at the shell's environment and ignored the configuration's
  `auth`, `claudePath`, `cwd`, `noProcessEnv`, `extraEnv` and `--use`. Each was a case where the
  doctor and the run disagreed. Both now go through `mergeInvocation`, `LaunchConfig` and
  `buildEnv`. Outside a Git working copy the located configuration is still a `warn`, as before,
  rather than a failure: the doctor is also how an install is checked from anywhere.
- **The file seed's design predates this change and is reimplemented here.** Contract: regular
  single-link non-symlink source, optional full lowercase digest, hash before and after, forced
  clone into a private staging directory beside the destination, clone hashed, exclusive
  hard-link publication, staging always removed, no byte-copy fallback. The destination is
  checked before cloning as well as at publication; a failed clone says no byte copy was made.
  The module is internal, imported relatively and kept out of `exports`.
- **CLI preloads refuse to extend a file seed**, rather than reading the journal into a string —
  the byte copy the file route exists to avoid.
- **This repository's root `use: default` is gone.** A breaking change to an example file, made
  because the example was the failure above. `--use default` restores it.
- **Stopping a run (reverses round one's "no signal handling").** Round one let a SIGTERM kill the
  CLI alone; `claude` went on running and writing the kept journal, unreported. Now:
  - The child is spawned `detached`: bun-types 1.3.13 documents that as `setsid()` on POSIX, so it
    leads a group whose id is its PID, and everything it starts is in that group unless it calls
    `setsid()` itself. The group is the boundary because the spawned process may be a launcher
    that supervises the native process as a grandchild: a signal to one PID reaches neither the
    grandchild nor its descendants.
  - The first signal goes to the spawned process alone, so a supervising launcher can shut down
    in its own order; then once to what is left in the group; then SIGKILL to the group at the
    grace (10 s, chosen, not measured) or a second signal. Every step is bounded.
  - Only the process Bun spawned is signalled, through Bun's handle, and only the group whose id
    is its PID. 0, 1, negative ids and the CLI's own PID are refused. POSIX keeps a PID from being
    reused while a process group of that id has members, so the group cannot change identity while
    it is occupied; once it is empty, the stop stops probing it.
  - Exit status 128+n of the signal the CLI received, whatever `claude` returned.
  - The journal path and the process group are printed at spawn, not only at the end: a runner
    that SIGKILLs the CLI — which nothing can catch — has only those.
  - A run that ends on its own is not signalled; group members it leaves are reported, not killed.
  - The library spawns nothing detached unless asked: a caller relying on its terminal's Ctrl-C
    reaching the child would otherwise lose that. `stopClaude` is exported for callers who opt in.
- **A failed spawn takes back what it published.** The journal is removed only while the path
  still names the file this call created (identity taken from the creating descriptor or the
  staged clone); the history line is truncated away only while the file ends exactly where that
  line ended, through the descriptor that wrote it. Anything else is left and named in the error.
  The history line moved to just before the spawn, so a refused seed or settings write never adds
  one. Between check and removal there is a window no POSIX call closes; one live run per home
  is what keeps anything from using it, and it is documented as the runner's.
- **`settings.json` is replaced atomically, mode 0600.** Claude Code drops a settings file that
  fails validation whole and silently (CLAUDE.md), so a half-written one under a live run in the
  same home is a run that is no longer bare; and it may carry `extraSettings.env` secrets.
  Whether Claude Code reloads `settings.json` while running was not checked; atomic replacement
  bounds what such a reader could see, the one-live-run rule is what keeps it from mattering.
- **No home lock.** One live run per home is documented as the runner's rule rather than enforced
  with a lock file, whose stale-lock handling after a SIGKILL would be its own design.
- **`linkAuth` still defaults to true under `fallback`**, a caller's home included. Defaulting it
  off there was suggested; it would change what `fallback` means by where the home came from.
  Documented instead: a kept home may hold that symlink.
- **Session ids must be able to name a file**: a letter or digit, then letters, digits, `.`, `_`,
  `-`, 128 at most. Not "a UUID", which Claude Code's own ids are: whether Claude Code refuses a
  non-UUID `--resume` id was not checked, and the rule here is about the path, not about it.
- **`--debug` bounds its redaction rather than claiming one.** Three credential variables by
  name, and an in-memory session journal by length — a prior conversation can hold anything. The
  docs say everything else is printed.

## The clone branch in tests

Which branch a seed test takes is decided once per run by a probe on `os.tmpdir()`: a forced
clone of a small file there either succeeds or fails, and by the source reading above a success
is a clone. The platform does not decide it — macOS does not imply APFS. Test titles now carry
`[clone branch]` or `[refusal branch]`, so a log records which ran, and
`BARE_CLAUDE_REQUIRE_CLONE=1` turns a refusal into a failure on a host known to clone. Suggested
during review and not done: requiring the clone branch on every macOS host, and allocating a large
file to observe sharing; neither is needed to tell the two branches apart.

## Where a review, or a previous report, was wrong

- **Round one's report** cited a disk-sharing measurement it had not made, carried provenance
  wording that does not belong in a public record, and said no signal handling was needed. The
  first two are removed; the third is reversed above. Round one's summary also said nothing of
  the kind was in the public docs, which was wrong.
- **Round one's adoption recipe** had a runner hash the journal named by the end-of-run line,
  which a killed CLI never prints, and passed `USER` where the README's example did not. The
  journal line is now printed at spawn, and the README's example passes `USER` and `TMPDIR` with a
  note that a launcher's own documented requirements come first.
- **Round one's `spawnClaude` TSDoc** split its own bullet list; rejoined.
- **The first independent review** could not read the commission records and treated legal
  permission for this public MIT package as open; it withdrew that once it had read them. It
  also asked for a 1 GiB disk probe and a source lock, and withdrew both.
- **Review finding, rebutted in part:** "on macOS the clone tests must require the clone branch".
  The branch is now recorded and can be required, but by an explicit switch, not by platform.

## Not established

- **Native resume of a cloned journal**: that real Claude Code resumes from a journal published
  this way, appends to the reported path, and does so with the cwd given through a symlinked alias
  (`/tmp`, `/var` on macOS). `cwd` is `path.resolve`d, not realpath'd; whether the project key
  needs the realpath is for that run to show, not for a guess here.
- **Native stopping**: SIGTERM to a real run, under the real managed launcher, leaving no Claude
  Code process in `ps`, exit 143, both report lines, and a journal that stops growing. The tests
  model a supervising and an abandoning launcher in `sh`; the real one is not modelled.
- **`setsid()` and Claude Code**: a detached child has no controlling terminal. That `claude
  --print` does not need one was not checked.
- **Bun behaviours the new tests rest on without a source reading**: that `process.kill` accepts a
  negative PID as a process group, that `Bun.spawn` throws synchronously for an executable that
  does not exist, and that `detached` does what bun-types says.
- **What a kept home holds**, file by file and mode by mode, beyond what Bare Claude itself writes.
- **Windows**: file seeds are refused there; stopping signals the spawned process alone; nothing
  was run.
