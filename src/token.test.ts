import { afterEach, describe, expect, test } from 'bun:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  alternateCredentialsIn,
  defaultTokenFile,
  formatMode,
  hasCredential,
  hasToken,
  inspectTokenFile,
  readTokenFile,
  resolveTokenFile,
  tokenFileVariable,
} from './token.ts';

/**
 * Every path here is under a temporary directory. The operator's real token
 * file is never named, let alone read: `HOME` is always supplied.
 */

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-token-test-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function tokenFile(dir: string, content: string, mode = 0o600): Promise<string> {
  const file = path.join(dir, 'oauth');
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode); // writeFile's mode is subject to umask; this is not.
  return file;
}

describe('hasToken, alternateCredentialsIn, hasCredential', () => {
  test('a token counts only when non-empty', () => {
    expect(hasToken({ CLAUDE_CODE_OAUTH_TOKEN: 'x' })).toBe(true);
    expect(hasToken({ CLAUDE_CODE_OAUTH_TOKEN: '' })).toBe(false);
    expect(hasToken({})).toBe(false);
  });

  test('alternate credentials are reported in a fixed order', () => {
    expect(alternateCredentialsIn({ ANTHROPIC_AUTH_TOKEN: 'a', ANTHROPIC_API_KEY: 'k' }))
      .toEqual([ 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN' ]);
    expect(alternateCredentialsIn({ ANTHROPIC_API_KEY: '' })).toEqual([]);
  });

  test('any credential satisfies hasCredential', () => {
    expect(hasCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'x' })).toBe(true);
    expect(hasCredential({ ANTHROPIC_AUTH_TOKEN: 'lmstudio' })).toBe(true);
    expect(hasCredential({ HOME: '/home/x' })).toBe(false);
  });
});

describe('defaultTokenFile', () => {
  test('is ~/.config/bare-claude/oauth', () => {
    expect(defaultTokenFile({ HOME: '/home/someone' })).toBe('/home/someone/.config/bare-claude/oauth');
  });

  test('honours XDG_CONFIG_HOME, ignoring an empty one', () => {
    expect(defaultTokenFile({ HOME: '/home/someone', XDG_CONFIG_HOME: '/xdg' }))
      .toBe('/xdg/bare-claude/oauth');
    expect(defaultTokenFile({ HOME: '/home/someone', XDG_CONFIG_HOME: '' }))
      .toBe('/home/someone/.config/bare-claude/oauth');
  });

  test('falls back to the account home without HOME', () => {
    expect(defaultTokenFile({})).toBe(path.join(os.homedir(), '.config', 'bare-claude', 'oauth'));
  });
});

describe('resolveTokenFile', () => {
  const env = { HOME: '/home/someone', [tokenFileVariable]: '/from/env/oauth' };

  test('an explicit path wins over the variable, which wins over the default', () => {
    expect(resolveTokenFile('/explicit/oauth', env)).toBe('/explicit/oauth');
    expect(resolveTokenFile(undefined, env)).toBe('/from/env/oauth');
    expect(resolveTokenFile(null, { HOME: '/home/someone' })).toBe('/home/someone/.config/bare-claude/oauth');
  });

  test('empty strings count as unset', () => {
    expect(resolveTokenFile('', env)).toBe('/from/env/oauth');
    expect(resolveTokenFile('  ', { ...env, [tokenFileVariable]: '' }))
      .toBe('/home/someone/.config/bare-claude/oauth');
  });

  test('an explicit relative path is made absolute', () => {
    expect(path.isAbsolute(resolveTokenFile('relative/oauth', env))).toBe(true);
  });
});

describe('formatMode', () => {
  test('prints the permission bits as chmod digits', () => {
    expect(formatMode(0o100600)).toBe('600');
    expect(formatMode(0o100644)).toBe('644');
    expect(formatMode(0o100000)).toBe('000');
  });
});

describe('inspectTokenFile', () => {
  test('a private file with content is present and not exposed', async () => {
    const file = await tokenFile(await tempDir(), 'sk-ant-oat01-not-real\n');
    const status = await inspectTokenFile(file);

    expect(status.state).toBe('present');
    if (status.state === 'present') {
      expect(status.exposed).toBe(false);
      expect(formatMode(status.mode)).toBe('600');
    }
    expect(JSON.stringify(status)).not.toContain('sk-ant-oat01');
  });

  test('a group- or world-readable file is exposed', async () => {
    const dir = await tempDir();
    const status = await inspectTokenFile(await tokenFile(dir, 'sk-ant-oat01-not-real', 0o644));

    expect(status.state).toBe('present');
    if (status.state === 'present') {
      expect(status.exposed).toBe(true);
      expect(formatMode(status.mode)).toBe('644');
    }
  });

  test('a file that is blank once trimmed is empty', async () => {
    const status = await inspectTokenFile(await tokenFile(await tempDir(), ' \n\t\n'));
    expect(status.state).toBe('empty');
  });

  test('a missing file is absent', async () => {
    const file = path.join(await tempDir(), 'oauth');
    expect(await inspectTokenFile(file)).toEqual({ state: 'absent', path: file });
  });

  test('a directory is unreadable, with the errno as the reason', async () => {
    const dir = await tempDir();
    const status = await inspectTokenFile(dir);
    expect(status.state).toBe('unreadable');
    if (status.state === 'unreadable') {
      expect(status.reason).toBe('EISDIR');
    }
  });
});

describe('readTokenFile', () => {
  test('returns the content trimmed of surrounding whitespace', async () => {
    const file = await tokenFile(await tempDir(), '  sk-ant-oat01-not-real\r\n\n');
    expect(await readTokenFile(file)).toBe('sk-ant-oat01-not-real');
  });

  test('returns null for a missing file', async () => {
    expect(await readTokenFile(path.join(await tempDir(), 'oauth'))).toBeNull();
  });

  test('throws on an empty file, naming the path only', async () => {
    const file = await tokenFile(await tempDir(), '\n');
    await expect(readTokenFile(file)).rejects.toThrow(`token file ${file} is empty`);
  });

  test('throws on an unreadable file, naming the path and the errno', async () => {
    const dir = await tempDir();
    await expect(readTokenFile(dir)).rejects.toThrow(`cannot read token file ${dir}: EISDIR`);
  });
});
