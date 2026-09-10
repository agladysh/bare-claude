/**
 * Black-box tests of `bin/install-bare-claude.ts` — the `install:user`,
 * `install:status` and `install:uninstall` package scripts — run as a real
 * subprocess against a temporary bin directory. The library it wraps is
 * covered in `src/install.test.ts`; this checks the one-line output and the
 * exit codes a shell script would key on.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const installerPath = path.join(import.meta.dir, '..', 'bin', 'install-bare-claude.ts');
const sourcePath = path.join(import.meta.dir, '..', 'bin', 'bare-claude.ts');

const roots: string[] = [];

async function binDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-installer-cli-'));
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

async function runInstaller(args: string[]): Promise<{ exitCode: number, stdout: string, stderr: string }> {
  const subprocess = Bun.spawn({
    cmd: [ 'bun', installerPath, ...args ],
    cwd: os.tmpdir(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [ stdout, stderr, exitCode ] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('install-bare-claude', () => {
  test('status exits 1 while nothing is installed, and 0 once it is', async () => {
    const directory = await binDir();
    const target = path.join(directory, 'bare-claude');

    const before = await runInstaller([ 'status', '--bin-dir', directory ]);
    expect(before.exitCode).toBe(1);
    expect(before.stdout).toBe(`absent: ${target}\n`);

    const installed = await runInstaller([ 'install', '--bin-dir', directory ]);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toBe(`installed: ${target} -> ${sourcePath}\n`);

    const after = await runInstaller([ 'status', '--bin-dir', directory ]);
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toBe(`installed: ${target} -> ${sourcePath}\n`);

    const removed = await runInstaller([ 'uninstall', '--bin-dir', directory ]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toBe(`removed: ${target}\n`);
  });

  test('install is the default action', async () => {
    const directory = await binDir();
    const result = await runInstaller([ '--bin-dir', directory ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith('installed: ')).toBe(true);
  });

  test('a foreign file is reported by status and refused by install without --force', async () => {
    const directory = await binDir();
    const target = path.join(directory, 'bare-claude');
    await fs.mkdir(directory, { recursive: true });
    await Bun.file(target).write('not ours\n');

    const status = await runInstaller([ 'status', '--bin-dir', directory ]);
    expect(status.exitCode).toBe(1);
    expect(status.stdout).toBe(`foreign: ${target} is not a symlink, not a symlink to ${sourcePath}\n`);

    const refused = await runInstaller([ 'install', '--bin-dir', directory ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('refusing to replace');
    expect(await Bun.file(target).text()).toBe('not ours\n');

    const forced = await runInstaller([ 'install', '--force', '--bin-dir', directory ]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toBe(`replaced: ${target} -> ${sourcePath}\n`);
  });

  test('an unknown action or option is a usage error, exit 2', async () => {
    const directory = await binDir();

    const action = await runInstaller([ 'frobnicate', '--bin-dir', directory ]);
    expect(action.exitCode).toBe(2);
    expect(action.stderr).toContain('unknown action: frobnicate');
    expect(action.stderr).toContain('usage:');

    const option = await runInstaller([ 'status', '--nope', '--bin-dir', directory ]);
    expect(option.exitCode).toBe(2);
    expect(option.stderr).toContain('usage:');
  });
});
