# 2026-10-15 — explicit invocation, caller-managed auth, file session seed, stopping a run

Started at public `main` 90a7ff6 (0.9.0, `[Unreleased]` carrying the token file and
`noBashEditDiff`). Written over four rounds by Opus 5.5 with file tools only: the author ran no
shell, no typecheck, no tests, no `claude`, in any round. Between rounds, independent source
reviews were made and the operating session ran the checks recorded under "What was run". One
change in the candidate is the operating session's, not the author's: `src/preset.ts`'s merge was
rewritten to fix a typecheck failure (below).

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

All by the operating session, on macOS with Bun 1.3.13 (bf2e2cec), as `bun run typecheck && bun
test`:

- **After round one plus the operating session's platform guard (bd3ef2a):** typecheck clean,
  363 pass, 0 fail, 1035 `expect()` calls. The seed tests then named no branch, so that log does
  not say which ran.
- **Round two as written:** typecheck failed, `src/preset.ts(83,17): error TS2589: Type
  instantiation is excessively deep and possibly infinite`, and no test ran. The operating session
  replaced the `deepmerge` call there with `deepmergeIntoCustom`, keeping its semantics; that code
  and its test are not the author's.
- **9742078 (round two, with that repair):** typecheck clean; 391 tests across 20 files, 390
  pass, 1 skip, 0 fail, 1192 `expect()` calls. The skip is the test that runs only under
  `BARE_CLAUDE_REQUIRE_CLONE=1`. Every seed test took the `[clone branch]`, so on that host the
  forced clone ran and the published journals were clones. All five termination tests passed.
- **326fa42 (round three):** typecheck clean; 399 pass, 1 skip (the same conditional test), 0
  fail. The seed tests again took the clone branch, and SIGHUP on a run with a temporary home
  exited 129.
- **Round four:** unrun at authoring. The operating session runs it and records the result here.

What those passes establish is their scope: one macOS host, one Bun version, fakes for `claude`
and for a launcher. In particular they show, on that host, that `process.kill` with a negative PID
reaches a process group, that `detached` makes the spawned process lead one, and that `Bun.spawn`
rejects for an executable that does not exist before anything is spawned. They say nothing about
Linux, about the real `claude`, or about the real managed launcher.

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
  `linkAuth`. `LaunchConfig` also refuses any other value at run time: an untyped caller's
  `'none'` turned every fallback off without a word.
- **The doctor resolves the invocation, not the shell**, through the same `mergeInvocation`,
  `LaunchConfig` and `buildEnv` as a run. When the invocation does not resolve, round two fell back
  to the command line alone for every item, and so could open the default token file for an
  invocation whose configuration declared `auth: caller`. Round three keeps that fallback only
  where there is no configuration at all (outside a Git working copy, the located one asked for)
  — what the doctor always did. Any other failure leaves the `auth` item a warning that checked
  nothing; `claude` is still looked for from the command line, and says so, since a `--version`
  probe touches no credential.
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
- **Stopping a run.** Round one let a SIGTERM kill the CLI alone; `claude` went on running and
  writing the kept journal, unreported. From round two:
  - The child is spawned `detached`, which bun-types 1.3.13 documents as `setsid()` on POSIX, so
    it leads a group whose id is its PID, and everything it starts is in that group unless it
    calls `setsid()` itself. The group is the boundary because the spawned process may be a
    launcher supervising the native process as a grandchild.
  - The first signal goes to the spawned process alone, so a supervising launcher can shut down
    in its own order; then once to what is left in the group; then SIGKILL to the group at the
    grace (10 s, chosen, not measured) or a second signal. Every step is bounded.
  - Only the process Bun spawned is signalled, through Bun's handle, and only the group whose id
    is its PID; 0, 1, negative ids and the caller's own PID are refused. POSIX keeps a PID from
    being reused while a process group of that id has members.
  - Exit status 128+n of the signal received, whatever `claude` returned.
- **The supervision is a library export the CLI consumes (round three).** Round two wrote the
  signal policy — hold a signal that arrives during the spawn, escalate on a second, wait for the
  stop before removing the home — inside the CLI, and the README showed library callers a handler
  that had none of it: `process.once`, so a second SIGTERM killed the caller and orphaned the
  detached child; only SIGTERM; `dispose()` without waiting for the stop. That example invited
  exactly the copied and patched launcher this change exists to remove. `superviseSignals()` in
  `@agladysh/bare-claude/lifecycle` is now that policy, the CLI runs on it unchanged, and the
  README's example is a call to it. Its signal source is injectable, so its tests deliver signals
  without sending any to the test process.
- **Every run reports its process group at spawn (round three).** Detaching the child moved it out
  of the CLI's own group, so a supervisor that kills that group — `timeout -k`'s final SIGKILL —
  no longer reaches it. Round two reported the group only for kept homes. Now every run does; the
  README and CHANGELOG state the contract: signal `bare-claude` itself and allow it
  `--stop-grace-ms` plus 5 seconds before a kill of one's own, or signal the reported group.
- **One stop at a time, bounded by construction (round four).** A review of 326fa42 found that a
  signal during a stop `finish()` had started began a second stop, with a fresh grace, where the
  documentation promised SIGKILL at once; that a list naming a signal twice installed a handler
  `release()` could not remove, so the process stopped exiting on that signal for good; and that
  an absent `graceMs` from an untyped caller made the deadline NaN, so SIGKILL never came. Any
  signal during any stop now escalates that stop; inputs are validated before the first handler
  is installed or the first signal sent; signals are deduplicated.
- **`release()` is refused once a run is attached (round four).** It used to remove the handlers
  mid-run or mid-stop, after which the next signal ended the caller and orphaned the detached
  run. Documenting that as the caller's responsibility would leave a public function whose only
  use after `attach` is a mistake; `finish()` already covers every legitimate case, stopping what
  is still running before it lets go.
- **Attach before anything fallible (round four).** The CLI wrote its stdout and stderr lines
  between the spawn and `attach`; a write to a closed pipe there would have left the detached
  child unattached and running. It now attaches as soon as the spawn returns, and everything
  after is inside the `try` whose `finally` finishes supervision.
- **Leftovers after a natural exit (round four).** Something the run left in its group may hold
  the child's stdout pipe, which the CLI drains; a read pending on it could keep the CLI alive
  until that process ended. Once supervision has finished, the CLI cancels its own reader — the
  pipe is one it created for this run, nobody else's — and the leftovers are reported as not
  signalled and possibly still running, and the home is kept rather than removed under them. The
  exit code stays the spawned process's own: it never says that everything the run started has
  ended.
- **A signal after the run ended on its own is not its outcome (round three).** Round two turned
  any first signal into 128+n, even one that arrived after `claude` had exited with its own code.
- **A failed spawn takes back what it published.** The journal is removed only while the path
  still names the file this call created; the history line is truncated away only while the file
  ends exactly where that line ended, through the descriptor that wrote it. Anything else is left
  and named in the error. Between check and removal there is a window no POSIX call closes; one
  live run per home keeps anything from using it, and it is documented as the runner's.
- **`settings.json` is replaced atomically, mode 0600.** A half-written one under a live run in
  the same home would be dropped whole by Claude Code (CLAUDE.md), and it may carry
  `extraSettings.env` secrets. Whether Claude Code reloads it while running was not checked.
- **No home lock.** One live run per home is documented as the runner's rule rather than enforced
  with a lock file, whose stale-lock handling after a SIGKILL would be its own design.
- **`linkAuth` still defaults to true under `fallback`**, a caller's home included. Defaulting it
  off there would change what `fallback` means by where the home came from. Documented instead.
- **Session ids must be able to name a file**: a letter or digit, then letters, digits, `.`, `_`,
  `-`, 128 at most. Whether Claude Code refuses a non-UUID `--resume` id was not checked.
- **`--debug` withholds by place, and says what it does not (round three).** Round two redacted
  three variable names; a credential under any other name in `extraEnv` or `extraSettings.env` was
  printed. Every value in those two blocks is now shown as its length, names kept, as is an
  in-memory session journal. `extraArgs`, the rest of `extraSettings`, prompts and paths are still
  printed as given, and the docs say so: this is a bound on two known channels, not a sanitizer.

## The clone branch in tests

Which branch a seed test takes is decided once per run by a probe on `os.tmpdir()`: a forced
clone of a small file there either succeeds or fails, and by the source reading above a success
is a clone. The platform does not decide it — macOS does not imply APFS. Test titles carry
`[clone branch]` or `[refusal branch]`, so a log records which ran, and
`BARE_CLAUDE_REQUIRE_CLONE=1` turns a refusal into a failure on a host known to clone.

## Where a review, or a previous report, was wrong

- **Round one's report** cited a disk-sharing measurement it had not made, carried provenance
  wording that does not belong in a public record, and said no signal handling was needed. All
  three were corrected in round two.
- **Round one's adoption recipe** had a runner hash the journal named by the end-of-run line,
  which a killed CLI never prints, and passed `USER` where the README's example did not.
- **Round two's report misattributed the reviews.** It said a review had asked for "a 1 GiB disk
  probe and a source lock, and withdrew both". What the records show: the first review, which
  could not read the commission records, listed among native observations watching free space
  while seeding about 1 GiB on APFS, and asked that the absence of a source lock be *documented* —
  it never asked for a lock. A later review, after reading the records, corrected its earlier
  treatment of this package's licensing as an open question and withdrew the 1 GiB observation as
  unnecessary. The latest review confirms it never requested a lock.
- **Round two's report** also listed as unestablished three Bun behaviours that the 9742078 run
  then exercised, and said every test was unrun after that run existed.
- **Round three's supervisor** broke its own documented promise when a signal arrived during a
  `finish()` stop, and accepted inputs that made it leak a handler or never escalate (above).
- **Round three's report** said its tests were unrun after root had run them on 326fa42.
- **Round two's README library example** was unsafe (above); **its CHANGELOG** carried a truncated
  duplicate of the `noBashEditDiff` entry, now removed.
- **Review finding, rebutted in part:** "on macOS the clone tests must require the clone branch".
  The branch is recorded and can be required, by an explicit switch, not by platform.

## Not established

- **Native resume of a cloned journal**: that real Claude Code resumes from a journal published
  this way, appends to the reported path, and does so with the cwd given through a symlinked alias
  (`/tmp`, `/var` on macOS). `cwd` is `path.resolve`d, not realpath'd; whether the project key
  needs the realpath is for that run to show.
- **Native stopping**: SIGTERM to a real run under the real managed launcher, and SIGKILL to the
  CLI followed by the runner signalling the reported group, each leaving the group empty.
- **`setsid()` and Claude Code**: a detached child has no controlling terminal. That `claude
  --print` does not need one was not checked.
- **Round four's tests**, as said above. A signal held during a CLI spawn is tested only through
  the library supervisor, where the test controls the timing; a write failing between spawn and
  attach is not tested at all, only removed as a possibility by the order of the code.
- **A leftover holding the CLI's own stdout or stderr**, under `--print` or otherwise: the CLI
  does not read those, so they cannot hold it, but they keep a pipeline downstream of it open.
- **A narrow window remains** where `claude` has exited but Bun has not yet observed it: a signal
  then starts a stop of an exited process and the status is 128+n.
- **A held signal followed by a failed spawn** exits 1 with the failure's message: there was
  nothing to stop, and the failure is the outcome.
- **What a kept home holds**, file by file and mode by mode, beyond what Bare Claude writes.
- **Linux and Windows**: nothing was run. File seeds are refused on Windows; stopping there
  signals the spawned process alone.
- **Wording already on public `main`, not added here**: environment-specific phrasing and personal
  paths in `src/token.ts`, `src/install.ts`, earlier session reports and
  `session-events-example.txt`. The two `src/` files ship in the package; cleaning them is a
  separate change.

## Root verification of supervisor edge repairs

On 16 October 2026 at 00:51 UTC+03:00, Codex (AI) ran `bun run typecheck` and `bun test` on the preceding source changes. Type checking passed; the suite reported 405 pass, 1 conditional skip and 0 fail across 20 files. These are synthetic process and wrapper checks, not native managed-launcher acceptance. The exact check outputs remain in the receiving maintainer's run custody. The new edge cases ran, including the signal during `finish()`, invalid inputs, duplicate-handler release and the natural-exit leftover holding the child pipe.
