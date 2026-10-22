## Code Review

**Verdict**: APPROVE
**Confidence**: HIGH for wrapper behavior; native enrolled-account/refresh behavior remains unqualified.

### Summary

Implementation-root review of PR3, original head3e8f146 and the subsequent repairs.
No independent reviewer is claimed. No P0/P1 finding remains in the reviewed wrapper
scope; the changes do not establish the remaining live-account requirements of issue1.

### Findings

| Priority | Issue | Location |
| --- | --- | --- |
| P1, repaired | Native credential conflicts made doctor throw instead of returning a refused-invocation report. Reproduced with a synthetic OAuth environment value. | src/doctor.ts, runDoctor |
| P1, repaired | Explicit run/store directories could overlap, letting run settings be written under the selected store. Normalized explicit paths must now be disjoint. This is not symlink confinement. | src/index.ts, LaunchConfig |

### Details

The doctor catches buildEnv refusals, reports preset failure/auth-not-checked and
uses only its PATH for the version probe. It does not inspect a fallback credential
for a refused environment. The regression confirms a returned report and no echoed
synthetic credential value. Explicit directory overlap is refused before spawn or
filesystem work. Separate run/store paths retain the previous route.

Remote CI39806021606 failed the existing temporary-home SIGHUP test after521passes:
the fake's PID file is written before its initial journal. The test could send
SIGHUP in that interval, then demand a journal that had never been created. It also
observed stderr asynchronously. The fixture now emits a readiness file after its
initial records, and the test waits for it before SIGHUP and for the final journal
announcement before parsing it. No CLI stop/runtime behavior changed.

Final typecheck and local suite pass:524tests,1skip,0fail,2043assertions,51.65s.
The original native2.1.306 unenrolled-store probe remains the native qualification;
no account selection, credential reads/copies or new model work was performed in
this review. Named regression repairs justify these reruns; repetition alone would
not establish a defect or removability.

### Recommendation

Integrate the corrected API/CLI contract after the actual CI result is examined.
Keep issue1 open for enrolled-account separation, expiry/refresh writeback and
concurrent refresh. Those are not claims this path-selection increment makes.
