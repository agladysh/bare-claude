/**
 * Black-box tests of `bare-claude --doctor`, run as a real subprocess. The
 * checks themselves are covered in `src/doctor.test.ts`; this pins the exit
 * code and the printed shape a shell or an agent would read, on a machine
 * assembled from a temporary HOME and a PATH that resolves `claude` to the
 * fake under `test/fake-claude` — never the real one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { install } from '../src/install.ts';
import { makeTempRepo, runCli } from './helpers.ts';

const bunDir = path.dirname(process.execPath);
const gitDir = path.dirname(Bun.which('git') ?? '/usr/bin/git');

const dirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bare-claude-doctor-cli-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

/** A temporary HOME with this checkout installed in its `.local/bin`, and an env that finds it. */
async function installedEnv(): Promise<Record<string, string>> {
  const home = await tempDir('home');
  const binDir = path.join(home, '.local', 'bin');
  await install(binDir);
  return {
    HOME: home,
    PATH: [ binDir, bunDir, gitDir ].join(path.delimiter), // runCli prepends the fake claude.
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-not-a-real-token',
  };
}

describe('--doctor', () => {
  test('exits 0 and prints one ok line per item when everything is in place', async () => {
    const cwd = await makeTempRepo();
    dirs.push(cwd);
    const result = await runCli([ '--doctor' ], { cwd, env: await installedEnv() });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines.map(line => line.split(' ')[0])).toEqual([ 'ok', 'ok', 'ok', 'ok', 'ok', 'ok' ]);
    expect(lines.map(line => line.split(/\s+/)[1])).toEqual([
      'bun:', 'claude:', 'git:', 'auth:', 'install:', 'preset:',
    ]);
    expect(result.stdout).toContain('claude: 9.9.9 at ');
    expect(result.stdout).not.toContain('sk-ant-oat01');
  });

  test('exits 1 with the setup-token guidance when the credential is missing', async () => {
    const cwd = await makeTempRepo();
    dirs.push(cwd);
    const env = { ...await installedEnv(), CLAUDE_CODE_OAUTH_TOKEN: '' };
    const result = await runCli([ '--doctor' ], { cwd, env });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('fail auth: CLAUDE_CODE_OAUTH_TOKEN absent');
    expect(result.stdout).toContain('claude setup-token');
  });

  test('--claude-path is honoured', async () => {
    const cwd = await makeTempRepo();
    dirs.push(cwd);
    const result = await runCli(
      [ '--doctor', '--claude-path', '/nonexistent/claude' ],
      { cwd, env: await installedEnv() }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('fail claude: /nonexistent/claude not found on PATH');
  });

  test('--help documents --doctor and the install scripts', async () => {
    const cwd = await makeTempRepo();
    dirs.push(cwd);
    const result = await runCli([ '--help' ], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--doctor');
    expect(result.stdout).toContain('bun run install:user');
    expect(result.stdout).toContain('claude setup-token');
  });
});
