import { describe, expect, test } from 'bun:test';

import path from 'node:path';

import { resolvePreset, type DynamicPreset } from './preset.ts';

const cta = { callToAction: 'go' } as const;

describe('resolvePreset', () => {
  test('fills in the display defaults', () => {
    expect(resolvePreset(cta, {})).toEqual({
      callToAction: 'go',
      quiet: false,
      print: false,
      verbose: false,
      debug: false,
    });
  });

  test('normalizes a scalar read into an array', () => {
    expect(resolvePreset({ ...cta, read: 'README.md' }, {}).read).toEqual(['README.md']);
  });

  test('throws when callToAction never resolves', () => {
    expect(() => resolvePreset({}, {})).toThrow('callToAction is undefined');
  });

  test('throws naming the referrer when a preset is missing', () => {
    expect(() => resolvePreset({ ...cta, use: 'nope' }, {})).toThrow(
      'Preset "nope" referenced from "<root>" not found'
    );
  });

  test('names the intermediate referrer for a nested miss', () => {
    const presets: Record<string, DynamicPreset> = { outer: { use: 'nope' } };
    expect(() => resolvePreset({ ...cta, use: 'outer' }, presets)).toThrow(
      'Preset "nope" referenced from "outer" not found'
    );
  });

  test('lets the referring preset override the one it uses', () => {
    const presets: Record<string, DynamicPreset> = {
      base: { model: 'base-model', effortLevel: 'low', quiet: true },
    };
    const result = resolvePreset({ ...cta, use: 'base', model: 'override' }, presets);
    expect(result.model).toBe('override');
    expect(result.effortLevel).toBe('low');
    expect(result.quiet).toBe(true); // Inherited, not reset by the defaulting pass.
  });

  test('merges several used presets left to right', () => {
    const presets: Record<string, DynamicPreset> = {
      first: { model: 'first', launcher: 'claude' },
      second: { model: 'second' },
    };
    expect(resolvePreset({ ...cta, use: ['first', 'second'] }, presets).model).toBe('second');
  });

  test('inherits down a chain of used presets', () => {
    const presets: Record<string, DynamicPreset> = {
      leaf: { model: 'leaf', effortLevel: 'low' },
      middle: { use: 'leaf', model: 'middle' },
    };
    const result = resolvePreset({ ...cta, use: 'middle' }, presets);
    expect(result.model).toBe('middle');
    expect(result.effortLevel).toBe('low');
  });

  test('concatenates preload descriptors across the inheritance chain', () => {
    const presets: Record<string, DynamicPreset> = {
      history: { preload: [ { type: 'shell', cmd: 'git log --oneline -20' } ] },
    };
    const result = resolvePreset(
      { ...cta, use: 'history', preload: [ { type: 'ls', path: 'doc' } ] },
      presets
    );
    expect(result.preload).toEqual([
      { type: 'shell', cmd: 'git log --oneline -20' },
      { type: 'ls', path: 'doc' },
    ]);
  });

  test('leaves the presets it was handed untouched', () => {
    const presets: Record<string, DynamicPreset> = { base: { read: 'a.ts' } };
    const root: DynamicPreset = { ...cta, use: 'base', read: 'b.ts' };
    resolvePreset(root, presets);
    expect(root).toEqual({ callToAction: 'go', use: 'base', read: 'b.ts' });
    expect(presets.base).toEqual({ read: 'a.ts' });
  });

  test('concatenates read arrays across the inheritance chain', () => {
    const presets: Record<string, DynamicPreset> = {
      withCode: { read: ['*.ts'] },
      withDocs: { read: '*.md' },
    };
    const result = resolvePreset({ ...cta, use: ['withCode', 'withDocs'], read: ['extra.txt'] }, presets);
    expect(result.read).toEqual(['*.ts', '*.md', 'extra.txt']);
  });

  test('does not inherit the use field itself', () => {
    const presets: Record<string, DynamicPreset> = {
      leaf: { model: 'leaf' },
      middle: { use: 'leaf', model: 'middle' },
    };
    const result = resolvePreset({ ...cta, use: 'middle' }, presets);
    expect(result.model).toBe('middle');
    expect('use' in result).toBe(false);
  });

  test('resolves the README worked example', () => {
    // README "Preset Resolution Order": config root `use: claude, read: '*.ts'`
    // overridden by `--use ollama --read '*.md' --verbose`.
    const presets: Record<string, DynamicPreset> = {
      claude: { launcher: 'claude' },
      ollama: { launcher: 'ollama', model: 'nemotron-3-super:cloud' },
    };
    expect(
      resolvePreset(
        { use: 'ollama', read: ['*.ts', '*.md'], verbose: true, callToAction: 'Explain this project to me' },
        presets
      )
    ).toEqual({
      verbose: true,
      launcher: 'ollama',
      model: 'nemotron-3-super:cloud',
      read: ['*.ts', '*.md'],
      callToAction: 'Explain this project to me',
      quiet: false,
      print: false,
      debug: false,
    });
  });
});

// The other half of preset construction: argv. `--help` returns before any
// config loading or spawn work, so a full caller-shaped argv can ride along as
// a parse probe — strict parseArgs rejects an unknown flag before help is ever
// printed. Absorbed from okno's fork, whose caller once shipped a flag this CLI
// did not have and died on every invocation. Its `--` passthrough is
// deliberately not absorbed: upstream keeps `--` as the call-to-action
// separator and forwards through the repeatable `--claude-arg`.
describe('bare-claude argv', () => {
  const bin = path.join(import.meta.dir, '..', 'bin', 'bare-claude.ts');

  const runBin = async (args: string[]): Promise<{ code: number, out: string, err: string }> => {
    const proc = Bun.spawn([ 'bun', bin, ...args ], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const [ out, err, code ] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  };

  test('parses a caller-shaped argv', async () => {
    const { code, out } = await runBin([
      '--quiet', '--print', '--read', 'some.md', '--effort', 'low',
      '--claude-arg=--fallback-model', '--help', '# prompt',
    ]);
    expect(out).toContain('Usage:');
    expect(code).toBe(0);
  });

  test('refuses an unknown flag instead of running claude without it', async () => {
    // --allowedTools in particular: it is the flag that fails open, and this
    // CLI deliberately does not offer it. Silently ignoring it would leave a
    // caller believing a run was restricted when it was not.
    const { code, err } = await runBin([ '--allowedTools', '', '--help' ]);
    expect(err).toContain("Unknown option '--allowedTools'");
    expect(code).toBe(1);
  });
});
