# 2026-10-16 — configuration provenance, custody reading, observation at the end

Base: published `4175f7f` (v0.12.0). Written by Opus 5.5 with Read/Grep/Glob/Edit/Write only:
no shell, no `bun`, no `tsc`, no `claude`, no model. **Nothing here has been typechecked or run.**
The tests are written to discriminate, and whether they pass is root's first check. `package.json`
stays 0.12.0. The entry is under `[Unreleased]` as a 0.13.0 candidate.

The initiating consumer supplied a private receiving design and independent
  reception. Their confidential locations and client identifiers are omitted.
  The scope was configuration reading, completed-run custody and automatic
  observation; directoryVariable and a separate observer were excluded.
  
  ## Decisions

- **(a) Read once, by construction.** `readOnce` opens the file, `fstat`s the handle, reads it
  whole through that handle, digests the bytes and parses the same bytes. The old route
  (`Bun.file().exists()`, then `.text()`) was two operations. `realPath` is resolved after the
  read, by a separate call. What identifies the file is the device and inode of the handle that
  was read. A non-regular file is refused.
- **One file under two names is refused.** Duplicates are found by device and inode. The old
  check was by `path.resolve` only, so two names for one root-only file composed twice and
  repeated its arrays.
- **What the caller stated, and what was observed.** `invocation.json` records `configuration`
  with a `scope` saying that the caller stated it and custody read none of it. Under the CLI, the
  caller is the configuration reader, which states the bytes it read. A `statedBy` field was
  rejected: a library caller could give any value for it, so it would claim more than the scope
  sentence does. The record is copied field by field, so an untyped caller's extra fields (file
  contents, for example) stay out; a test covers this. Nothing re-hashes a configuration file
  after the run, and no Git blob is compared.
- **`custodyVersion` stays 1.** `configuration` is additive and optional in the type. Absent means
  the record was written by 0.12.0; `null` means no configuration was stated.
- **(c) The reader is in `custody.ts`.** If it were in `outcome.ts`, or in a new module that
  `custody.ts` imports, `outcome` and `custody` would import each other's values.
  `outcome.ts` gains only the `CustodyRequest` type. The batch reader is unchanged, and the CLI
  sends custody lines to `readCustody`, with one reading per distinct directory.
- **Typed records through compile-checked guards.** `shape<T>` takes one guard per property of
  `T`, over `Required<T>`. Mapping with `-?` instead would remove `undefined` from optional
  properties. A field added to a record type fails to compile until it has a guard. A record is
  `read` only when its format, its version and every field pass. `scope` is compared exactly, so
  its text is part of version 1.
- **State precedence:** directory not listable → `unreadable`; records that disagree (start and
  completion on different sessions, a home or seed mismatch) → `unknown`. Otherwise the
  completion decides. Its `custodyError`, or a stop whose cause is `custody-error`, gives
  `custody-error` whatever the start says: the reception's custody-error case leaves an empty,
  unreadable `start.json`. An unreadable record makes the state `unreadable` only when the state
  rests on that record. Every unreadable record appears in `problems`. The design's `not-custody`
  is folded into `unknown`.
- **No liveness probe.** `start-only` stays `start-only` while the group is running and after it
  has emptied; the CLI SIGKILL test reads it both ways.
- **No native label.** `stdout.writtenBy` is the invocation's launcher and executable, and
  `provenance` is a fixed sentence. A test runs a launcher named `claude` that prints a
  native-looking result: the reading has no key matching `/native/i` and has the same stdout keys
  as a fake run. `outputFormat` is what `extraArgs` asked for, not what was written.
- **No `signals` list.** The outcome reader's facts pass through as they are: `contextLimit`,
  `status`, `terminalReason`, `stopReason`, the journal's API errors and compactions, and the
  join's `contextLimitRecord` with its existing caveat. Choosing which of these count as signals
  would mean setting a threshold, which the commission excludes. `result.process` keeps
  `processScope` whatever the join says.
- **Changes since the completion are reported as facts.** `changedSinceCompletion` covers stdout,
  stderr and the journal, a removed or newly created journal included. `null` means there was
  nothing to compare or the read failed. No key offers a continuation; a test checks for
  `/continu|seed|resum/i`.
- **Observation is on by default, with no new key.** It reads only the records the caller already
  chose to keep by opting into custody, and a profile valid under 0.12 needs nothing new. An opt-in
  key would have been one more field to forget on each run, which is the copied-recipe failure of
  turns 9030 and 9163. It runs through the existing `runInCustody` and CLI: `conclude()` runs after
  every completion, `not-started` included, and emits `observed` after `completed`.
  - **Failures.** A read or write that fails is the event's `error` and a stderr line. The
    completion, the value `runInCustody` resolves with, and the CLI exit status are untouched.
    That is tested in the library (a callback puts a file where the observation goes) and in the
    CLI (the fake writes it), with exit 0 kept.
- **Pre-custody refusals.** These are unchanged. A test now asserts empty stdout for a used
  directory, and the README says that an event stream with no `started` or `completed` line says
  nothing about status or cause.

## Where the sources were wrong, or were departed from

- **Design `:162`** ("otherwise labelled as session-scoped") would relabel process figures. The
  reception's correction was followed: process figures stay process-scoped and the join is
  correlation only.
- **Design `:138-139`**, a refusal record built from stdin, cannot be built. The reception was
  right, and nothing here pretends otherwise.
- **The commission's state list** names `custody-error` beside `exited` and `stopped`.
  `custody-error` takes precedence, and the completion's own `outcome` stays readable in
  `completion.record`.
- **"Low cost" is not quite true.** The observation reads stdout and the journal whole, in memory,
  at the end of every run. No bound was added, because none is measured. A very large journal
  costs time and memory there.

## Not established

- Typecheck and every test. Two points of TypeScript 7 behaviour carry particular risk: the
  generic `shape` indexing `fields[key]`, and the `const` type parameter on `literal`.
- Whether `os.constants.signals` names every `signalCode` Bun records on a given platform. One it
  does not name makes the completion `unreadable`.
- **BOM handling changed in `TextDecoder` decoding.** It now strips a byte-order mark; whether
  `Bun.file().text()` did was not checked. A YAML file with a BOM may parse differently from
  before, though its recorded digest covers the raw bytes either way.
- **The reading is not atomic.** Records are read one after another, so a run that completes
  mid-reading can read as `start-only`.
- **`observation.json` can be left partial.** It is written `wx` after the supervisor's handlers
  are gone, so a signal then can leave the file partial. `completion.json` has the same exposure
  today.
- **The `observed` line can be large**, since it carries the full journal reading on one stdout
  line.
- Linux, the real `claude`, any managed launcher; the doctor over composed files (unchanged).

## What this is not

- **Not a receipt.** Root still has to receive the observation and act on it.
- **Not native attribution.** Native-versus-launcher endings remain the private attempt
  interface's domain.
- **Not a repair of the larger regime.** It observes managed Claude runs in custody only: not root
  Codex sessions, not sibling bureaus' traces, and not the upstream working-regime learning that
  turn 20653 asks for. It makes no adequacy claim.
