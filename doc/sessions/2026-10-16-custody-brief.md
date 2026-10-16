# 2026-10-16 — custody briefs

Base: `ba49af8` (v0.13.0). The implementation is `883dec0` and `df86b6f`, written by Claude (AI),
and `17425f2`, a bounded wording correction written by Codex (AI). It is prepared as 0.14.0: the
package version, README and CHANGELOG say 0.14.0, but no `v0.14.0` tag has been cut and nothing
has been published.

The documentation is model work: Opus 5.5 wrote the README section, the CHANGELOG entry, the
version and this report, and a separate copy pass then checked them against the code and
corrected them. Both used file tools only. Neither ran a shell, the tests or a nested or native
inference probe; the maintainer ran every check below.

Sources: the source, CLI and tests; an independent final reception of `df86b6f`, which is
private; and the maintainer's check logs.

## Checks

- **Earlier source.** The full suite, 513 pass and the existing skip; then, at `df86b6f`,
  typecheck, the custody module's 44 tests, a comparison showing output without `--brief`
  unchanged from 0.13.0, and the readback below.
- **After the `17425f2` wording edits**, before committing them: typecheck, and
  `src/custody.test.ts`, 44 pass, 305 assertions, 8.44 s. The 44 are its 42 `test` declarations
  and the two cases of the `test.each` at line 298.
- **On `17425f2` with the 0.14.0 package**: `bun run check`, typecheck and the full suite, 515
  pass, the existing conditional clone skip, 0 fail, 1940 assertions across 24 files, 57.33 s.
  Only the copy pass's prose edits to the README, CHANGELOG and this report came after it; they
  change no code and no version.

## Readback

- **Directories.** At `df86b6f`, the maintainer read three real custody directories, kept by
  managed-launcher runs, with `bare-claude --outcome-batch FILE --brief`. Their journals record
  native Claude Code 2.1.292.
- **Lineage.** The digest link between the two runs of a continued chain matched the records the
  reception had checked.
- **`contextWindow`.** It was `null` on both runs of that chain: their results name an Opus and a
  Haiku model, which report different windows. A run written by 0.12.0 whose result named only an
  Opus model reported one window.
- **No new native run.** None was made under 0.14.0. A brief is a pure projection of records
  already written, so verifying it needs none.

## Decisions

- **Built on the typed reading.** The brief is built on the typed 0.13.0 reading and does no
  parsing of its own. It copies fields by name, so nothing attached to a reading beyond its type
  passes through. The leak test checks this.
- **Leaving out named fields is not redaction.** The brief leaves out named payload fields and
  states plainly that this is not redaction. Native strings pass only as one word of printable
  characters. That rule keeps sentences out; it does not keep secrets out.
- **Lineage by seeded digest alone.** Linking by session id was rejected. A session can be
  continued from any of its journals, or from bytes no custody kept, and a run's own successors
  share its id. Same-session runs appear only as the `sameSession` hint.
- **A required digest counts only where a start shows the spawn.** It stands for the seeded bytes
  only where a start shows that the spawn happened, as with a 0.12.0 start that has no
  `seededJournal`. Without a readable start, the end status is `unknown`.
- **`contextWindow` is `null` when the windows differ.** Picking the main model's window was
  rejected, because the result does not say which model made the last call. A possible later
  addition is to carry the result's per-model `{model, contextWindow}` pairs, which the reading
  already holds, without claiming which model made the last call. The reception judged that it was
  not a reason to hold 0.14.0.
- **`inheritedTotals` is not subtracted from `session`.** Whether Claude Code resumes its totals
  from the seeded `cost-state` record is not established.
- **Directory spelling.** A batch reads at physical paths. The single-directory mode names the
  path as given, made absolute.
- **`--brief` outside its two modes is refused**, not ignored.

## Where earlier source, and the reception, were wrong

- **Before `df86b6f`:**
  - The cost label said "list-price".
  - A run with no readable start could be linked through the digest its invocation required.
  - A `mismatch` status named same-session runs, as though that were evidence.
  - Batches did not key directories by physical path.
  - `--brief` was silently ignored beside other modes.
  - The leak test did not show that a one-word native value still passes.

  An independent reception found these, and `df86b6f` repaired them.
- **`df86b6f`:**
  - The cost constant said "estimate", which no source supports. `17425f2` changed it to
    "figure".
  - The `ambiguous` TSDoc presented a copy as the only cause. `17425f2` rewords the copy as one
    example; identical journals from distinct runs that appended nothing are another.
  - The `source-differs` TSDoc implied that both digests are compared. For a copied candidate
    whose journal is not read, only the completion digest is. `17425f2` rewords it.
- **The final reception** said a single `--outcome-custody --brief` is always `not-sought`. The
  code decides `fresh`, `unknown`, `no-digest` and `conflict` from the run's own records before it
  seeks anything. `not-sought` applies only to a run with a digest to seek, and the README states
  that narrower form.

## Not established

- Whether Claude Code resumes session totals from the last `cost-state` record in the seeded bytes.
- A brief of a real run that hit a context limit or compacted. None of the three directories did.
- A brief of directories written on Linux.
- Adoption. No consumer uses a brief yet. The reception proposes a downstream reception tool that
  would brief a returned run together with its continuation sources and record the result as
  exposure, not receipt; nothing implements it.
- Causes. A brief reports figures and lineage; it does not diagnose why an upstream run ended
  where it did, and that diagnosis is still owed.
