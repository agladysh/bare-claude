/**
 * Shared plumbing for the black-box tests in this directory.
 *
 * Every test here runs the real `bin/bare-claude.ts` as a subprocess — never
 * imported, never mocked — and asserts on what it wrote to disk or to its own
 * stdout/stderr/exit code. That is what makes these tests catch the bugs unit
 * tests structurally cannot: a wrong exit code, a hang, output routed to the
 * wrong stream.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
 *   process environment. `PATH` is always rewritten so `fakeClaudeDir` comes
 *   first, which is what makes the subprocess's own `claude` invocation
 *   resolve to the fake binary instead of the real one.
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
    ...options.env,
    PATH: `${fakeClaudeDir}:${process.env.PATH ?? ''}`,
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
