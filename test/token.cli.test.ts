/**
 * Black-box tests of the token file through the real CLI: `--token-file`,
 * `BARE_CLAUDE_TOKEN_FILE`, the default location under a temporary HOME, and
 * the one property that matters most — the token's value never appears in
 * anything the CLI itself prints. The fake `claude` reports what reached the
 * child's environment via `FAKE_CLAUDE_ECHO_ENV`; with `--quiet --print` that
 * report is the CLI's whole stdout.
 *
 * `runCli` points `BARE_CLAUDE_TOKEN_FILE` at a file that does not exist
 * unless a test says otherwise, so the operator's real token file is never
 * read here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeTempRepo, runCli } from './helpers.ts';

const echo = { FAKE_CLAUDE_ECHO_ENV: 'CLAUDE_CODE_OAUTH_TOKEN' };

const dirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bare-claude-token-cli-${label}-`));
  dirs.push(dir);
  return dir;
}

async function repo(): Promise<string> {
  const dir = await makeTempRepo();
  dirs.push(dir);
  return dir;
}

async function tokenFile(label: string, content: string): Promise<string> {
  const file = path.join(await tempDir(label), 'oauth');
  await fs.writeFile(file, content, { mode: 0o600 });
  return file;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('--token-file', () => {
  test('puts the file\'s trimmed content in the child\'s environment', async () => {
    const file = await tokenFile('explicit', '  sk-ant-oat01-from-file\n');
    const result = await runCli([ '--quiet', '--print', '--token-file', file, 'hello' ], {
      cwd: await repo(), env: echo,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-from-file\n');
  });

  test('an environment token wins over the file', async () => {
    const file = await tokenFile('explicit', 'sk-ant-oat01-from-file');
    const result = await runCli([ '--quiet', '--print', '--token-file', file, 'hello' ], {
      cwd: await repo(), env: { ...echo, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-env' },
    });

    expect(result.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-from-env\n');
  });

  test('BARE_CLAUDE_TOKEN_FILE names the file when the flag is absent', async () => {
    const file = await tokenFile('variable', 'sk-ant-oat01-from-variable');
    const result = await runCli([ '--quiet', '--print', 'hello' ], {
      cwd: await repo(), env: { ...echo, BARE_CLAUDE_TOKEN_FILE: file },
    });

    expect(result.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-from-variable\n');
  });

  test('falls back to ~/.config/bare-claude/oauth, and to XDG_CONFIG_HOME', async () => {
    const home = await tempDir('home');
    await fs.mkdir(path.join(home, '.config', 'bare-claude'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'bare-claude', 'oauth'), 'sk-ant-oat01-from-home', { mode: 0o600 });
    const xdg = await tempDir('xdg');
    await fs.mkdir(path.join(xdg, 'bare-claude'), { recursive: true });
    await fs.writeFile(path.join(xdg, 'bare-claude', 'oauth'), 'sk-ant-oat01-from-xdg', { mode: 0o600 });

    const viaHome = await runCli([ '--quiet', '--print', 'hello' ], {
      cwd: await repo(), env: { ...echo, HOME: home, BARE_CLAUDE_TOKEN_FILE: '', XDG_CONFIG_HOME: '' },
    });
    expect(viaHome.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-from-home\n');

    const viaXdg = await runCli([ '--quiet', '--print', 'hello' ], {
      cwd: await repo(), env: { ...echo, HOME: home, BARE_CLAUDE_TOKEN_FILE: '', XDG_CONFIG_HOME: xdg },
    });
    expect(viaXdg.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-from-xdg\n');
  });

  test('no file means no token, and the run proceeds', async () => {
    const result = await runCli([ '--quiet', '--print', 'hello' ], { cwd: await repo(), env: echo });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=<unset>\n');
  });

  test('an empty file is refused before anything is spawned', async () => {
    const file = await tokenFile('empty', '\n');
    const result = await runCli([ '--quiet', '--token-file', file, 'hello' ], { cwd: await repo() });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`bare-claude: token file ${file} is empty\n`);
  });

  test('the token never appears in --debug output', async () => {
    // --debug prints the resolved configuration and keeps the ephemeral home;
    // neither may carry the value. The fake is not asked to echo it here, so
    // the only way it could show up is through the CLI itself.
    const file = await tokenFile('explicit', 'sk-ant-oat01-from-file');
    const result = await runCli([ '--debug', '--token-file', file, 'hello' ], { cwd: await repo() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"tokenFile"');
    expect(result.stdout).not.toContain('sk-ant-oat01');
    expect(result.stderr).not.toContain('sk-ant-oat01');

    const kept = result.stderr.match(/Claude home kept at (.+)\n/);
    expect(kept).not.toBeNull();
    if (kept?.[1] !== undefined) {
      const settings = await Bun.file(path.join(kept[1], 'settings.json')).text();
      expect(settings).not.toContain('sk-ant-oat01');
      await fs.rm(kept[1], { recursive: true, force: true });
    }
  });

  test('--help documents --token-file and the default location', async () => {
    const result = await runCli([ '--help' ], { cwd: await repo() });

    expect(result.stdout).toContain('--token-file');
    expect(result.stdout).toContain('~/.config/bare-claude/oauth');
  });
});
