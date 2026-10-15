/**
 * Shared plumbing for the black-box tests in this directory.
 *
 * Every test here runs the real `bin/bare-claude.ts` as a subprocess — never
 * imported, never mocked — and asserts on what it wrote to disk or to its own
 * stdout/stderr/exit code. That is what makes these tests catch the bugs unit
 * tests structurally cannot: a wrong exit code, a hang, output routed to the
 * wrong stream.
 */
import { constants, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Which way a copy-on-write session seed goes on this host's temporary
 * directory: `clone` when a forced clone of a small file succeeds there, else
 * `refusal`. Every temporary directory the tests create is under
 * `os.tmpdir()`, so this is the branch every seed test on this host takes.
 *
 * Decided by a probe, not by the platform: macOS does not imply APFS, and
 * Linux implies no particular filesystem. A forced clone in Bun 1.3.13 either
 * clones or fails — `clonefile()` on macOS, `ioctl_ficlone` on Linux, with no
 * byte-copy fallback in either branch of `copyFileInner` — so a probe that
 * succeeds is a clone. Tests name the branch in their titles, so a test log
 * records which one ran. Set `BARE_CLAUDE_REQUIRE_CLONE=1` on a host known to
 * clone, and the seed tests fail instead of taking the refusal branch.
 */
export const cloneBranch: 'clone' | 'refusal' = (() => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return 'refusal';
  }
  const probe = mkdtempSync(path.join(os.tmpdir(), 'bare-claude-clone-probe-'));
  try {
    writeFileSync(path.join(probe, 'a'), 'probe');
    copyFileSync(path.join(probe, 'a'), path.join(probe, 'b'), constants.COPYFILE_FICLONE_FORCE);
    return 'clone';
  } catch {
    return 'refusal';
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/** Whether this run must take the clone branch, by `BARE_CLAUDE_REQUIRE_CLONE=1`. */
export const cloneRequired = process.env.BARE_CLAUDE_REQUIRE_CLONE === '1';

/**
 * Whether process `pid` no longer exists, probed with signal 0. A zombie
 * still exists; callers poll until its parent reaps it.
 */
export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

/** Polls `condition` every 25 ms until it holds or `ms` pass; returns whether it held. */
export async function eventually(condition: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await Bun.sleep(25);
  }
  return condition();
}

/** Absolute path to the CLI entry point under test. */
export const cliPath = path.join(import.meta.dir, '..', 'bin', 'bare-claude.ts');

/** Absolute path to the directory holding the fake `claude` binary. */
export const fakeClaudeDir = path.join(import.meta.dir, 'fake-claude');

/** What a completed CLI run produced. */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Creates a fresh, empty Git working copy in a new temp directory.
 *
 * `bin/bare-claude.ts` requires one (`git rev-parse --show-toplevel` in
 * `loadConfig()`), and a dedicated one keeps a test from ever loading this
 * project's own `bare-claude.yaml` — which points at a real `lmstudio`
 * preset and would otherwise leak into every run under test.
 * @returns The new working copy's path.
 */
export async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-test-repo-'));
  for (const args of [
    [ 'init', '-q' ],
    [ 'config', 'user.email', 'test@example.com' ],
    [ 'config', 'user.name', 'Test' ],
  ]) {
    const init = Bun.spawn({ cmd: [ 'git', ...args ], cwd: dir, stdout: 'ignore', stderr: 'ignore' });
    await init.exited;
  }
  return dir;
}

/** `process.env` with every `undefined` value dropped, since `Bun.spawn` wants strings only. */
function definedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ key, value ] of Object.entries(process.env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Runs `bin/bare-claude.ts` as a real subprocess, the way a user would invoke
 * it — no imports, no reached-into internals.
 * @param args - CLI arguments, e.g. `[ '--quiet', 'hello' ]`.
 * @param options.cwd - Working directory for the run; see {@link makeTempRepo}.
 * @param options.env - Extra environment variables layered over the current
 *   process environment. `BARE_CLAUDE_TOKEN_FILE` defaults to a file that
 *   does not exist, so no test ever reads the operator's real token file.
 *   `PATH` is always rewritten so `fakeClaudeDir` comes
 *   first — ahead of `options.env.PATH` when one is given, of the ambient
 *   `PATH` otherwise — which is what makes the subprocess's own `claude`
 *   invocation resolve to the fake binary instead of the real one.
 * @param options.stdin - Text piped to the CLI's stdin. Omit to leave stdin
 *   closed, so a run with a positional call to action never blocks waiting
 *   for one that will not come.
 */
export async function runCli(
  args: string[],
  options: { cwd: string; env?: Record<string, string>; stdin?: string }
): Promise<CliResult> {
  const env: Record<string, string> = {
    ...definedEnv(),
    // Never the operator's real token file: unless a test names one, the
    // CLI under test looks for a file that does not exist. A test that
    // wants the default location sets this to '' (unset) and its own HOME.
    BARE_CLAUDE_TOKEN_FILE: path.join(options.cwd, 'no-token-file'),
    ...options.env,
    PATH: `${fakeClaudeDir}:${options.env?.PATH ?? process.env.PATH ?? ''}`,
  };

  // Always a pipe, closed immediately when the caller has nothing to write:
  // a concrete "pipe" literal (rather than a stdin/ignore union) is what
  // keeps `subprocess.stdin` typed as a plain FileSink below, and the CLI
  // never reads stdin at all when a positional call to action was given.
  const subprocess = Bun.spawn({
    cmd: [ 'bun', cliPath, ...args ],
    cwd: options.cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (options.stdin !== undefined) {
    subprocess.stdin.write(options.stdin);
  }
  await subprocess.stdin.end();

  const [ stdout, stderr, exitCode ] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { exitCode, stdout, stderr };
}
