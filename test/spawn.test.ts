/**
 * Black-box tests of `bin/bare-claude.ts`'s real spawn path, driven end to
 * end as a subprocess against a fake `claude` — never the real binary, never
 * a model, never the network.
 *
 * The fake lives at `test/fake-claude/claude` and is put first on `PATH` by
 * `runCli` (see `test/helpers.ts`): `Bun.spawn` resolves the literal
 * `'claude'` in `buildArgv`'s command vector against the `PATH` in the env it
 * is given, so the CLI's own `spawnClaude()` call is exercised unmodified —
 * only what answers on the other end changes. `--claude-path` did not exist
 * in `bun bin/bare-claude.ts --help` as of this writing (another agent was
 * adding it concurrently); if it lands, the `PATH` shim keeps working exactly
 * the same, since `buildArgv` still emits the bare command name.
 *
 * Each run gets its own temporary Git working copy (`makeTempRepo`) so it
 * never loads this repository's own `bare-claude.yaml`, which points at a
 * real `lmstudio` preset that has nothing to do with these tests.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';

import { makeTempRepo, runCli } from './helpers.ts';

const tempRepos: string[] = [];

async function repo(): Promise<string> {
  const dir = await makeTempRepo();
  tempRepos.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRepos.length > 0) {
    const dir = tempRepos.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('exit code propagation', () => {
  test('exits with the subprocess exit code, not 0', async () => {
    // Regression: this was unconditionally 0, so every failed run reported success.
    const result = await runCli([ '--quiet', 'hello' ], {
      cwd: await repo(),
      env: { FAKE_CLAUDE_EXIT_CODE: '7' },
    });

    expect(result.exitCode).toBe(7);
  });

  test('still exits 0 when the subprocess succeeds', async () => {
    const result = await runCli([ '--quiet', 'hello' ], { cwd: await repo() });

    expect(result.exitCode).toBe(0);
  });
});

describe('failure diagnostics', () => {
  test('echoes the failed subprocess\'s own output to stderr', async () => {
    // This is where Claude Code reports conditions like "Not logged in" —
    // discarding it left a failed run with no diagnostic at all.
    const result = await runCli([ '--quiet', 'hello' ], {
      cwd: await repo(),
      env: {
        FAKE_CLAUDE_EXIT_CODE: '1',
        FAKE_CLAUDE_STDOUT: 'Not logged in · Please run /login\n',
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Not logged in');
  });

  test('does not echo anything on stdout to stderr when the run succeeds', async () => {
    const result = await runCli([ '--quiet', 'hello' ], {
      cwd: await repo(),
      env: { FAKE_CLAUDE_STDOUT: 'irrelevant chatter\n' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('irrelevant chatter');
  });
});

describe('a subprocess that exits without ever creating a session file', () => {
  // There was a real hang here: renderTranscript watched a session file that
  // would never appear. A regression here must fail this test, not wedge
  // `bun test` forever, hence the explicit timeout below.
  test('the CLI still exits promptly instead of hanging', async () => {
    const startedAt = Date.now();

    const result = await runCli([ 'hello' ], {
      cwd: await repo(),
      env: { FAKE_CLAUDE_WRITE_SESSION: '0', FAKE_CLAUDE_EXIT_CODE: '1' },
    });

    expect(result.exitCode).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);
});

describe('--quiet and --print', () => {
  test('--quiet suppresses the transcript', async () => {
    const result = await runCli([ '--quiet', 'hello' ], { cwd: await repo() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('--print passes the subprocess\'s own stdout through', async () => {
    // README: use --print with --quiet for "the last assistant message only" —
    // without --quiet the transcript renderer writes to the same stdout the
    // inherited child stdout is landing on, and the two would interleave.
    const result = await runCli([ '--quiet', '--print', 'hello' ], {
      cwd: await repo(),
      env: { FAKE_CLAUDE_STDOUT: 'the assistant\'s actual reply' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('the assistant\'s actual reply');
  });
});

describe('an unsafe call to action', () => {
  test('a leading "-" is refused before anything is spawned', async () => {
    // The call to action reaches assertSafeCallToAction unparsed only via
    // stdin: Bun itself strips a literal "--" from argv before the CLI's own
    // parseArgs ever sees it, so a *positional* "-oops" is instead rejected
    // earlier still, by node:util's own flag parser, with a different
    // message. Piping it in is what actually exercises the documented,
    // measured guard (CLAUDE.md: "a call-to-action beginning with '-'").
    const result = await runCli([], { cwd: await repo(), stdin: '-oops' });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('would parse it as a flag');
  });
});
