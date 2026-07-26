import { describe, expect, test } from 'bun:test';

import path from 'node:path';

import { emptyConfig, parseConfig } from './config.ts';

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
    expect(configPreset.use).toBe('default');
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

  test('rejects a root that is not a mapping', () => {
    expect(() => parseConfig('- one\n- two\n')).toThrow('must be a mapping of preset fields');
    expect(() => parseConfig('just a string')).toThrow('got a string');
  });

  test('reports a YAML syntax error against the file, not as a crash', () => {
    expect(() => parseConfig('presets: [1, 2', 'broken.yaml'))
      .toThrow('broken.yaml is not valid YAML');
  });
});
