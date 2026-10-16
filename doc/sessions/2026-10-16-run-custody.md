# 2026-10-16 — run custody, composed configuration

Base: published `0fa4f8a` (v0.10.0, tag `v0.10.0`), where `readProcessGroup`, `ProcessGroupReading`
and the natural-exit group handling already ship. Written by Opus 5.5 with file tools only: no
shell, no `claude`, no model. Root then added `cancellationRequested`: TypeScript had narrowed
`options.signal?.aborted` after the early refusal and rejected the post-spawn check. On macOS
with Bun 1.3.13 on 16 October 2026, the typecheck and 57 focused tests (251 assertions) passed;
the full suite passed 447 tests, with one conditional skip and 1568 assertions. Independent
reception added two discriminating tests; the focused suite then passed 59 tests, 259 assertions.
Root froze it as `b34dcf9`; it ships as 0.12.0, after the outcome reader (below).

Sources: an earlier custody candidate (not applied), a seven-defect correction of it (not
applied), and a causal inquiry into copied launch recipes. This is the first materialization.

## The ask

A caller keeping many headless runs needs, per run: a fresh directory no other run shares; the
child's raw output on disk as it is written; honest start and end records; stopping through the
maintained supervisor; a group reading that says what it covers; and events it can attend to rather
than poll for. It also needs all of that from one declaration, with no `--quiet`/`--print` held
outside the file. The causal inquiry found that only 5 of one consumer's 65 invocation files declared
`quiet`, the rest depending on a flag outside the file, and that a launch recipe had been
re-derived three times, each derivation dropping something different (`USER`, a completion record,
`quiet`).

## Decisions

- **One library function, the CLI its consumer.** `runInCustody` builds on `spawnClaude`,
  `superviseSignals` and `readProcessGroup`. There is no second lifecycle and no runner of its own.
- **The child's own descriptors, not pipes.** Its output reaches disk as it is written, survives
  the runner being killed, and a leftover holding it cannot hold the runner. Custody closes its
  copies right after the spawn.
- **Records written once, exclusively**: invocation before the spawn, start after it, completion
  at the end. `start.recorded` is when the record was written, not process birth. Invocation-only
  and start-only directories are both documented as unknown outcomes.
- **`stopped` comes from the supervisor's own `stopping` event**, not from the presence of a stop
  report. A stop whose `stopClaude` rejected is still a stop: `stop.report` is null and
  `custodyError` says why. The candidate would have recorded that case as `exited` with no stop.
- **A start that cannot be recorded stops the run** (`custody-error`), since nobody could later
  find it.
- **No continuation field.** An empty group covers one group; a `setsid()` descendant or a
  launcher's native child in its own session is outside it. The journal's path, id, size and digest
  are recorded, and the seed's digest pin is the boundary. A test shows both halves: an escaped
  writer keeps appending after `empty`, and a seed built from the completion is refused.
- **Identity is the caller's reading.** `identify(pid)` is called synchronously right after
  `attach`, and only three typed fields are recorded. Custody reads no process table.
- **Events are transport.** `onEvent` is best-effort and synchronous. The CLI writes one JSON line
  per event, and treats any write error (thrown, write callback, or `'error'` event) as the end of
  the stream: it says so once on stderr, and the run, its completion and its exit status go on.
- **Exactness about contents.** The records hold no environment value, settings or read token.
  `extraArgs` are verbatim. `home/` holds settings (with `extraSettings.env`), the journal (with the
  call to action, whatever `keepCallToAction` says) and, under `linkAuth`, the credential link.
  `linkAuth` is recorded so a reader knows the last may be there. Nothing promises the directory is
  free of sensitive material.
- **Configuration composition, because one file could not do it.** `--use` sees only the presets in
  the one file read, and many fields (`cwd`, `customSessionData`, `extraEnv`, `preload`, `custody`)
  have no flag. A shared profile therefore had to be copied into each run's file, the pattern the
  inquiry traced. `--config` is now repeatable. `loadConfigFiles` validates each file with the
  existing schema; `composeConfigs` pools named presets and merges roots with the existing preset
  merge. Duplicate preset names, two root `use`s and one file named twice are refused, not
  guessed. There is no include key and no second resolver.
- **`ConfigSource` is unchanged; `--doctor` refuses several `--config` files.** `src/doctor.ts` was
  outside this session's write grant. A `files` variant would have typechecked while the doctor's
  `preset` item silently validated the located file instead. Refusal is the honest interim.

## Where the sources were wrong, or were departed from

- The candidate's continuation seed on an empty group (correction D2), its single `EPERM` reading
  (D1), its `started` field and "names the group to end" (D3), its silence on invocation-only (D4),
  "nothing sensitive recorded" (D5), "delivery" for a callback (D6), and native/launcher conflation
  (D7). All are corrected as the correction described.
- The correction asked that custody ship in the same release as the group-visibility change. That
  is superseded: the group change is in 0.10.0, and custody needs its own release.
- The correction's closed-reader test cancelled the parent's `ReadableStream`, and whether that
  closes the pipe was not established. Here the CLI writes into `| true` in `sh`, so the reader is
  gone before the first line, and the CLI's own status is written to a file by the shell around it.
- Neither source saw that one configuration file could not combine a profile with a declaration.

## Not established

- Numeric stdout descriptors on other Bun builds or platforms. A focused test on Bun 1.3.13,
  macOS, found the parent descriptor open at spawn and after child exit, with device/inode
  matching its file, before the caller closed it. The byte-for-byte tests alone would not
  establish ownership: the child's copy exists before Bun could close the parent's.
- Why SIGPIPE did not kill the CLI in the closed-reader test. The test passed on this host:
  it kept the child's status 3 and reported the ended event stream on stderr. The signal
  disposition inherited through `bun test`, `Bun.spawn` and `sh` was not established.
- Whether Bun can reap the child before `identify` runs; on Linux it may reap on a waiter thread.
- Linux, Windows, the real `claude`, any managed launcher, a custody directory on a filesystem
  other than the source journal's.
- `--doctor` over composed files; whether the doctor should check that a declared custody directory
  is absent and its parent present.
- A held signal followed by a refused custody directory is dropped with the refusal, as for a
  failed spawn.

## Integration with the outcome reader

Custody `b34dcf9` (on `0fa4f8a`) merged with the published outcome reader `fa4889a` (v0.11.0,
also on `0fa4f8a`). Conflicts in `CHANGELOG.md` and `bin/bare-claude.ts` only; the merge was
resolved by Opus 5.5 with file tools only, no shell.

- **The offline readers come before any configuration is chosen**, as in 0.11.0. `--outcome`,
  `--journal` and `--outcome-batch` return before `configChoice`, so composed `--config` files,
  `--config` with `--no-config`, and `--custody` neither refuse nor change them. The rejected
  alternative, choosing configuration first, would have made `--outcome F --config a --no-config`
  an error where 0.11.0 read `F`.
- **Launch flags given with a reader are ignored, not refused**, `--custody` included: no
  directory is made. `--usage` and `--display` already behaved this way. Refusing them would be a
  new CLI rule, and it was not made here.
- **Release.** The custody entry became `[v0.12.0] - 2026-10-16` above the v0.11.0 entry, which is
  unchanged, with one sentence added to the `--config` item saying the readers read no
  configuration. `package.json` is 0.12.0.
- **Tests.** Before the merge, custody: the full suite passed 447 tests, with one skip and 1568
  assertions, and the received focused suite passed 59 tests with 259 assertions. The outcome
  reader: 449 passed, with one skip and 1500 assertions, then 30 focused release tests. At the integration worker's return, no test covered a reader given with several `--config`
  files, and the combined check had not run. Root's subsequent checks are recorded below.
- The integration commission used an ambiguous project abbreviation for the two reception
  returns. The worker attempted nonexistent source paths, then returned without reading them.
  Those refusals do not establish a permission defect. Root had read both complete returns
  and applied the required corrections before this integration.
- Root subsequently ran the combined typecheck and full suite: 479 pass, one conditional skip,
  1688 assertions on Bun 1.3.13, macOS, 16 October 2026. Root then added the discriminating
  offline-reader/composed-config regression the integration worker proposed; its focused
  verification passed: typecheck and seven offline-reader CLI tests, 23 assertions.

## What this is not

A working-tree candidate. It does not track context exhaustion or learn anything by itself. A
caller still has to receive the `completed` event or read the directory, and a consumer's profile,
native attribution and adoption are that consumer's own work.
