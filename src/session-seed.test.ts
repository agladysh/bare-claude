import { afterEach, describe, expect, test } from 'bun:test';

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cloneBranch, cloneRequired } from '../test/helpers.ts';
import { cloneSessionSeed } from './session-seed.ts';

/**
 * Every journal here is a few bytes in a fresh temporary directory. Whether
 * the filesystem under the temporary directory can clone at all differs by
 * host, and is decided once by the probe in `test/helpers.ts`, not by the
 * platform. The tests that need a clone take that branch, named in their
 * titles; on a host that cannot clone they assert the refusal instead. Either
 * way the source must come out byte-identical and nothing may be left at the
 * destination unless a clone was actually published.
 */

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-seed-'));
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

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

describe('cloneSessionSeed', () => {
  test.if(cloneRequired)('takes the clone branch where BARE_CLAUDE_REQUIRE_CLONE=1 says it must', () => {
    expect(cloneBranch).toBe('clone');
  });

  test('an unsupported platform refuses before creating a destination', async () => {
    const root = await tempDir();
    const source = path.join(root, 'prior');
    const target = path.join(root, 'home', 'next');
    await fs.writeFile(source, 'original journal');
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (descriptor === undefined) {
      throw new Error('process.platform has no property descriptor');
    }
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(() => cloneSessionSeed(source, target)).toThrow('unsupported on win32');
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
    expect(await fs.readdir(root)).toEqual([ 'prior' ]);
    expect(await fs.readFile(source, 'utf8')).toBe('original journal');
  });

  describe.if(process.platform === 'darwin' || process.platform === 'linux')('supported file-seed platforms', () => {
    test(`publishes a clone that appends independently of its source [${cloneBranch} branch]`, async () => {
      const root = await tempDir();
      const source = path.join(root, 'prior.jsonl');
      const target = path.join(root, 'home', 'projects', 'p', 'next.jsonl');
      const prior = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'before é' } })}\n`;
      await fs.writeFile(source, prior);

      if (cloneBranch === 'refusal') {
        expect(() => cloneSessionSeed(source, target, sha256(prior))).toThrow('no byte copy is made');
        expect(await Bun.file(target).exists()).toBe(false);
        expect(await fs.readdir(path.dirname(target))).toEqual([]);
        expect(await fs.readFile(source, 'utf8')).toBe(prior);
        return;
      }

      const published = cloneSessionSeed(source, target, sha256(prior));
      const stats = await fs.stat(target, { bigint: true });
      expect([ published.dev, published.ino ]).toEqual([ stats.dev, stats.ino ]);
      await fs.appendFile(target, 'next\n');
      await fs.appendFile(source, 'prior again\n');

      expect(await fs.readFile(target, 'utf8')).toBe(`${prior}next\n`);
      expect(await fs.readFile(source, 'utf8')).toBe(`${prior}prior again\n`);
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
      // The private staging directory is gone; only the journal is published.
      expect(await fs.readdir(path.dirname(target))).toEqual([ 'next.jsonl' ]);
    });

    test(`works without a recorded digest [${cloneBranch} branch]`, async () => {
      const root = await tempDir();
      const source = path.join(root, 'prior');
      const target = path.join(root, 'next');
      await fs.writeFile(source, 'prior');

      if (cloneBranch === 'refusal') {
        expect(() => cloneSessionSeed(source, target)).toThrow('no byte copy is made');
        return;
      }

      cloneSessionSeed(source, target);
      expect(await fs.readFile(target, 'utf8')).toBe('prior');
    });

    test('a source that no longer matches its digest is refused before anything is staged', async () => {
      const root = await tempDir();
      const source = path.join(root, 'prior');
      await fs.writeFile(source, 'different');

      expect(() => cloneSessionSeed(source, path.join(root, 'next'), sha256('recorded')))
        .toThrow('does not match the expected SHA-256');
      expect(await fs.readdir(root)).toEqual([ 'prior' ]);
    });

    test('a digest that is not a full lowercase SHA-256 is refused', async () => {
      const root = await tempDir();
      const source = path.join(root, 'prior');
      await fs.writeFile(source, 'prior');

      for (const bad of [ '0', sha256('prior').toUpperCase(), `${sha256('prior')}0` ]) {
        expect(() => cloneSessionSeed(source, path.join(root, 'next'), bad)).toThrow('full lowercase SHA-256');
      }
      expect(await fs.readdir(root)).toEqual([ 'prior' ]);
    });

    test('an existing destination journal is never overwritten', async () => {
      const root = await tempDir();
      const source = path.join(root, 'prior');
      const target = path.join(root, 'next');
      await fs.writeFile(source, 'prior');
      await fs.writeFile(target, 'original next');

      expect(() => cloneSessionSeed(source, target)).toThrow('already exists');
      expect(await fs.readFile(target, 'utf8')).toBe('original next');
      expect((await fs.readdir(root)).sort()).toEqual([ 'next', 'prior' ]);
    });

    test('a symbolic link, or a source with a second hard link, is refused', async () => {
      const root = await tempDir();
      const source = path.join(root, 'prior');
      const link = path.join(root, 'link');
      const target = path.join(root, 'next');
      await fs.writeFile(source, 'prior');

      await fs.symlink(source, link);
      expect(() => cloneSessionSeed(link, target)).toThrow('symbolic link');

      await fs.unlink(link);
      await fs.link(source, link);
      expect(() => cloneSessionSeed(source, target)).toThrow('single link');

      expect((await fs.readdir(root)).sort()).toEqual([ 'link', 'prior' ]);
    });

    test('a missing source is refused', async () => {
      const root = await tempDir();
      expect(() => cloneSessionSeed(path.join(root, 'absent'), path.join(root, 'next'))).toThrow();
      expect(await fs.readdir(root)).toEqual([]);
    });
  });
});
