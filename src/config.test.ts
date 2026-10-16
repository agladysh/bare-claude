import { describe, expect, test } from 'bun:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type } from 'arktype';

import { emptyConfig, loadConfig, loadConfigFiles, locateConfig, parseConfig, sessionIdSchema } from './config.ts';
import { sessionIdPattern } from './index.ts';
import { composeConfigs, resolveInvocation } from './preset.ts';

const repositoryConfig = path.join(import.meta.dir, '..', 'bare-claude.yaml');

describe('parseConfig', () => {
  test('accepts a file with nothing in it', () => {
    expect(parseConfig('')).toEqual(emptyConfig());
    expect(parseConfig('# nothing but a comment\n')).toEqual(emptyConfig());
  });

  test('separates the root preset from the named presets', () => {
    expect(parseConfig('use: default\npresets:\n  default:\n    quiet: true\n')).toEqual({
      configPreset: { use: 'default' },
      presets: { default: { quiet: true } },
    });
  });

  test('validates the configuration file this repository ships', async () => {
    // The README points readers at it as the worked example; a broken example
    // is worse than none.
    const { configPreset, presets } = parseConfig(
      await Bun.file(repositoryConfig).text(),
      repositoryConfig
    );
    // No root preset: every run from a checkout reads this file, and the
    // LM Studio endpoint and credential must not apply to all of them.
    expect(configPreset).toEqual({});
    expect(Object.keys(presets)).toContain('changelog');
  });

  test('takes a scalar where an array is allowed', () => {
    expect(parseConfig('use: one\nread: README.md\n').configPreset).toEqual({
      use: 'one',
      read: 'README.md',
    });
    expect(parseConfig('use: [one, two]\nread: ["*.ts"]\n').configPreset).toEqual({
      use: [ 'one', 'two' ],
      read: [ '*.ts' ],
    });
  });

  test('names the file it was asked to validate', () => {
    expect(() => parseConfig('quite: true', '/repo/bare-claude.yaml'))
      .toThrow('/repo/bare-claude.yaml is invalid');
  });

  test('rejects an unknown root key rather than ignoring it', () => {
    expect(() => parseConfig('quite: true')).toThrow('quite must be removed');
  });

  test('rejects an unknown key inside a named preset, with its path', () => {
    expect(() => parseConfig('presets:\n  release:\n    lancher: claude\n'))
      .toThrow('presets.release.lancher must be removed');
  });

  test('rejects an unknown launcher', () => {
    expect(() => parseConfig('launcher: olama')).toThrow(
      'launcher must be "claude" or "ollama" (was "olama")'
    );
  });

  test('rejects an effort level claude does not have', () => {
    expect(() => parseConfig('effortLevel: maximum')).toThrow('effortLevel must be');
    expect(parseConfig('effortLevel: max').configPreset.effortLevel).toBe('max');
  });

  test('rejects a permission mode either half of Claude Code would refuse', () => {
    // `manual` is the dangerous one: `--permission-mode` accepts it, the
    // settings schema does not, and an invalid settings file is dropped
    // silently in --print mode (measured 2026-07-26 on 2.1.220), taking the
    // whole bare configuration with it.
    expect(() => parseConfig('permissionMode: manual')).toThrow('permissionMode must be');
    expect(() => parseConfig('permissionMode: acceptedits')).toThrow('(was "acceptedits")');
    for (const mode of [ 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan' ]) {
      expect(parseConfig(`permissionMode: ${mode}`).configPreset.permissionMode).toBe(mode);
    }
  });

  test('rejects a system prompt operation that maps to no flag', () => {
    expect(() => parseConfig('changeSystemPrompt:\n  type: append\n  value: hi\n'))
      .toThrow('changeSystemPrompt.type must be');
  });

  test('accepts every preload descriptor kind', () => {
    const { configPreset } = parseConfig([
      'preload:',
      '  - type: file',
      '    path: README.md',
      '  - type: glob',
      "    pattern: 'src/*.ts'",
      '  - type: shell',
      '    cmd: git log --oneline -20',
      '    description: recent history',
      '  - type: ls',
      '    path: doc',
      '  - type: inline',
      '    text: Answer in one word.',
      '    label: Style',
      '',
    ].join('\n'));
    expect(configPreset.preload).toHaveLength(5);
  });

  test('rejects a preload descriptor that is not one of the five kinds', () => {
    expect(() => parseConfig('preload:\n  - type: bash\n    cmd: ls\n'))
      .toThrow('preload[0].type must be');
  });

  test('rejects a preload descriptor missing the field its kind needs', () => {
    expect(() => parseConfig('preload:\n  - type: shell\n    description: hi\n'))
      .toThrow('preload[0].cmd must be a string (was missing)');
  });

  test('rejects an unknown key inside a preload descriptor', () => {
    expect(() => parseConfig('preload:\n  - type: ls\n    path: doc\n    depth: 2\n'))
      .toThrow('preload[0].depth must be removed');
  });

  test('rejects an environment value YAML turned into a number', () => {
    expect(() => parseConfig('extraEnv:\n  PORT: 8080\n'))
      .toThrow('extraEnv.PORT must be a string (was a number)');
  });

  test('leaves the escape hatches unconstrained', () => {
    const { configPreset } = parseConfig([
      'extraSettings:',
      '  permissions:',
      "    allow: ['Edit(./CHANGELOG.md)']",
      '  spinnerTipsEnabled: false',
      'extraArgs: [--fallback-model, sonnet]',
      '',
    ].join('\n'));
    expect(configPreset.extraSettings).toEqual({
      permissions: { allow: [ 'Edit(./CHANGELOG.md)' ] },
      spinnerTipsEnabled: false,
    });
    expect(configPreset.extraArgs).toEqual([ '--fallback-model', 'sonnet' ]);
  });

  test('rejects a budget or a cap that cannot mean anything', () => {
    expect(() => parseConfig('maxBudgetUsd: -1')).toThrow('maxBudgetUsd must be positive');
    expect(() => parseConfig('maxTokens: 1.5')).toThrow('maxTokens must be an integer');
    expect(parseConfig('maxBudgetUsd: 0.5\nmaxTokens: 2048\n').configPreset.maxTokens).toBe(2048);
  });

  test('accepts either session seed, and a file seed with or without a digest', () => {
    const digest = 'a'.repeat(64);
    expect(parseConfig('customSessionData:\n  sessionId: s\n  value: "{}"\n').configPreset.customSessionData)
      .toEqual({ sessionId: 's', value: '{}' });
    expect(parseConfig('customSessionData:\n  sessionId: s\n  sourcePath: /p.jsonl\n').configPreset.customSessionData)
      .toEqual({ sessionId: 's', sourcePath: '/p.jsonl' });
    expect(parseConfig(`customSessionData:\n  sessionId: s\n  sourcePath: /p.jsonl\n  sourceSha256: ${digest}\n`)
      .configPreset.customSessionData).toEqual({ sessionId: 's', sourcePath: '/p.jsonl', sourceSha256: digest });
  });

  test('rejects a session seed that is both, neither, or carries a malformed digest', () => {
    expect(() => parseConfig('customSessionData:\n  sessionId: s\n  value: "{}"\n  sourcePath: /p.jsonl\n'))
      .toThrow('customSessionData');
    expect(() => parseConfig('customSessionData:\n  sessionId: s\n')).toThrow('customSessionData');
    expect(() => parseConfig(`customSessionData:\n  sessionId: s\n  sourcePath: /p\n  sourceSha256: ${'A'.repeat(64)}\n`))
      .toThrow('customSessionData');
    expect(() => parseConfig('customSessionData:\n  sessionId: s\n  sourcePath: /p\n  sourceSha256: abc\n'))
      .toThrow('customSessionData');
    expect(() => parseConfig('customSessionData:\n  sessionId: s\n  sourcePath: /p\n  sha256: abc\n'))
      .toThrow('customSessionData');
  });

  test('rejects a session id that cannot name a journal file, by the same rule as LaunchConfig', () => {
    const samples = [
      '01900000-0000-7000-8000-000000000001', 's', 'seed_1.v2', 'x'.repeat(128),
      '../escape', 'a/b', 'a\\b', '', '.', '..', '.hidden', '-flag', 'x'.repeat(129),
    ];
    for (const sample of samples) {
      expect(`${sample}: ${!(sessionIdSchema(sample) instanceof type.errors)}`)
        .toBe(`${sample}: ${sessionIdPattern.test(sample)}`);
    }
    expect(() => parseConfig('customSessionData:\n  sessionId: ../escape\n  value: "{}"\n'))
      .toThrow('customSessionData');
  });

  test('takes a stop grace in whole milliseconds', () => {
    expect(parseConfig('stopGraceMs: 500').configPreset.stopGraceMs).toBe(500);
    expect(() => parseConfig('stopGraceMs: -1')).toThrow('stopGraceMs');
    expect(() => parseConfig('stopGraceMs: 1.5')).toThrow('stopGraceMs');
  });

  test('accepts the two auth modes and nothing else', () => {
    expect(parseConfig('auth: caller').configPreset.auth).toBe('caller');
    expect(parseConfig('auth: fallback').configPreset.auth).toBe('fallback');
    expect(() => parseConfig('auth: none')).toThrow('auth must be');
    expect(() => parseConfig('auth: false')).toThrow('auth must be');
  });

  test('rejects a root that is not a mapping', () => {
    expect(() => parseConfig('- one\n- two\n')).toThrow('must be a mapping of preset fields');
    expect(() => parseConfig('just a string')).toThrow('got a string');
  });

  test('reports a YAML syntax error against the file, not as a crash', () => {
    expect(() => parseConfig('presets: [1, 2', 'broken.yaml'))
      .toThrow('broken.yaml is not valid YAML');
  });
});

describe('loadConfig', () => {
  test('none reads nothing, even beside an invalid located file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-config-test-'));
    try {
      const init = Bun.spawn({ cmd: [ 'git', 'init', '-q' ], cwd: root, stdout: 'ignore', stderr: 'ignore' });
      await init.exited;
      await Bun.file(path.join(root, 'bare-claude.yaml')).write('quite: true\n');

      expect(await loadConfig({ kind: 'none' }, root)).toEqual(emptyConfig());
      await expect(loadConfig({ kind: 'located' }, root)).rejects.toThrow('quite must be removed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('a named file is read without a Git working copy, and must exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-config-test-'));
    try {
      const file = path.join(dir, 'invocation.yaml');
      await Bun.file(file).write('model: from-file\n');

      expect((await loadConfig({ kind: 'file', path: file }, dir)).configPreset).toEqual({ model: 'from-file' });
      await expect(loadConfig({ kind: 'file', path: path.join(dir, 'absent.yaml') }, dir))
        .rejects.toThrow('does not exist');
      await expect(loadConfig({ kind: 'located' }, dir)).rejects.toThrow('not inside a Git working copy');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('custody in a configuration file', () => {
  test('is a directory and, optionally, keepCallToAction; nothing else', () => {
    expect(parseConfig('custody:\n  directory: /runs/1\n  keepCallToAction: true\n').configPreset)
      .toEqual({ custody: { directory: '/runs/1', keepCallToAction: true } });
    expect(() => parseConfig('custody:\n  keepCallToAction: true\n')).toThrow('directory');
    expect(() => parseConfig('custody:\n  directory: /runs/1\n  continuation: true\n')).toThrow('continuation');
  });
});

describe('composed configuration files', () => {
  const profile = [
    'effortLevel: low',
    'read: profile.md',
    'extraArgs: [--from-profile-root]',
    'presets:',
    '  worker:',
    '    model: from-profile',
    '    tools: [Read]',
    '    extraArgs: [--from-profile-preset]',
    '',
  ].join('\n');
  const declaration = [
    'use: worker',
    'model: from-run',
    'read: [run.md]',
    'extraArgs: [--from-run]',
    'callToAction: "# the run\'s own"',
    '',
  ].join('\n');

  test('compose as one file would: later roots win, arrays concatenate, use reaches every file\'s presets', () => {
    const composed = composeConfigs([
      { source: 'profile.yaml', config: parseConfig(profile, 'profile.yaml') },
      { source: 'run.yaml', config: parseConfig(declaration, 'run.yaml') },
    ]);
    expect(composed.configPreset).toEqual({
      effortLevel: 'low',
      model: 'from-run',
      read: [ 'profile.md', 'run.md' ],
      extraArgs: [ '--from-profile-root', '--from-run' ],
      callToAction: '# the run\'s own',
      use: 'worker',
    });

    // The root wins over what it uses, as within one file.
    const preset = resolveInvocation(composed, {});
    expect(preset).toMatchObject({
      model: 'from-run',
      effortLevel: 'low',
      tools: [ 'Read' ],
      extraArgs: [ '--from-profile-preset', '--from-profile-root', '--from-run' ],
    });
  });

  test('a preset name in two files, or a root use in two, is refused rather than guessed', () => {
    const named = (source: string, yaml: string) => ({ source, config: parseConfig(yaml, source) });
    expect(() => composeConfigs([
      named('a.yaml', 'presets:\n  worker:\n    model: a\n'),
      named('b.yaml', 'presets:\n  worker:\n    model: b\n'),
    ])).toThrow('preset "worker" is defined in both a.yaml and b.yaml');
    expect(() => composeConfigs([
      named('a.yaml', 'use: x\npresets:\n  x:\n    model: a\n'),
      named('b.yaml', 'use: y\npresets:\n  y:\n    model: b\n'),
    ])).toThrow('both a.yaml and b.yaml name a root use');
  });

  test('loadConfigFiles reads each file, which must exist, once', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-config-test-'));
    try {
      const first = path.join(dir, 'profile.yaml');
      const second = path.join(dir, 'run.yaml');
      await Bun.file(first).write(profile);
      await Bun.file(second).write(declaration);

      expect((await loadConfigFiles([ first, second ])).configPreset.model).toBe('from-run');
      expect(Object.keys((await loadConfigFiles([ first, second ])).presets)).toEqual([ 'worker' ]);
      await expect(loadConfigFiles([ first, path.join(dir, 'absent.yaml') ])).rejects.toThrow('does not exist');
      await expect(loadConfigFiles([ first, first ])).rejects.toThrow('is named twice');
      await expect(loadConfigFiles([])).rejects.toThrow('no configuration file is named');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('locateConfig', () => {
  test('names bare-claude.yaml at the root of the working copy, whether or not it exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-config-test-'));
    try {
      const init = Bun.spawn({ cmd: [ 'git', 'init', '-q' ], cwd: root, stdout: 'ignore', stderr: 'ignore' });
      await init.exited;
      const nested = path.join(root, 'a', 'b');
      await fs.mkdir(nested, { recursive: true });

      const expected = path.join(await fs.realpath(root), 'bare-claude.yaml');
      expect(await locateConfig(nested)).toBe(expected);
      expect(await Bun.file(expected).exists()).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('is null outside a Git working copy', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-config-test-'));
    try {
      expect(await locateConfig(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
