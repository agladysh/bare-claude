import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildArgv, buildEnv, LaunchConfig, spawnClaude, type LaunchOptions } from './index.ts';
import { parseConfig } from './config.ts';
import { runDoctor } from './doctor.ts';

const config = () => LaunchConfig({ callToAction: '# probe', auth: 'native-store',
  nativeStorePath: '/enrolled/account-a', noProcessEnv: true });

describe('native-store authentication', () => {
  test('uses only explicit store paths and retains bare settings/ephemeral config', () => {
    const c = config();
    expect(c.linkAuth).toBe(false);
    const env = buildEnv(c, { ephemeralClaudeHomePath: '/temporary/run',
      processEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'ambient-not-inherited' },
      spawnEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong-store', ANTHROPIC_CONFIG_DIR: '/wrong-profile' } });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/temporary/run');
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/enrolled/account-a');
    expect(env.ANTHROPIC_CONFIG_DIR).toBe('/enrolled/account-a/anthropic-profile');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const argv = buildArgv(c, 'native-probe');
    expect(argv).toContain('--setting-sources');
    expect(argv).toContain('user');
  });

  test('refuses ambiguous option and settings sources', () => {
    const common: LaunchOptions = { callToAction: '# probe', auth: 'native-store' };
    expect(() => LaunchConfig({ ...common })).toThrow('requires an absolute nativeStorePath');
    for (const nativeStorePath of ['', 'relative/store', '/with\0nul']) {
      expect(() => LaunchConfig({ ...common, nativeStorePath })).toThrow('absolute nativeStorePath');
    }
    expect(() => LaunchConfig({ callToAction: '# probe', nativeStorePath: '/store' }))
      .toThrow('requires auth');
    expect(() => LaunchConfig({ ...config(), tokenFile: '/oauth' })).toThrow('cannot also take a tokenFile');
    expect(() => LaunchConfig({ ...config(), linkAuth: true })).toThrow('cannot also take linkAuth');
    expect(() => LaunchConfig({ ...config(), launcher: 'ollama' })).toThrow('claude launcher');
    for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'ANTHROPIC_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      expect(() => LaunchConfig({ ...config(), extraSettings: { env: { [name]: 'conflicting' } } }))
        .toThrow('authentication variables in extraSettings.env');
    }
    expect(() => LaunchConfig({ ...config(), extraSettings: { apiKeyHelper: 'helper' } }))
      .toThrow('apiKeyHelper');
  });

  test('refuses credential conflicts from every inherited/explicit environment layer without echoing values', () => {
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR']) {
      for (const layer of ['process', 'spawn', 'extra']) {
        const secret = 'synthetic-do-not-print';
        const c = { ...config(), noProcessEnv: layer !== 'process',
          extraEnv: layer === 'extra' ? { [name]: secret } : {} };
        try {
          buildEnv(c, { ephemeralClaudeHomePath: '/temporary',
            processEnv: layer === 'process' ? { [name]: secret } : {},
            spawnEnv: layer === 'spawn' ? { [name]: secret } : {} });
          throw new Error('conflict was accepted');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          if (!(error instanceof Error)) throw error;
          expect(error.message).toContain('conflicts with ' + name);
          expect(error.message).not.toContain(secret);
        }
      }
    }
  });

  test('refuses overlapping explicit run/store paths before writing either directory', () => {
    for (const home of ['/enrolled/account-a', '/enrolled/account-a/anthropic-profile', '/enrolled']) {
      expect(() => LaunchConfig({ ...config(), ephemeralClaudeHomePath: home })).toThrow('separate directories');
    }
    expect(LaunchConfig({ ...config(), ephemeralClaudeHomePath: '/temporary/run' }).auth).toBe('native-store');
  });

  test('doctor reports a conflicting environment instead of throwing or inspecting fallback credentials', async () => {
    const secret = 'synthetic-native-conflict-value';
    const report = await runDoctor({ config: { kind: 'none' },
      overrides: { auth: 'native-store', nativeStorePath: '/not-enrolled' },
      env: { CLAUDE_CODE_OAUTH_TOKEN: secret }, cwd: process.cwd() });
    expect(report.ok).toBe(false);
    const preset = report.items.find(item => item.name === 'preset');
    expect(preset?.status).toBe('fail');
    expect(preset?.hint.join(' ')).toContain('conflicts with CLAUDE_CODE_OAUTH_TOKEN');
    expect(report.items.find(item => item.name === 'auth')?.detail).toStartWith('not checked:');
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  test('preset schema accepts native selection', () => {
    const preset = parseConfig('auth: native-store\nnativeStorePath: /store-a\n').configPreset;
    expect(preset.auth).toBe('native-store');
    expect(preset.nativeStorePath).toBe('/store-a');
  });

  test('spawns without reading fallback token files, copying credentials or requiring a store layout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-native-fixture-'));
    try {
      const tokenDir = path.join(root, '.config/bare-claude');
      await fs.mkdir(tokenDir, { recursive: true });
      await fs.writeFile(path.join(tokenDir, 'oauth'), ''); // fallback would throw
      const probe = path.join(root, 'probe');
      await fs.writeFile(probe, `#!${process.execPath}
const config = process.env.CLAUDE_CONFIG_DIR;
console.log(JSON.stringify({store:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
  profile:process.env.ANTHROPIC_CONFIG_DIR,config,token:process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null}));
process.exit(7);
`, { mode: 0o700 });
      const store = path.join(root, 'missing-store');
      const child = await spawnClaude({ ...config(), nativeStorePath: store,
        claudePath: probe, extraEnv: { HOME: root }, cwd: root }, { stdout: 'pipe', stderr: 'pipe' });
      try {
        const text = await new Response(child.subprocess.stdout).text();
        expect(await child.subprocess.exited).toBe(7);
        const value: unknown = JSON.parse(text);
        if (typeof value !== 'object' || value === null || !('config' in value)
          || typeof value.config !== 'string' || !('store' in value) || !('profile' in value) || !('token' in value)) {
          throw new Error('invalid fixture receipt');
        }
        expect(value.store).toBe(store);
        expect(value.profile).toBe(path.join(store, 'anthropic-profile'));
        expect(value.config).not.toBe(store);
        expect(value.token).toBeNull();
        const names = await fs.readdir(value.config);
        for (const name of ['.credentials.json', 'auth.json', 'credentials.json']) {
          expect(names).not.toContain(name);
        }
        expect(await Bun.file(store).exists()).toBe(false);
      } finally { await child.dispose(); }
      const cli = Bun.spawn([process.execPath, path.resolve('bin/bare-claude.ts'),
        '--no-config', '--auth', 'native-store', '--native-store', store,
        '--claude-home', path.join(root, 'cli-home'),
        '--claude-path', probe, '--', '# probe'], {
        cwd: root, env: { HOME: root, PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [exit] = await Promise.all([cli.exited,
        new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
      expect(exit).toBe(7);

    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test('doctor does not inspect native credentials or call a selected path authenticated', async () => {
    const report = await runDoctor({ overrides: { auth: 'native-store', nativeStorePath: '/not-enrolled',
      noProcessEnv: true }, env: {}, cwd: process.cwd() });
    const auth = report.items.find(item => item.name === 'auth');
    expect(auth?.status).toBe('warn');
    expect(auth?.detail).toBe('native-store selected: login and refresh are not inspected');
  });
});
