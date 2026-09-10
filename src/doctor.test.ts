import { afterEach, describe, expect, test } from 'bun:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { formatDoctorReport, runDoctor, type DoctorItem, type DoctorReport } from './doctor.ts';
import { commandName, commandSource, install } from './install.ts';

/**
 * Every input the doctor reads is injected: a temporary HOME for the install
 * check, a temporary Git working copy for the preset check, and a PATH built
 * from scratch — the fake `claude` under `test/`, the running bun (the fake's
 * shebang needs it), and git. The real `claude` is never spawned.
 */

const fakeClaudeDir = path.join(import.meta.dir, '..', 'test', 'fake-claude');
const bunDir = path.dirname(process.execPath);
const gitDir = path.dirname(Bun.which('git') ?? '/usr/bin/git');

const roots: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bare-claude-doctor-${label}-`));
  roots.push(dir);
  return fs.realpath(dir);
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

/** A fresh Git working copy, optionally with a `bare-claude.yaml` at its root. */
async function tempRepo(yaml?: string): Promise<string> {
  const dir = await tempDir('repo');
  const init = Bun.spawn({ cmd: [ 'git', 'init', '-q' ], cwd: dir, stdout: 'ignore', stderr: 'ignore' });
  await init.exited;
  if (yaml !== undefined) {
    await Bun.file(path.join(dir, 'bare-claude.yaml')).write(yaml);
  }
  return dir;
}

function pathOf(...dirs: string[]): string {
  return dirs.join(path.delimiter);
}

/**
 * A machine on which every item passes: this checkout installed under a
 * temporary HOME and on PATH, the fake claude ahead of everything, a token in
 * the environment, and a valid preset file in the working copy.
 */
async function healthy(): Promise<{ home: string, binDir: string, env: Record<string, string>, cwd: string }> {
  const home = await tempDir('home');
  const binDir = path.join(home, '.local', 'bin');
  await install(binDir);
  const env = {
    HOME: home,
    PATH: pathOf(fakeClaudeDir, binDir, bunDir, gitDir),
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-not-a-real-token',
  };
  const cwd = await tempRepo('presets:\n  quick:\n    quiet: true\n');
  return { home, binDir, env, cwd };
}

function item(report: DoctorReport, name: string): DoctorItem {
  const found = report.items.find(i => i.name === name);
  if (found === undefined) {
    throw new Error(`no "${name}" item in ${JSON.stringify(report.items.map(i => i.name))}`);
  }
  return found;
}

describe('runDoctor', () => {
  test('reports every item ok on a healthy machine, in a fixed order', async () => {
    const { env, cwd, binDir } = await healthy();
    const report = await runDoctor({ env, cwd });

    expect(report.items.map(i => i.name)).toEqual([ 'bun', 'claude', 'git', 'auth', 'install', 'preset' ]);
    expect(report.items.map(i => i.status)).toEqual([ 'ok', 'ok', 'ok', 'ok', 'ok', 'ok' ]);
    expect(report.ok).toBe(true);

    expect(item(report, 'bun').detail).toContain(Bun.version);
    expect(item(report, 'claude').detail).toBe(`9.9.9 at ${path.join(fakeClaudeDir, 'claude')}`);
    expect(item(report, 'git').detail).toMatch(/^\d+\.\d+/);
    expect(item(report, 'auth').detail).toBe('CLAUDE_CODE_OAUTH_TOKEN present');
    expect(item(report, 'install').detail).toBe(`${path.join(binDir, commandName)} -> ${commandSource}`);
    expect(item(report, 'preset').detail).toBe(`${path.join(cwd, 'bare-claude.yaml')} (presets: quick)`);
  });

  test('takes the claude version from FAKE_CLAUDE_VERSION, proving the fake is what answered', async () => {
    const { env, cwd } = await healthy();
    const report = await runDoctor({ env: { ...env, FAKE_CLAUDE_VERSION: '2.1.220' }, cwd });

    expect(item(report, 'claude').detail).toContain('2.1.220 at');
  });

  describe('auth', () => {
    test('an absent token fails with the setup-token guidance from the README', async () => {
      const { env, cwd } = await healthy();
      const { CLAUDE_CODE_OAUTH_TOKEN: _dropped, ...withoutToken } = env;
      const report = await runDoctor({ env: withoutToken, cwd });

      const auth = item(report, 'auth');
      expect(auth.status).toBe('fail');
      expect(auth.detail).toBe('CLAUDE_CODE_OAUTH_TOKEN absent');
      expect(auth.hint.join('\n')).toContain(
        'claude setup-token                          # once; prints a long-lived OAuth token'
      );
      expect(auth.hint.join('\n')).toContain(
        'export CLAUDE_CODE_OAUTH_TOKEN=<the token>  # inherited by the subprocess'
      );
      expect(report.ok).toBe(false);
    });

    test('an empty token is absent, not present', async () => {
      const { env, cwd } = await healthy();
      const report = await runDoctor({ env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: '' }, cwd });

      expect(item(report, 'auth').status).toBe('fail');
    });

    test('an alternate credential downgrades the missing token to a warning', async () => {
      const { env, cwd } = await healthy();
      const { CLAUDE_CODE_OAUTH_TOKEN: _dropped, ...withoutToken } = env;
      const report = await runDoctor({ env: { ...withoutToken, ANTHROPIC_API_KEY: 'sk-ant-api-not-real' }, cwd });

      const auth = item(report, 'auth');
      expect(auth.status).toBe('warn');
      expect(auth.detail).toContain('ANTHROPIC_API_KEY present');
      expect(report.ok).toBe(true);
    });

    test('never reveals a credential value', async () => {
      const { env, cwd } = await healthy();
      const report = await runDoctor({ env: { ...env, ANTHROPIC_API_KEY: 'sk-ant-api-not-real' }, cwd });

      const text = formatDoctorReport(report);
      expect(text).not.toContain('sk-ant-oat01-not-a-real-token');
      expect(text).not.toContain('sk-ant-api-not-real');
    });
  });

  describe('claude', () => {
    test('fails when claude is not on PATH, and --claude-path names one directly', async () => {
      const { env, cwd, binDir } = await healthy();
      const withoutClaude = { ...env, PATH: pathOf(binDir, bunDir, gitDir) };

      const missing = await runDoctor({ env: withoutClaude, cwd });
      expect(item(missing, 'claude').status).toBe('fail');
      expect(item(missing, 'claude').detail).toBe('claude not found on PATH');
      expect(item(missing, 'claude').hint.join('\n')).toContain('--claude-path');
      expect(missing.ok).toBe(false);

      const named = await runDoctor({
        env: withoutClaude, cwd, claudePath: path.join(fakeClaudeDir, 'claude'),
      });
      expect(item(named, 'claude').status).toBe('ok');
      expect(named.ok).toBe(true);
    });

    test('fails when the executable does not answer --version', async () => {
      const { env, cwd } = await healthy();
      const report = await runDoctor({ env, cwd, claudePath: Bun.which('false') ?? '/usr/bin/false' });

      expect(item(report, 'claude').status).toBe('fail');
      expect(item(report, 'claude').detail).toContain('did not answer --version');
    });
  });

  describe('git', () => {
    test('fails when git is not on PATH', async () => {
      const { env, cwd, binDir } = await healthy();
      const report = await runDoctor({ env: { ...env, PATH: pathOf(fakeClaudeDir, binDir, bunDir) }, cwd });

      expect(item(report, 'git').status).toBe('fail');
      expect(item(report, 'git').detail).toBe('git not found on PATH');
    });
  });

  describe('install', () => {
    test('fails when nothing is installed, naming the install command', async () => {
      const home = await tempDir('home');
      const { env, cwd } = await healthy();
      const report = await runDoctor({ env: { ...env, HOME: home, PATH: pathOf(fakeClaudeDir, bunDir, gitDir) }, cwd });

      const install = item(report, 'install');
      expect(install.status).toBe('fail');
      expect(install.detail).toBe(
        `${commandName} is not on PATH, and ${path.join(home, '.local', 'bin', commandName)} is absent`
      );
      expect(install.hint).toEqual([ `cd ${path.dirname(path.dirname(commandSource))} && bun run install:user` ]);
      expect(report.ok).toBe(false);
    });

    test('fails when installed but the bin directory is not on PATH', async () => {
      const { env, cwd, binDir } = await healthy();
      const report = await runDoctor({ env: { ...env, PATH: pathOf(fakeClaudeDir, bunDir, gitDir) }, cwd });

      const install = item(report, 'install');
      expect(install.status).toBe('fail');
      expect(install.detail).toContain(`${binDir} is not on PATH`);
      expect(install.hint).toEqual([ `export PATH="${binDir}:$PATH"` ]);
    });

    test('fails on a foreign entry, with the forced install as the remedy', async () => {
      const { env, cwd, binDir } = await healthy();
      const target = path.join(binDir, commandName);
      await fs.unlink(target);
      await Bun.file(target).write('#!/bin/sh\necho not ours\n');

      const report = await runDoctor({ env, cwd });
      const install = item(report, 'install');
      expect(install.status).toBe('fail');
      expect(install.detail).toContain('not a symlink');
      expect(install.hint.join('\n')).toContain('bun run install:user --force');
    });

    test('accepts another bare-claude on PATH, such as a global package install', async () => {
      const home = await tempDir('home');
      const elsewhere = await tempDir('elsewhere');
      const other = path.join(elsewhere, commandName);
      await Bun.file(other).write('#!/bin/sh\necho elsewhere\n');
      await fs.chmod(other, 0o755);

      const { env, cwd } = await healthy();
      const report = await runDoctor({
        env: { ...env, HOME: home, PATH: pathOf(fakeClaudeDir, elsewhere, bunDir, gitDir) }, cwd,
      });

      const install = item(report, 'install');
      expect(install.status).toBe('ok');
      expect(install.detail).toBe(`${other} on PATH, not an install of this checkout`);
    });

    test('honours an explicit bin directory', async () => {
      const { env, cwd } = await healthy();
      const custom = await tempDir('custom');
      await install(custom);
      const report = await runDoctor({ env: { ...env, PATH: pathOf(fakeClaudeDir, custom, bunDir, gitDir) }, cwd, binDir: custom });

      expect(item(report, 'install').status).toBe('ok');
      expect(item(report, 'install').detail).toBe(`${path.join(custom, commandName)} -> ${commandSource}`);
    });

    test('fails without HOME rather than guessing', async () => {
      const { env, cwd } = await healthy();
      const { HOME: _dropped, ...withoutHome } = env;
      const report = await runDoctor({ env: withoutHome, cwd });

      expect(item(report, 'install').status).toBe('fail');
      expect(item(report, 'install').detail).toContain('HOME is not set');
    });
  });

  describe('preset', () => {
    test('warns outside a Git working copy', async () => {
      const { env } = await healthy();
      const cwd = await tempDir('plain');
      const report = await runDoctor({ env, cwd });

      const preset = item(report, 'preset');
      expect(preset.status).toBe('warn');
      expect(preset.detail).toContain(`${cwd} is not inside a Git working copy`);
      expect(report.ok).toBe(true);
    });

    test('a working copy without a preset file is fine', async () => {
      const { env } = await healthy();
      const cwd = await tempRepo();
      const report = await runDoctor({ env, cwd });

      expect(item(report, 'preset').status).toBe('ok');
      expect(item(report, 'preset').detail).toBe(`no bare-claude.yaml at ${cwd} (optional)`);
    });

    test('resolves the file from a subdirectory of the working copy', async () => {
      const { env } = await healthy();
      const root = await tempRepo('quiet: true\n');
      const nested = path.join(root, 'deep', 'er');
      await fs.mkdir(nested, { recursive: true });
      const report = await runDoctor({ env, cwd: nested });

      expect(item(report, 'preset').detail).toBe(path.join(root, 'bare-claude.yaml'));
    });

    test('an invalid preset file fails, with the validator\'s complaint as the hint', async () => {
      const { env } = await healthy();
      const cwd = await tempRepo('quite: true\n');
      const report = await runDoctor({ env, cwd });

      const preset = item(report, 'preset');
      expect(preset.status).toBe('fail');
      expect(preset.detail).toBe(`${path.join(cwd, 'bare-claude.yaml')} is invalid`);
      expect(preset.hint.join('\n')).toContain('quite must be removed');
      expect(report.ok).toBe(false);
    });
  });
});

describe('formatDoctorReport', () => {
  test('prints one status line per item and indents hints beneath it', () => {
    const text = formatDoctorReport({
      ok: false,
      items: [
        { name: 'bun', status: 'ok', detail: '1.3.13 at /usr/local/bin/bun', hint: [] },
        { name: 'auth', status: 'fail', detail: 'CLAUDE_CODE_OAUTH_TOKEN absent', hint: [ 'first', 'second' ] },
        { name: 'preset', status: 'warn', detail: 'nowhere', hint: [] },
      ],
    });

    expect(text).toBe([
      'ok   bun: 1.3.13 at /usr/local/bin/bun',
      'fail auth: CLAUDE_CODE_OAUTH_TOKEN absent',
      '       first',
      '       second',
      'warn preset: nowhere',
      '',
    ].join('\n'));
  });
});
