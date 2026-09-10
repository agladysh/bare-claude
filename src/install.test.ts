import { afterEach, describe, expect, test } from 'bun:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { commandName, commandSource, defaultBinDir, install, status, uninstall } from './install.ts';

import pkg from '../package.json';

const roots: string[] = [];

/** A fresh, not yet created bin directory under a temporary root. */
async function binDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-install-test-'));
  roots.push(root);
  return path.join(root, 'bin');
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

describe('defaultBinDir', () => {
  test('is ~/.local/bin', () => {
    expect(defaultBinDir({ HOME: '/home/someone' })).toBe('/home/someone/.local/bin');
  });

  test('refuses to guess without HOME', () => {
    expect(() => defaultBinDir({})).toThrow('HOME is not set');
    expect(() => defaultBinDir({ HOME: '  ' })).toThrow('HOME is not set');
  });
});

describe('commandSource', () => {
  test('is this checkout\'s executable CLI entry point with a bun shebang', async () => {
    expect(commandSource).toBe(path.resolve(import.meta.dir, '..', 'bin', 'bare-claude.ts'));

    const source = await Bun.file(commandSource).text();
    expect(source.startsWith('#!/usr/bin/env bun\n')).toBe(true);

    const mode = (await fs.stat(commandSource)).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

describe('install, status, uninstall', () => {
  test('installs a symlink into a directory that does not exist yet', async () => {
    const directory = await binDir();
    const target = path.join(directory, commandName);

    expect(await status(directory)).toEqual({ state: 'absent', path: target, source: commandSource });

    expect(await install(directory)).toEqual({ state: 'installed', path: target, source: commandSource });
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(target)).toBe(commandSource);
    expect(await status(directory)).toEqual({ state: 'installed', path: target, source: commandSource });
  });

  test('is idempotent and removes only what it installed', async () => {
    const directory = await binDir();
    const target = path.join(directory, commandName);

    await install(directory);
    expect((await install(directory)).state).toBe('already-installed');

    expect(await uninstall(directory)).toEqual({ state: 'removed', path: target, source: commandSource });
    expect((await status(directory)).state).toBe('absent');
    expect((await uninstall(directory)).state).toBe('absent');
  });

  test('the installed command runs under the system bun from anywhere', async () => {
    // The whole scheme rests on this: an extension-less symlink to a .ts
    // file, resolved by the shebang alone, from a cwd that is not a checkout.
    const directory = await binDir();
    await install(directory);

    const run = Bun.spawn({
      cmd: [ path.join(directory, commandName), '--version' ],
      cwd: os.tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [ stdout, stderr, exitCode ] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(`${pkg.version}\n`);
    expect(stderr).toBe('');
  });

  test('reports a foreign regular file and refuses to replace or remove it', async () => {
    const directory = await binDir();
    const target = path.join(directory, commandName);
    await fs.mkdir(directory, { recursive: true });
    await Bun.file(target).write('#!/bin/sh\necho not ours\n');

    expect(await status(directory)).toEqual({
      state: 'foreign', path: target, source: commandSource, detail: 'not a symlink',
    });
    await expect(install(directory)).rejects.toThrow('refusing to replace');
    await expect(uninstall(directory)).rejects.toThrow('refusing to remove');
    expect(await Bun.file(target).text()).toBe('#!/bin/sh\necho not ours\n');
  });

  test('reports a foreign symlink with its destination', async () => {
    const directory = await binDir();
    const target = path.join(directory, commandName);
    await fs.mkdir(directory, { recursive: true });
    await fs.symlink('/usr/bin/true', target);

    expect(await status(directory)).toEqual({
      state: 'foreign', path: target, source: commandSource, detail: 'a symlink to /usr/bin/true',
    });
    await expect(install(directory)).rejects.toThrow('refusing to replace');
    await expect(uninstall(directory)).rejects.toThrow('not this checkout\'s bare-claude');
  });

  test('a dangling symlink is foreign, not installed', async () => {
    const directory = await binDir();
    const target = path.join(directory, commandName);
    await fs.mkdir(directory, { recursive: true });
    await fs.symlink('/nonexistent/bare-claude.ts', target);

    expect((await status(directory)).state).toBe('foreign');
  });

  test('replaces a foreign entry only when forced', async () => {
    const directory = await binDir();
    const target = path.join(directory, commandName);
    await fs.mkdir(directory, { recursive: true });
    await fs.symlink('/usr/bin/true', target);

    expect(await install(directory, { force: true })).toEqual({
      state: 'replaced', path: target, source: commandSource,
    });
    expect((await status(directory)).state).toBe('installed');
  });

  test('never replaces a directory, even when forced', async () => {
    const directory = await binDir();
    const target = path.join(directory, commandName);
    await fs.mkdir(target, { recursive: true });

    expect((await status(directory)).state).toBe('foreign');
    await expect(install(directory, { force: true })).rejects.toThrow('it is a directory');
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });
});
