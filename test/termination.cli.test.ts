/**
 * Black-box tests of how the real CLI ends a run it was asked to stop:
 * SIGTERM, SIGINT or SIGHUP to `bare-claude` itself, as a runner or a
 * terminal sends them.
 *
 * The chain under test is the one a managed launcher makes: the CLI spawns a
 * launcher (`--claude-path`), and the launcher starts the fake `claude` as a
 * child of its own. The launcher here is a few lines of `sh`, written per
 * test, in two shapes: one that forwards SIGTERM to its child and waits for
 * it, and one that exits at once and abandons it. How the real managed
 * launcher behaves is not modelled beyond that; it is for a run against the
 * real launcher to show.
 *
 * Every assertion is about processes these tests started: their PIDs come
 * from files the fakes write, are checked with signal 0, and are signalled
 * only by `afterEach`, only while still alive, if a test failed before the
 * CLI stopped them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cliPath, eventually, fakeClaudeDir, makeTempRepo, processGone } from './helpers.ts';

const dirs: string[] = [];
const startedPids: number[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bare-claude-termination-${label}-`));
  dirs.push(dir);
  return fs.realpath(dir);
}

afterEach(async () => {
  for (const pid of startedPids.splice(0)) {
    if (!processGone(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* Gone in between. */ }
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

/**
 * A supervising launcher in miniature: it records its PID, starts the fake
 * `claude` as its own child, and on SIGTERM either forwards it to the child
 * and keeps waiting (`FAKE_LAUNCHER_FORWARD=1`) or exits at once, leaving the
 * child running. It exits with the child's status when it waited for it.
 */
const launcherScript = [
  '#!/bin/sh',
  'echo $$ > "$FAKE_LAUNCHER_PID_FILE"',
  '"$FAKE_CLAUDE" "$@" &',
  'child=$!',
  'if [ "$FAKE_LAUNCHER_FORWARD" = 1 ]; then',
  '  trap \'kill -TERM "$child" 2>/dev/null\' TERM',
  'else',
  '  trap \'exit 143\' TERM',
  'fi',
  'status=0',
  'while :; do',
  '  wait "$child"',
  '  status=$?',
  '  kill -0 "$child" 2>/dev/null || break',
  'done',
  'exit "$status"',
  '',
].join('\n');

async function writeLauncher(): Promise<string> {
  const file = path.join(await tempDir('launcher'), 'launcher');
  await fs.writeFile(file, launcherScript, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return file;
}

/** A PID a fake wrote to `file`, once it has. */
async function pidFrom(file: string): Promise<number> {
  const written = await eventually(async () => (await Bun.file(file).exists()) && (await Bun.file(file).text()) !== '', 10_000);
  expect(written).toBe(true);
  const pid = Number((await Bun.file(file).text()).trim());
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  startedPids.push(pid);
  return pid;
}

/** A CLI run in progress, with its stderr collected as it arrives. */
interface Running {
  cli: Bun.Subprocess<'ignore', 'ignore', 'pipe'>,
  stderr: () => string,
}

function startCli(args: string[], cwd: string, env: Record<string, string>): Running {
  const cli = Bun.spawn({
    cmd: [ 'bun', cliPath, ...args ],
    cwd,
    env: {
      ...process.env,
      BARE_CLAUDE_TOKEN_FILE: path.join(cwd, 'no-token-file'),
      ...env,
      PATH: `${fakeClaudeDir}:${process.env.PATH ?? ''}`,
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of cli.stderr) {
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
  })();
  return { cli, stderr: () => chunks.join('') };
}

/** The journal path the CLI reported at spawn. */
function reportedJournal(stderr: string): string {
  const journal = stderr.match(/^Claude session journal at (.+)$/m)?.[1];
  expect(journal).toBeDefined();
  return journal ?? '';
}

/** The journal's size, twice, `ms` apart: equal once nothing is writing it. */
async function sizesApart(file: string, ms: number): Promise<[ number, number ]> {
  const first = (await fs.stat(file)).size;
  await Bun.sleep(ms);
  return [ first, (await fs.stat(file)).size ];
}

/** Everything a run needs: a working copy, a caller's home, a fake that keeps writing. */
async function setUp(): Promise<{ cwd: string, home: string, claudePid: string, launcherPid: string }> {
  const cwd = await fs.realpath(await makeTempRepo());
  dirs.push(cwd);
  const pids = await tempDir('pids');
  return {
    cwd,
    home: path.join(await tempDir('home'), 'claude'),
    claudePid: path.join(pids, 'claude.pid'),
    launcherPid: path.join(pids, 'launcher.pid'),
  };
}

const writing = { FAKE_CLAUDE_SLEEP_MS: '30000', FAKE_CLAUDE_APPEND_EVERY_MS: '50' };

describe.if(process.platform === 'darwin' || process.platform === 'linux')('stopping a run', () => {
  test('SIGTERM reaches the launcher, which stops its child; the CLI waits, reports and exits 143', async () => {
    const { cwd, home, claudePid, launcherPid } = await setUp();
    const run = startCli([
      '--no-config', '--claude-home', home, '--claude-path', await writeLauncher(), '--quiet', 'hello',
    ], cwd, {
      ...writing,
      FAKE_CLAUDE: path.join(fakeClaudeDir, 'claude'),
      FAKE_LAUNCHER_FORWARD: '1',
      FAKE_LAUNCHER_PID_FILE: launcherPid,
      FAKE_CLAUDE_PID_FILE: claudePid,
    });
    const launcher = await pidFrom(launcherPid);
    const claude = await pidFrom(claudePid);
    expect(await eventually(() => run.stderr().includes(`Claude process group ${launcher}\n`), 10_000)).toBe(true);
    const journal = reportedJournal(run.stderr());
    expect(await eventually(() => Bun.file(journal).exists(), 10_000)).toBe(true);

    run.cli.kill('SIGTERM');
    expect(await run.cli.exited).toBe(143);

    expect(await eventually(() => processGone(launcher) && processGone(claude), 5_000)).toBe(true);
    const [ before, after ] = await sizesApart(journal, 300);
    expect(after).toBe(before);
    expect(await eventually(() => run.stderr().includes(`Claude home kept at ${home}\n`), 2_000)).toBe(true);
    const stderr = run.stderr();
    expect(stderr).toContain(`bare-claude: received SIGTERM; sent it to claude (pid ${launcher})`);
    expect(stderr).toContain(`Claude stop: SIGTERM; process group ${launcher} empty\n`);
    expect(stderr).not.toContain('then SIGKILL');
  }, 30_000);

  test('a launcher that abandons its child does not leave it running: the group is signalled', async () => {
    const { cwd, home, claudePid, launcherPid } = await setUp();
    const run = startCli([
      '--no-config', '--claude-home', home, '--claude-path', await writeLauncher(), '--quiet', 'hello',
    ], cwd, {
      ...writing,
      FAKE_CLAUDE: path.join(fakeClaudeDir, 'claude'),
      FAKE_LAUNCHER_FORWARD: '0',
      FAKE_LAUNCHER_PID_FILE: launcherPid,
      FAKE_CLAUDE_PID_FILE: claudePid,
    });
    const launcher = await pidFrom(launcherPid);
    const claude = await pidFrom(claudePid);
    expect(await eventually(() => run.stderr().includes(`Claude process group ${launcher}\n`), 10_000)).toBe(true);
    const journal = reportedJournal(run.stderr());
    expect(await eventually(() => Bun.file(journal).exists(), 10_000)).toBe(true);

    run.cli.kill('SIGTERM');
    expect(await run.cli.exited).toBe(143);

    // Without the group, this fake would go on writing for 30 seconds.
    expect(await eventually(() => processGone(launcher) && processGone(claude), 5_000)).toBe(true);
    const [ before, after ] = await sizesApart(journal, 300);
    expect(after).toBe(before);
    expect(await eventually(() => run.stderr().includes(`Claude stop: SIGTERM; process group ${launcher} empty\n`), 2_000))
      .toBe(true);
  }, 30_000);

  test('a child that ignores SIGTERM is sent SIGKILL when the grace runs out', async () => {
    const { cwd, home, claudePid } = await setUp();
    const run = startCli([
      '--no-config', '--claude-home', home, '--stop-grace-ms', '500', '--quiet', 'hello',
    ], cwd, { ...writing, FAKE_CLAUDE_IGNORE_SIGTERM: '1', FAKE_CLAUDE_PID_FILE: claudePid });
    const claude = await pidFrom(claudePid);
    expect(await eventually(() => run.stderr().includes(`Claude process group ${claude}\n`), 10_000)).toBe(true);
    const journal = reportedJournal(run.stderr());
    expect(await eventually(() => Bun.file(journal).exists(), 10_000)).toBe(true);

    const signalledAt = Date.now();
    run.cli.kill('SIGTERM');
    expect(await run.cli.exited).toBe(143);
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(500);

    expect(await eventually(() => processGone(claude), 5_000)).toBe(true);
    const [ before, after ] = await sizesApart(journal, 300);
    expect(after).toBe(before);
    expect(await eventually(() => run.stderr().includes('Claude process ended: signal SIGKILL\n'), 2_000)).toBe(true);
    expect(run.stderr()).toContain(`Claude stop: SIGTERM, then SIGKILL; process group ${claude} empty\n`);
  }, 30_000);

  test('a second signal sends SIGKILL at once, without waiting out the grace', async () => {
    const { cwd, home, claudePid } = await setUp();
    const run = startCli([
      '--no-config', '--claude-home', home, '--stop-grace-ms', '60000', '--quiet', 'hello',
    ], cwd, { ...writing, FAKE_CLAUDE_IGNORE_SIGTERM: '1', FAKE_CLAUDE_PID_FILE: claudePid });
    const claude = await pidFrom(claudePid);
    expect(await eventually(() => run.stderr().includes(`Claude process group ${claude}\n`), 10_000)).toBe(true);

    const signalledAt = Date.now();
    run.cli.kill('SIGTERM');
    expect(await eventually(() => run.stderr().includes('received SIGTERM'), 5_000)).toBe(true);
    run.cli.kill('SIGINT');

    // The first signal names the exit status; the second only hurries it.
    expect(await run.cli.exited).toBe(143);
    expect(Date.now() - signalledAt).toBeLessThan(15_000);
    expect(await eventually(() => processGone(claude), 5_000)).toBe(true);
    expect(run.stderr()).toContain('bare-claude: received SIGINT again; sending SIGKILL now\n');
  }, 30_000);

  test('SIGHUP stops a run with a temporary home too: its group is reported at spawn, exit 129', async () => {
    // A runner cannot reach this child through the CLI's own process group,
    // so the group line must be there whether or not the home is kept.
    const { cwd, claudePid } = await setUp();
    const run = startCli([ '--no-config', '--quiet', 'hello' ], cwd, { ...writing, FAKE_CLAUDE_PID_FILE: claudePid });
    const claude = await pidFrom(claudePid);
    expect(await eventually(() => run.stderr().includes(`Claude process group ${claude}\n`), 10_000)).toBe(true);
    expect(run.stderr()).not.toContain('Claude session journal at');

    run.cli.kill('SIGHUP');
    expect(await run.cli.exited).toBe(129);

    expect(await eventually(() => processGone(claude), 5_000)).toBe(true);
    expect(await eventually(() => run.stderr().includes('Claude home kept at '), 2_000)).toBe(true);
    const home = run.stderr().match(/^Claude home kept at (.+)$/m)?.[1] ?? '';
    expect(path.isAbsolute(home) && path.basename(home).startsWith('bare-claude-home-')).toBe(true);
    dirs.push(home);
    const journal = run.stderr().match(/^Claude session journal at (.+)$/m)?.[1] ?? '';
    expect(journal.startsWith(path.join(home, 'projects'))).toBe(true);
    const [ before, after ] = await sizesApart(journal, 300);
    expect(after).toBe(before);
    expect(run.stderr()).toContain(`bare-claude: received SIGHUP; sent it to claude (pid ${claude})`);
  }, 30_000);

  test('a leftover holding the child\'s stdout does not hold the CLI: it exits, says what is left, keeps the home', async () => {
    // A launcher that exits 0 at once and leaves a process behind in its
    // group, with its stdout — the pipe the CLI drains — still open. Nobody
    // asked for a stop, so it is not signalled; the CLI must still exit well
    // before that process ends, and must not report the run as wholly over.
    const { cwd, claudePid } = await setUp();
    const launcher = path.join(await tempDir('launcher'), 'launcher');
    await fs.writeFile(launcher, [
      '#!/bin/sh',
      'sleep 30 &',
      'echo $! > "$FAKE_CLAUDE_PID_FILE"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    await fs.chmod(launcher, 0o755);

    const startedAt = Date.now();
    const run = startCli([ '--no-config', '--claude-path', launcher, '--quiet', 'hello' ], cwd, {
      FAKE_CLAUDE_PID_FILE: claudePid,
    });
    expect(await run.cli.exited).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    const leftover = await pidFrom(claudePid);
    expect(processGone(leftover)).toBe(false);
    expect(await eventually(() => run.stderr().includes('Claude home kept at '), 2_000)).toBe(true);
    const stderr = run.stderr();
    const group = stderr.match(/^Claude process group (\d+)$/m)?.[1];
    expect(group).toBeDefined();
    expect(stderr).toContain(
      `bare-claude: claude exited, but process group ${group} still has processes; `
      + 'they were not signalled and may still be running\n'
    );
    expect(stderr).toContain('Claude process ended: exit code 0\n');
    expect(stderr).not.toContain('Claude stop:');
    const home = stderr.match(/^Claude home kept at (.+)$/m)?.[1] ?? '';
    expect(path.isAbsolute(home) && path.basename(home).startsWith('bare-claude-home-')).toBe(true);
    dirs.push(home);
    expect(await fs.stat(home).then(stats => stats.isDirectory())).toBe(true);
  }, 30_000);

  test('a run that ends on its own is not signalled, and its exit stands', async () => {
    const { cwd, home, claudePid } = await setUp();
    const run = startCli([ '--no-config', '--claude-home', home, '--quiet', 'hello' ], cwd, {
      FAKE_CLAUDE_EXIT_CODE: '3', FAKE_CLAUDE_PID_FILE: claudePid,
    });

    expect(await run.cli.exited).toBe(3);
    const claude = await pidFrom(claudePid);
    expect(await eventually(() => processGone(claude), 5_000)).toBe(true);
    expect(await eventually(() => run.stderr().includes('Claude process ended: exit code 3\n'), 2_000)).toBe(true);
    expect(run.stderr()).not.toContain('Claude stop:');
    expect(run.stderr()).not.toContain('received');
  }, 30_000);
});
