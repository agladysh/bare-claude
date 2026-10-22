# 22 October 2026: explicit native credential store

Base145c5de, ETF delegated queue work for upstream issue1. This adds path selection,
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

22 October, macOS, native Claude Code2.1.306, installed maintained BCC launcher.
A fresh HOME initially caused launcher exit1 before native execution because its
default native binary is HOME/.local/bin/claude. That first attempt had no version,
no auth JSON and152stderr bytes: it was not native missing-login evidence.
Pinning the actual native binary through BCC_CLAUDE_NATIVE corrected the executable
lookup. BCC_CLAUDE_NO_CREDENTIAL=1 selects the launcher's documented caller-owned
route; no account was allocated. The version was2.1.306; native auth status returned
loggedIn:false/exit1/336stdout bytes/0stderr. The actual new spawnClaude route then
returned Not logged in/exit1/35stdout bytes/0stderr. No enrolled store was used,
no credential values were read by the probe, and no successful model turn occurred.

Re-run from repository root with Bun after checking the explicit installed launcher
and native binary paths below. All auth state is fresh temporary output, removed
by this probe only. The quoted paths identify the measured installation, not a
portable default. Do not substitute an existing enrolled store into this probe.

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEnv, LaunchConfig, spawnClaude } from './src/index.ts';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-native-auth-status-'));
try {
  const store = path.join(root, 'unenrolled');
  const configDir = path.join(root, 'run');
  await fs.mkdir(configDir);
  const env = buildEnv(LaunchConfig({callToAction:'# unused', auth:'native-store',
    nativeStorePath:store, noProcessEnv:true, extraEnv:{HOME:root,
      USER:process.env.USER ?? 'agladysh', PATH:'/usr/bin:/bin:/opt/homebrew/bin',
      BCC_CLAUDE_NO_CREDENTIAL:'1', BCC_CLAUDE_NATIVE:'/Users/agladysh/.local/bin/claude'}}), {ephemeralClaudeHomePath:configDir});
  const executable='/Users/agladysh/confidential-2/bcc/.bin/claude';
  const version=Bun.spawn([executable,'--version'],{env,stdout:'pipe',stderr:'pipe'});
  const versionText=await new Response(version.stdout).text(); await version.exited;
  const child=Bun.spawn([executable,'auth','status'], {env,stdout:'pipe',stderr:'pipe'});
  const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  let loggedIn: boolean | null = null;
  try { const value:unknown=JSON.parse(out); if(typeof value==='object' && value!==null && 'loggedIn' in value && typeof value.loggedIn==='boolean') loggedIn=value.loggedIn; } catch {}
  let headlessResult: {exit:number,notLoggedIn:boolean,stdoutBytes:number,stderrBytes:number} | null = null;
  if (exit === 1 && loggedIn === false) {
    const run=await spawnClaude({callToAction:'# authentication probe',auth:'native-store',
      nativeStorePath:store,noProcessEnv:true,claudePath:executable,tools:[],
      extraEnv:{HOME:root,USER:process.env.USER ?? 'agladysh',PATH:'/usr/bin:/bin:/opt/homebrew/bin',
        BCC_CLAUDE_NO_CREDENTIAL:'1',BCC_CLAUDE_NATIVE:'/Users/agladysh/.local/bin/claude'}},
      {stdout:'pipe',stderr:'pipe'});
    try {
      const [code,stdout,stderr]=await Promise.all([run.subprocess.exited,
        new Response(run.subprocess.stdout).text(),new Response(run.subprocess.stderr).text()]);
      headlessResult={exit:code,notLoggedIn:(stdout+stderr).includes('Not logged in'),
        stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr)};
    } finally {await run.dispose();}
  }
  console.log(JSON.stringify({version:versionText.trim(),command:'managed claude auth status',exit,loggedIn,
    stdoutBytes:Buffer.byteLength(out),stderrBytes:Buffer.byteLength(err),enrolledStore:false,headlessResult,
    route:'explicit caller-owned auth via BCC_CLAUDE_NO_CREDENTIAL=1; auth status then logged-out print'}));
} finally { await fs.rm(root,{recursive:true,force:true}); }
```

## Open

Issue1's two enrolled stores, account separation, expiry/refresh writeback and
concurrent native refresh are not established here. The issue's reported2.1.273
success is external evidence; this work does not relabel it as our measurement.
The old2.1.220 token observation was not an exhaustive macOS authentication result.
Native mode does not cause an estate launcher to honor store selection by itself:
the BCC launcher requires its documented explicit caller-owned-auth declaration.
That routing belongs to the caller/launcher, not this public library.

After documentation/help refinement, the CLI invocation file passed24tests and
113assertions. The final fixture keeps its explicit CLI home under its own temporary
root (CLI failures retain homes by contract); its six affected cases were rerun,
80assertions, no failures. Final typecheck passed. The full suite was not rerun for
that fixture-path change or documentation text.
