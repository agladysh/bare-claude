# 22 October 2026: explicit native credential store

Base145c5de, upstream issue1. This adds path selection,
not credential custody. The existing caller mode was inspected: it could express
native paths manually, but had no first-class selection/conflict contract. Fork
UPSTREAM notes in okno and flywheel retained the older token measurement, not a
native-store implementation. No fork code was imported.

## Contract and bounds

`auth: native-store` requires an absolute nativeStorePath, disables credential
links/token-file fallback, and sets Claude Code's secure-store/profile paths while
keeping ephemeral run config and existing bare controls. Explicit selection wins
over other environment path variables. Credential variables/FD routes conflict;
auth variables in settings.env and apiKeyHelper are refused. No store file/layout
preflight was added: native owns its login, failure and refresh. Caller/default
routes remain supported. No platform-specific silent fallback was introduced.

Doctor reports selection as a warning, not authenticated. The custody reader
accepts the new auth enum value; it does not begin recording credential material.
No release, installed dependency or consumer binding is changed by this candidate.

Typecheck passed; full suite522pass/1skip/0fail,2030assertions,40.87s. Six added
cases cover option/settings/environment conflicts, preset parsing, ephemeral versus
store paths, skipped empty token-file fallback, no copied/linked credential names,
missing layout acceptance, synthetic exit7 through SDK and CLI, and bounded doctor.
The fixtures establish wrapper behavior, not native refresh or login.

## Native empty-store probe

22 October, macOS, native Claude Code2.1.306, through a caller-owned launcher.
  A fresh HOME first caused launcher failure before native execution because its
  native executable lookup depended on HOME. That attempt had no version or auth
  JSON and was not missing-login evidence. Explicit native executable selection
  and the launcher's caller-owned authentication route corrected the probe.
  
  With a fresh temporary, unenrolled credential store, native auth status reported
  loggedIn:false, exit1, 336 stdout bytes and no stderr. The new spawnClaude route
  returned Not logged in, exit1, 35 stdout bytes and no stderr. No enrolled store was
  used, no credential values were read by the probe, and no successful model turn
  occurred. Client-specific launcher configuration is intentionally omitted.
  
  To repeat the library-level check, supply the absolute path to the intended
  native Claude executable as claudePath, an empty temporary nativeStorePath,
  auth:'native-store', noProcessEnv:true, tools:[], and an explicit minimal child
  environment. Keep HOME temporary and separate from both store and run directories.
  Check native --version and auth status before the SDK run. Record exit codes and
  loggedIn without recording credentials. A wrapper executable additionally needs
  its own documented caller-owned authentication selection; do not assume its
  account routing follows nativeStorePath. This generic procedure is not a claim
  that a different launcher was tested.
  
  ## Open

Issue1's two enrolled stores, account separation, expiry/refresh writeback and
concurrent native refresh are not established here. The issue's reported2.1.273
success is external evidence; this work does not relabel it as our measurement.
The old2.1.220 token observation was not an exhaustive macOS authentication result.
Native mode does not make a caller-owned launcher honor store selection by itself.
Launcher authentication routing belongs to the caller, not this public library.

After documentation/help refinement, the CLI invocation file passed24tests and
113assertions. The final fixture keeps its explicit CLI home under its own temporary
root (CLI failures retain homes by contract); its six affected cases were rerun,
80assertions, no failures. Final typecheck passed. The full suite was not rerun for
that fixture-path change or documentation text.
