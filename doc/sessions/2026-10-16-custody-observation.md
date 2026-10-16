# 2026-10-16 — configuration provenance, custody reading, observation at the end

Base: published `4175f7f` (v0.12.0). Two rounds, both written by Opus 5.5 with file tools only: no
shell, no `bun`, no `tsc`, no `claude`, no model.

- **First round.** The maintainer typechecked it and ran the synthetic suite: 497 pass, one skip,
  1812 assertions. An independent reading of that cut rejected ordinary use pending five repairs.
- **Second round.** It makes those repairs and several smaller ones. The maintainer typechecked
  it and ran the suite: 504 pass, one skip, 1847 assertions. Directories written by published
  0.12.0, one fresh and one continued, read `exited` and joined with no problems, and a BOM-prefixed
  configuration parsed the same under both. A delta reception found one remaining defect: the
  join still ran over the whole journal.
- **Third round.** It joins over the appended reading whenever the boundary is verified (below).
  **It has not been typechecked or run.** `package.json` stays 0.12.0; the entry is under
  `[Unreleased]` as a 0.13.0 candidate.

Sources: a private receiving design and its independent reception, the reception of the first
round, and maintainer direction. Out of scope by that direction: an environment variable naming the
custody directory to the child, and any observer outside this package.

## Decisions

### Configuration provenance

- **Read once, by construction.** `readOnce` opens the file without blocking, `fstat`s the handle,
  reads it whole through that handle, and digests and parses those bytes. The old route
  (`Bun.file().exists()`, then `.text()`) was two operations.
  - **FIFOs.** A FIFO is refused at once. A blocking open would wait for a writer.
  - **`realPath`.** It is resolved after the read and kept only when it `stat`s to the device and
    inode of the handle read; otherwise it is `null`.
- **One file under two names is refused**, by device and inode.
- **The record's `scope` claims what the record can support.** It says custody read none of the
  files. It does not describe the CLI: a library caller writes the same record. The first round's
  scope sentence described the CLI's behaviour inside every record, including records the CLI did
  not write. A `statedBy` field stays rejected, since any caller could set it.
- **Additive fields.** `configuration`, `invocation.directory` and `start.seededJournal` are
  additive, so `custodyVersion` stays 1. The guards accept each as absent.

### Reading

- **The reader is in `custody.ts`.** Elsewhere, `outcome` and `custody` would import each other's
  values.
- **Typed records through compile-checked guards** (`shape<T>` over `Required<T>`). Signal names
  are checked against the whole `NodeJS.Signals` union, kept as a list with a compile-time
  exhaustiveness check. The first round checked them against the reading host's
  `os.constants.signals`, so a Linux `SIGPWR` read on macOS made the completion `unreadable`.
- **State.**
  - **Precedence.** Directory not listable → `unreadable`. Then records that disagree → `unknown`:
    session, journal path, seed session or home. Then the completion decides.
  - **`custody-error`** takes precedence over the outcome.
  - **An end with no invocation, or no start, is `unknown`.** The first round read start plus
    completion with no invocation as `exited`, while it read a start with no invocation as
    `unknown`.
  - **Liveness** is never probed.
- **Stdout is read as a result only when that is honest** (`CustodyStdoutResult`):
  - `json-requested` when the invocation asked for JSON, whatever the bytes;
  - `parsed-as-result` when the bytes are a result anyway, as a launcher adding the flag would
    make them;
  - otherwise `not-read` with why, and always `not-read` for a run that never started.
  - The first round read every stdout as JSON, so a default text run read as "possibly cut short"
    and an empty not-started stdout as "nothing but whitespace was written".
  - **Not changed:** `--outcome-batch {"result": FILE}` still reads that file as a result, because
    the caller asked. The reception cited its test as locking in the misreading. The defect was in
    the automatic reading, which is repaired; the explicit request keeps its contract.
- **Session binding.** A stdout result whose `session_id` is not the start's, and appended journal
  records naming only other sessions, are each one problem line. The state stays as the records
  give it: stdout and the journal are not custody records. A completion journal path that differs
  from the start's is a record disagreement, so the state is `unknown`.
- **Seeded-journal boundary.**
  - **The boundary.** `spawnClaude` returns `seededJournal`, the size and SHA-256 of the bytes it
    wrote or cloned before the spawn, CLI preloads included. Custody records it in `start.json`.
    The clone path reports the source's size, which its identity checks hold unchanged throughout,
    and the digest the clone was verified against.
  - **`journal.appended`.** It reads only the bytes after the boundary, and only while the
    journal's prefix still has the recorded digest. `lineOffset` maps its line numbers back.
  - **Starts written before the boundary existed.** For a fresh invocation the boundary is 0; for
    a continued session it is unknown, and is said so.
  - **Not adopted from the reception: a deferral fallback.** The reception allowed one in place of
    the boundary, and this round implements the boundary instead. The whole-journal `reading` stays
    for whoever needs it.
  - **The join, third round.** The second round still joined over the whole journal. Its own
    reasoning was that segment indices are the join's vocabulary. That was wrong: an earlier
    process that wrote no `cost-state` record shares this run's segment, so a joined result
    named that process's context-limit record as its segment's. The join is now over the
    appended reading whenever the boundary is verified, and `join.over` says which reading
    `segment` indexes. Over the whole journal it runs only without a verified boundary, and the
    old caveat applies there. The regression joins a matching result over a seed ending in a
    context-limit record that has a uuid and no `cost-state`. Over the appended reading it joins
    with no context-limit record; over the whole journal, the same result names the inherited one.
- **Moved or copied directories.** `invocation.directory`, or for older records the directory of the
  completion's outputs, says where the records were written. When that is not, physically, the
  directory read:
  - one problem line says so;
  - outputs are compared against the paths recorded under the original;
  - a journal under the original directory is not read, since reading it would read the original's
    journal as this copy's.
  - Mapping those paths into the copy is not attempted. When nothing says where the records were
    written, the journal is read where named, and a problem line says so.

### The observation

- **On by default, with no new key.** It reads only records the caller already chose to keep.
- **The CLI's `observed` line is compact:** format, version, state, basis and problems. The whole
  reading holds the invocation's `extraArgs`. It stays in `observation.json`, mode 0600, and in the
  library's `onEvent`. 0.12.0's stream carried no `extraArgs`, and the first round put them on
  stdout.
- **Failures** are the event's `error` and a stderr line. They change neither the completion, nor
  the resolved value, nor the exit status.

## Where earlier work was wrong

- **The first round's public note named private paths and context.** This note replaces it.
- **The first round's text and not-started stdout readings**, its signal guard, its state
  asymmetry, its silent reading of a relocated directory's original journal, and its stdout
  `extraArgs`, as above.
- **Its CHANGELOG** did not say that `observed` breaks exhaustive switches over `CustodyEvent`, or
  that `runInCustody` now resolves after a whole-directory read.

## Not established

- **Third round:** typecheck and every test. The regression appends this run's measured call
  and `cost-state` record by hand after the run, since the fake writes neither.
- **Still unseen:** a join over the appended reading of a real continued `claude` run.
- **A whole-journal join for a continued 0.12.0 directory** may still name an inherited error.
  It is labelled `over: 'whole'` and is not repaired, because nothing records the boundary there.
- **Unprobed outcomes:**
  - `realPath` coming out `null`: no test races a symlink swap.
- **Known exposures left open:**
  - The reading is not atomic.
  - `observation.json` can be left partial by a signal after the supervisor's handlers are gone,
    and that window now includes a whole-journal read; a signal there ends the CLI with 128+n.
  - A very large stdout or journal is read whole into memory.
- **Untested environments:** Linux, the real `claude`, any managed launcher.
- **Untested writer path:** the boundary has not been seen with a writer that rewrites the
  journal's prefix. That reads as `not-read`, by design.

## What this is not

It observes runs in custody only. It is not native attribution, it is not a receipt, and it makes
no adequacy claim.
