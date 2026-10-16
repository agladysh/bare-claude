/**
 * Black-box tests of the CLI's custody mode, `--custody DIR` or `custody:` in
 * a configuration file, against the fake `claude`, and of the composition of
 * several `--config` files a whole declaration relies on: one shared profile
 * and one run's own file. Every custody run here is `auth: caller`, so no
 * token file is read and no credential linked.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { configurationScope } from '../src/custody.ts';
import { processGroupState } from '../src/lifecycle.ts';
import { cliPath, eventually, fakeClaudeDir, makeTempRepo, runCli } from './helpers.ts';

const dirs: string[] = [];
const groups: number[] = [];

afterEach(async () => {
  for (const group of groups.splice(0)) {
    if (processGroupState(group) === 'occupied') {
      try {
        process.kill(-group, 'SIGKILL');
      } catch { /* Emptied in between. */ }
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

/** A working copy to run in, and a custody directory that does not exist yet. */
async function setUp(): Promise<{ cwd: string, directory: string }> {
  const cwd = await fs.realpath(await makeTempRepo());
  dirs.push(cwd);
  const runs = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-custody-cli-')));
  dirs.push(runs);
  return { cwd, directory: path.join(runs, 'run') };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await Bun.file(file).text());
}

/** A file's text, or null while it does not exist; a fresh handle every time (CLAUDE.md). */
async function textOf(file: string): Promise<string | null> {
  try {
    return await Bun.file(file).text();
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

/** Every stdout line as JSON; a line that is not JSON fails the test here. */
function eventsIn(stdout: string): unknown[] {
  return stdout.split('\n').filter(line => line !== '').map((line): unknown => JSON.parse(line));
}

function kindOf(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'kind' in event ? event.kind : null;
}

function groupIn(start: unknown): number {
  const group = typeof start === 'object' && start !== null && 'processGroup' in start ? start.processGroup : null;
  expect(typeof group).toBe('number');
  return typeof group === 'number' ? group : -1;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

/** The argv the fake wrote to `file`, or null when it never ran. */
async function argvIn(file: string): Promise<string[] | null> {
  if (!await exists(file)) {
    return null;
  }
  const argv = await readJson(file);
  expect(isStringArray(argv)).toBe(true);
  return isStringArray(argv) ? argv : [];
}

/** The values following each occurrence of `flag` in `argv`. */
function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, i) => arg === flag ? [ argv[i + 1] ?? '' ] : []);
}

/** A temporary directory of configuration files, removed after the test. */
async function filesDir(): Promise<{ dir: string, write: (name: string, lines: string[]) => Promise<string> }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-compose-')));
  dirs.push(dir);
  return {
    dir,
    write: async (name, lines) => {
      const file = path.join(dir, name);
      await fs.writeFile(file, `${lines.join('\n')}\n`);
      return file;
    },
  };
}

/** The environment a CLI under test gets: the fake first on PATH, never the real token file. */
function cliEnv(cwd: string, env: Record<string, string>): Record<string, string | undefined> {
  return {
    ...process.env,
    BARE_CLAUDE_TOKEN_FILE: path.join(cwd, 'no-token-file'),
    ...env,
    PATH: `${fakeClaudeDir}:${process.env.PATH ?? ''}`,
  };
}

function startCli(args: string[], cwd: string, env: Record<string, string>) {
  const cli = Bun.spawn({
    cmd: [ 'bun', cliPath, ...args ],
    cwd,
    env: cliEnv(cwd, env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { cli, stdout: new Response(cli.stdout).text(), stderr: new Response(cli.stderr).text() };
}

describe.if(process.platform === 'darwin' || process.platform === 'linux')('--custody', () => {
  test('stdout carries custody events and nothing else; the raw output is in the run directory', async () => {
    const { cwd, directory } = await setUp();
    const result = await runCli([ '--no-config', '--auth', 'caller', '--custody', directory, 'hello' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: 'raw reply\n' },
    });

    expect(result.exitCode).toBe(0);
    const events = eventsIn(result.stdout);
    expect(events).toMatchObject([
      { kind: 'started', directory },
      { kind: 'completed', directory, completion: { outcome: 'exited', exitCode: 0 } },
      { kind: 'observed', directory, file: path.join(directory, 'observation.json'), error: null, observation: { state: 'exited' } },
    ]);
    expect(events.at(1)).toEqual({
      kind: 'completed', directory, completion: await readJson(path.join(directory, 'completion.json')),
    });
    // The stream carries the observation's state, basis and problems; the whole reading stays in the directory.
    const observation = await readJson(path.join(directory, 'observation.json'));
    expect(observation).toMatchObject({ stdout: { result: { status: 'not-read' } } });
    const summary = typeof observation === 'object' && observation !== null
      && 'format' in observation && 'version' in observation && 'state' in observation
      && 'basis' in observation && 'problems' in observation
      ? {
        format: observation.format, version: observation.version, state: observation.state,
        basis: observation.basis, problems: observation.problems,
      }
      : null;
    expect(events.at(2)).toEqual({
      kind: 'observed', directory, file: path.join(directory, 'observation.json'), error: null, observation: summary,
    });
    // Neither the child's own output nor a rendered transcript reaches stdout.
    expect(result.stdout).not.toContain('raw reply');
    expect(result.stdout).not.toContain('Done.');
    expect(await Bun.file(path.join(directory, 'stdout')).text()).toBe('raw reply\n');
    expect(result.stderr).toMatch(/^Claude process group \d+$/m);
    expect(result.stderr).toMatch(/^Claude session journal at .+$/m);
    expect(result.stderr).toContain(`Claude run custody at ${directory}\n`);
  }, 20_000);

  test('the exit status is the child\'s own; --print and a used directory are refused', async () => {
    const { cwd, directory } = await setUp();
    const args = [ '--no-config', '--auth', 'caller', '--custody', directory, 'hello' ];
    const failed = await runCli(args, { cwd, env: { FAKE_CLAUDE_EXIT_CODE: '7' } });
    expect(failed.exitCode).toBe(7);
    expect(await readJson(path.join(directory, 'completion.json'))).toMatchObject({ outcome: 'exited', exitCode: 7 });

    const again = await runCli(args, { cwd });
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('already exists');
    // Refused before custody: no event at all, so a reader of the stream
    // learns neither the status nor the cause from it.
    expect(again.stdout).toBe('');
    expect(await readJson(path.join(directory, 'completion.json'))).toMatchObject({ exitCode: 7 });

    const other = `${directory}-print`;
    const refused = await runCli([ '--no-config', '--auth', 'caller', '--custody', other, '--print', 'hello' ], { cwd });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('print cannot be combined with custody');
    expect(await exists(other)).toBe(false);
  }, 20_000);

  test('a shared profile and a run\'s own file declare a custody run whole, with no output flags to remember', async () => {
    const { cwd, directory } = await setUp();
    const files = path.dirname(directory);
    const argvFile = path.join(files, 'argv.json');
    const profile = path.join(files, 'profile.yaml');
    await fs.writeFile(profile, [
      'presets:',
      '  worker:',
      '    auth: caller',
      '    effortLevel: low',
      '    extraArgs: [--from-profile]',
      '',
    ].join('\n'));
    const declaration = path.join(files, 'run.yaml');
    await fs.writeFile(declaration, [
      'use: worker',
      'callToAction: "# from the run file"',
      'custody:',
      `  directory: ${JSON.stringify(directory)}`,
      '  keepCallToAction: true',
      '',
    ].join('\n'));

    const result = await runCli([ '--config', profile, '--config', declaration ], {
      cwd, env: { FAKE_CLAUDE_ARGV_FILE: argvFile },
    });

    expect(result.exitCode).toBe(0);
    expect(eventsIn(result.stdout).map(kindOf)).toEqual([ 'started', 'completed', 'observed' ]);
    expect(await Bun.file(path.join(directory, 'call-to-action.txt')).text()).toBe('# from the run file');
    expect(await readJson(path.join(directory, 'invocation.json'))).toMatchObject({
      auth: 'caller', effortLevel: 'low', extraArgs: [ '--from-profile' ],
    });
    // Neither file alone says this: the profile's preset, the run's prompt.
    const argv: unknown = await readJson(argvFile);
    expect(isStringArray(argv)).toBe(true);
    const seen = isStringArray(argv) ? argv : [];
    expect(seen).toContain('--from-profile');
    expect(seen.slice(-2)).toEqual([ '--print', '# from the run file' ]);
  }, 20_000);

  test('SIGTERM to the CLI stops the run, its completion records the stop, and it exits 143', async () => {
    const { cwd, directory } = await setUp();
    const run = startCli([ '--no-config', '--auth', 'caller', '--custody', directory, 'hello' ], cwd, {
      FAKE_CLAUDE_STDOUT_FIRST: 'partial\n', FAKE_CLAUDE_SLEEP_MS: '30000',
    });
    expect(await eventually(async () => await textOf(path.join(directory, 'stdout')) === 'partial\n', 10_000)).toBe(true);
    expect(await eventually(() => exists(path.join(directory, 'start.json')), 10_000)).toBe(true);
    groups.push(groupIn(await readJson(path.join(directory, 'start.json'))));

    run.cli.kill('SIGTERM');
    expect(await run.cli.exited).toBe(143);

    expect(await readJson(path.join(directory, 'completion.json'))).toMatchObject({
      outcome: 'stopped',
      stoppedBy: 'SIGTERM',
      stop: { cause: 'SIGTERM', report: { groupState: 'empty' } },
      processGroupAfter: { state: 'empty' },
      stdout: { bytes: 8 },
    });
    expect(eventsIn(await run.stdout).map(kindOf)).toEqual([ 'started', 'supervisor', 'completed', 'observed' ]);
    expect(await readJson(path.join(directory, 'observation.json'))).toMatchObject({ state: 'stopped' });
  }, 30_000);

  test('SIGKILL to the CLI leaves a start with no completion: an end nobody observed', async () => {
    const { cwd, directory } = await setUp();
    const run = startCli([ '--no-config', '--auth', 'caller', '--custody', directory, 'hello' ], cwd, {
      FAKE_CLAUDE_SLEEP_MS: '30000',
    });
    expect(await eventually(() => exists(path.join(directory, 'start.json')), 10_000)).toBe(true);
    const group = groupIn(await readJson(path.join(directory, 'start.json')));
    groups.push(group);

    run.cli.kill('SIGKILL');
    await run.cli.exited;
    await Bun.sleep(300);

    expect(await exists(path.join(directory, 'completion.json'))).toBe(false);
    // This test knows the group is its run's: it started the run a moment
    // ago and the fake sleeps for 30 s. A later reader of start.json knows a
    // number, and needs an identity before acting on it.
    expect(processGroupState(group)).toBe('occupied');
    const whileRunning = await runCli([ '--outcome-custody', directory ], { cwd });
    process.kill(-group, 'SIGKILL');
    expect(await eventually(() => processGroupState(group) === 'empty', 5_000)).toBe(true);

    // Before and after its group emptied, the same: the reader reads records,
    // not processes, and a missing completion is no end.
    const afterwards = await runCli([ '--outcome-custody', directory ], { cwd });
    for (const reading of [ whileRunning, afterwards ]) {
      expect(reading.exitCode).toBe(0);
      expect(JSON.parse(reading.stdout)).toMatchObject({
        state: 'start-only',
        completion: { status: 'absent' },
        journal: { namedBy: 'start.sessionJsonlPath', changedSinceCompletion: null },
      });
    }
    expect(await exists(path.join(directory, 'observation.json'))).toBe(false);
  }, 30_000);

  test('a reader that goes away ends the event stream, not the run, its completion or its exit status', async () => {
    const { cwd, directory } = await setUp();
    const status = path.join(path.dirname(directory), 'cli-status');
    // `true` exits at once, so the CLI's stdout is a pipe nobody reads, and
    // its first event line meets EPIPE, or SIGPIPE. The pipeline's own status
    // is `true`'s; the CLI's is written by the shell around it.
    //
    // Read a failure as it is:
    // - status 141, 128 + SIGPIPE: the closed pipe killed the CLI. Its run
    //   went on uncustodied and no completion was written. That is a defect
    //   in the CLI as it runs on this Bun, the ordinary mode's included, to be
    //   recorded and repaired, not worked around here.
    // - no stderr line: the write error never reached the CLI, so it cannot
    //   say the stream ended.
    // Whether the CLI started with SIGPIPE at its default disposition depends
    // on what this test process passed on through Bun.spawn and sh, which was
    // not established.
    const shell = Bun.spawn({
      cmd: [
        '/bin/sh', '-c', '{ "$@"; echo "$?" > "$CLI_STATUS"; } | true', 'sh',
        'bun', cliPath, '--no-config', '--auth', 'caller', '--custody', directory, 'hello',
      ],
      cwd,
      env: cliEnv(cwd, { CLI_STATUS: status, FAKE_CLAUDE_SLEEP_MS: '1000', FAKE_CLAUDE_EXIT_CODE: '3' }),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const stderr = new Response(shell.stderr).text();
    await shell.exited;

    expect((await textOf(status))?.trim()).toBe('3');
    expect(await readJson(path.join(directory, 'completion.json'))).toMatchObject({ outcome: 'exited', exitCode: 3 });
    // The observation does not depend on anyone reading the stream either.
    expect(await readJson(path.join(directory, 'observation.json'))).toMatchObject({ state: 'exited' });
    expect(await stderr).toContain('custody events no longer reach stdout');
  }, 30_000);

  test('an observation that cannot be written is said so, and changes neither the completion nor the exit status', async () => {
    const { cwd, directory } = await setUp();
    const observation = path.join(directory, 'observation.json');
    const result = await runCli([ '--no-config', '--auth', 'caller', '--custody', directory, 'hello' ], {
      cwd, env: { FAKE_CLAUDE_WRITE_FILE: observation },
    });

    // Not the 1 a failure to record the run itself would be.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('observation.json was not written');
    expect(result.stderr).toContain('the completion and the exit status stand');
    expect(await Bun.file(observation).text()).toBe('fake');
    expect(eventsIn(result.stdout).at(-1)).toMatchObject({ kind: 'observed', file: null, observation: { state: 'exited' } });
    expect(await readJson(path.join(directory, 'completion.json'))).toMatchObject({ outcome: 'exited', exitCode: 0, custodyError: null });
  }, 20_000);

  test('a composed declaration is recorded by its files\' paths and digests, never their contents, and none is read again', async () => {
    const { cwd, directory } = await setUp();
    const files = path.dirname(directory);
    const profile = path.join(files, 'profile.yaml');
    const alias = path.join(files, 'profile-alias.yaml');
    const declaration = path.join(files, 'run.yaml');
    const profileText = [
      'presets:', '  worker:', '    auth: caller', '    extraEnv:', '      PROFILE_SECRET: provenance-profile-sentinel', '',
    ].join('\n');
    const declarationText = [
      'use: worker', 'callToAction: "# provenance"', 'extraArgs: [--provenance-arg-sentinel]',
      'custody:', `  directory: ${JSON.stringify(directory)}`, '',
    ].join('\n');
    await fs.writeFile(profile, profileText);
    await fs.symlink(profile, alias);
    await fs.writeFile(declaration, declarationText);
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const configuration = {
      scope: configurationScope,
      source: 'files',
      files: [
        { path: alias, realPath: profile, bytes: Buffer.byteLength(profileText), sha256: sha(profileText) },
        { path: declaration, realPath: declaration, bytes: Buffer.byteLength(declarationText), sha256: sha(declarationText) },
      ],
      use: [ 'worker' ],
      useFrom: 'configuration',
    };

    const result = await runCli([ '--config', alias, '--config', declaration ], { cwd });
    expect(result.exitCode).toBe(0);
    expect(await readJson(path.join(directory, 'invocation.json'))).toMatchObject({ configuration });
    for (const text of [
      await Bun.file(path.join(directory, 'invocation.json')).text(),
      await Bun.file(path.join(directory, 'observation.json')).text(),
      result.stdout,
      result.stderr,
    ]) {
      expect(text).not.toContain('provenance-profile-sentinel');
    }
    // extraArgs are recorded as given, in the 0600 records, and not passed on to whatever reads the stream.
    expect(await Bun.file(path.join(directory, 'invocation.json')).text()).toContain('--provenance-arg-sentinel');
    expect(await Bun.file(path.join(directory, 'observation.json')).text()).toContain('--provenance-arg-sentinel');
    expect(result.stdout).not.toContain('--provenance-arg-sentinel');

    // A profile replaced after the run changes nothing that was recorded,
    // and nothing compares the record with the file as it is now.
    const replaced = 'presets: {}\n';
    await fs.writeFile(profile, replaced);
    const reading = await runCli([ '--outcome-custody', directory ], { cwd });
    expect(reading.exitCode).toBe(0);
    expect(JSON.parse(reading.stdout)).toMatchObject({ state: 'exited', invocation: { status: 'read', record: { configuration } } });
    expect(reading.stdout).not.toContain(sha(replaced));

    const twice = await runCli([ '--config', profile, '--config', alias, '--config', declaration ], { cwd });
    expect(twice.exitCode).toBe(1);
    expect(twice.stderr).toContain('is named twice');
  }, 20_000);

  test('the selected presets are recorded with where the selection came from; no configuration is recorded as none', async () => {
    const { cwd, directory } = await setUp();
    const profile = path.join(path.dirname(directory), 'profile.yaml');
    await fs.writeFile(profile, 'presets:\n  worker:\n    auth: caller\n');

    const used = await runCli([ '--config', profile, '--use', 'worker', '--custody', directory, 'hello' ], { cwd });
    expect(used.exitCode).toBe(0);
    expect(await readJson(path.join(directory, 'invocation.json'))).toMatchObject({
      configuration: { source: 'files', use: [ 'worker' ], useFrom: 'command-line' },
    });

    const bare = `${directory}-bare`;
    expect((await runCli([ '--no-config', '--auth', 'caller', '--custody', bare, 'hello' ], { cwd })).exitCode).toBe(0);
    expect(await readJson(path.join(bare, 'invocation.json'))).toMatchObject({
      configuration: { scope: configurationScope, source: 'none', files: [], use: null, useFrom: null },
    });
  }, 20_000);
});

describe.if(process.platform === 'darwin' || process.platform === 'linux')('--outcome-custody and custody batch lines', () => {
  test('read directories, each once per batch; a custody line naming files too is refused; a missing directory is a state', async () => {
    const { cwd, directory } = await setUp();
    expect((await runCli([ '--no-config', '--auth', 'caller', '--custody', directory, 'hello' ], { cwd })).exitCode).toBe(0);
    const missing = path.join(path.dirname(directory), 'missing');

    const lines = [
      JSON.stringify({ id: 'one', custody: directory }),
      JSON.stringify({ id: 'again', custody: directory }),
      JSON.stringify({ id: 'mixed', custody: directory, result: path.join(directory, 'stdout') }),
      JSON.stringify({ id: 'missing', custody: missing }),
      JSON.stringify({ id: 'file', result: path.join(directory, 'stdout') }),
    ].join('\n') + '\n';
    const batch = await runCli([ '--outcome-batch', '-' ], { cwd, stdin: lines });
    expect(batch.exitCode).toBe(0);
    const out: unknown[] = batch.stdout.trim().split('\n').map((line): unknown => JSON.parse(line));
    expect(out).toMatchObject([
      { id: 'one', line: 1, error: null, reading: { state: 'exited', directory } },
      { id: 'again', line: 2, error: null, reading: { state: 'exited' } },
      { id: null, line: 3, reading: null },
      { id: 'missing', line: 4, error: null, reading: { state: 'unreadable', entries: null } },
      // Named as a result by the caller, so read as one: text is then the reader's finding.
      { id: 'file', line: 5, error: null, reading: { result: { file: 'unreadable' } } },
    ]);
    // One reading for both lines: the same read, at the same moment.
    const readOf = (entry: unknown) => typeof entry === 'object' && entry !== null && 'reading' in entry
      && typeof entry.reading === 'object' && entry.reading !== null && 'read' in entry.reading ? entry.reading.read : null;
    expect(readOf(out[0])).not.toBeNull();
    expect(readOf(out[1])).toBe(readOf(out[0]));
    expect(JSON.stringify(out[2])).toContain('cannot be combined');

    const single = await runCli([ '--outcome-custody', missing ], { cwd });
    expect(single.exitCode).toBe(1);
    expect(JSON.parse(single.stdout)).toMatchObject({ state: 'unreadable', entries: null });

    const combined = await runCli([ '--outcome-custody', directory, '--outcome', path.join(directory, 'stdout') ], { cwd });
    expect(combined.exitCode).toBe(1);
    expect(combined.stderr).toContain('--outcome-custody cannot be combined');
  }, 20_000);
});

describe('several --config files', () => {
  test('a shared profile and a run\'s own declaration compose into one invocation, neither copied into the other', async () => {
    // The working copy's own file names another endpoint; named files
    // replace it, however many are named.
    const cwd = await fs.realpath(await makeTempRepo());
    dirs.push(cwd);
    await fs.writeFile(path.join(cwd, 'bare-claude.yaml'), [
      'use: default',
      'presets:',
      '  default:',
      '    extraEnv:',
      '      ANTHROPIC_BASE_URL: http://localhost:1234',
      '',
    ].join('\n'));
    const files = await filesDir();
    const argvFile = path.join(files.dir, 'argv.json');
    const profile = await files.write('profile.yaml', [
      'effortLevel: low',
      'extraArgs: [--from-profile-root]',
      'presets:',
      '  worker:',
      '    model: from-profile',
      '    tools: [Read]',
      '    extraArgs: [--from-profile-preset]',
    ]);
    const declaration = await files.write('run.yaml', [
      'use: worker',
      'model: from-run',
      'extraArgs: [--from-run]',
      'callToAction: "# from the run file"',
      'quiet: true',
      'print: true',
    ]);

    const result = await runCli([ '--config', profile, '--config', declaration ], {
      cwd,
      env: { FAKE_CLAUDE_ARGV_FILE: argvFile, FAKE_CLAUDE_ECHO_ENV: 'ANTHROPIC_BASE_URL', ANTHROPIC_BASE_URL: '' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ANTHROPIC_BASE_URL=\n');
    const seen = await argvIn(argvFile) ?? [];
    // Each of these is said by one file only.
    expect(flagValues(seen, '--model')).toEqual([ 'from-run' ]);
    expect(flagValues(seen, '--effort')).toEqual([ 'low' ]);
    expect(flagValues(seen, '--tools')).toEqual([ 'Read' ]);
    const extra = [ '--from-profile-preset', '--from-profile-root', '--from-run' ];
    const at = seen.indexOf('--from-profile-preset');
    expect(at).toBeGreaterThan(0);
    expect(seen.slice(at, at + extra.length)).toEqual(extra);
    expect(seen.slice(-2)).toEqual([ '--print', '# from the run file' ]);
  }, 20_000);

  test('a preset two files define, a root use in two, a file named twice, and --doctor over several are refused', async () => {
    const cwd = await fs.realpath(await makeTempRepo());
    dirs.push(cwd);
    const files = await filesDir();
    const argvFile = path.join(files.dir, 'argv.json');
    const env = { FAKE_CLAUDE_ARGV_FILE: argvFile };
    const first = await files.write('a.yaml', [ 'presets:', '  worker:', '    model: a' ]);
    const second = await files.write('b.yaml', [ 'presets:', '  worker:', '    model: b' ]);

    const duplicate = await runCli([ '--config', first, '--config', second, '--quiet', 'hello' ], { cwd, env });
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain(`preset "worker" is defined in both ${first} and ${second}`);

    const useA = await files.write('use-a.yaml', [ 'use: a', 'presets:', '  a:', '    model: a' ]);
    const useB = await files.write('use-b.yaml', [ 'use: b', 'presets:', '  b:', '    model: b' ]);
    const twoUses = await runCli([ '--config', useA, '--config', useB, '--quiet', 'hello' ], { cwd, env });
    expect(twoUses.exitCode).toBe(1);
    expect(twoUses.stderr).toContain('name a root use');

    const twice = await runCli([ '--config', first, '--config', first, '--quiet', 'hello' ], { cwd, env });
    expect(twice.exitCode).toBe(1);
    expect(twice.stderr).toContain('is named twice');

    const doctor = await runCli([ '--doctor', '--config', first, '--config', useA ], { cwd, env });
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stderr).toContain('--doctor checks one --config file');

    expect(await argvIn(argvFile)).toBeNull();
  }, 20_000);
});
