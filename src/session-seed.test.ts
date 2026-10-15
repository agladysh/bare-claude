import { afterEach, describe, expect, test } from 'bun:test';

import { createHash } from 'node:crypto';
import { constants, copyFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cloneSessionSeed } from './session-seed.ts';

/**
 * Every journal here is a few bytes in a fresh temporary directory. Whether
 * the filesystem under the temporary directory can clone at all differs by
 * host — APFS can, the ext4 under CI cannot — so each test that needs a clone
 * asks first, and on a host without one asserts the refusal instead. Either
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

/** Whether `dir`'s filesystem accepts a forced copy-on-write clone. */
async function canClone(dir: string): Promise<boolean> {
  const probe = await fs.mkdtemp(path.join(dir, 'probe-'));
  try {
    await fs.writeFile(path.join(probe, 'a'), 'probe');
    copyFileSync(path.join(probe, 'a'), path.join(probe, 'b'), constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

describe('cloneSessionSeed', () => {
  test('publishes a clone that appends independently of its source', async () => {
    const root = await tempDir();
    const source = path.join(root, 'prior.jsonl');
    const target = path.join(root, 'home', 'projects', 'p', 'next.jsonl');
    const prior = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'before é' } })}\n`;
    await fs.writeFile(source, prior);

    if (!await canClone(root)) {
      expect(() => cloneSessionSeed(source, target, sha256(prior))).toThrow('no byte copy is made');
      expect(await Bun.file(target).exists()).toBe(false);
      expect(await fs.readdir(path.dirname(target))).toEqual([]);
      expect(await fs.readFile(source, 'utf8')).toBe(prior);
      return;
    }

    cloneSessionSeed(source, target, sha256(prior));
    await fs.appendFile(target, 'next\n');
    await fs.appendFile(source, 'prior again\n');

    expect(await fs.readFile(target, 'utf8')).toBe(`${prior}next\n`);
    expect(await fs.readFile(source, 'utf8')).toBe(`${prior}prior again\n`);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    // The private staging directory is gone; only the journal is published.
    expect(await fs.readdir(path.dirname(target))).toEqual([ 'next.jsonl' ]);
  });

  test('works without a recorded digest', async () => {
    const root = await tempDir();
    const source = path.join(root, 'prior');
    const target = path.join(root, 'next');
    await fs.writeFile(source, 'prior');

    if (!await canClone(root)) {
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
