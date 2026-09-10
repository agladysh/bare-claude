import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Puts the CLI on `PATH` as a symlink into this checkout.
 *
 * One symlink, `<binDir>/bare-claude -> bin/bare-claude.ts`, and nothing else:
 * no copy, no wrapper script, so an edit to the source is live without a
 * reinstall, and `uninstall` can prove what it removes is ours. Modelled on
 * the estate's `sc-tool` installer. Whatever else sits at the install path is
 * *foreign* — reported, never overwritten unless the caller says `force`, and
 * never removed.
 *
 * The symlink works because `bin/bare-claude.ts` carries a `#!/usr/bin/env bun`
 * shebang and Bun realpaths its entry point before choosing a loader: measured
 * 2026-09-11 on Bun 1.3.13, an extension-less symlink to a `.ts` file runs as
 * TypeScript, and package-relative imports resolve against the real location.
 */

/** Name of the command as installed on `PATH`. */
export const commandName = 'bare-claude';

/** What the installed command links to: this checkout's CLI entry point. */
export const commandSource = path.resolve(import.meta.dir, '..', 'bin', 'bare-claude.ts');

/**
 * What sits at the install path. `foreign` is anything that is not a symlink
 * resolving to {@link commandSource}: another symlink, a regular file, a
 * directory, or a dangling link left behind by a moved checkout.
 */
export type InstallStatus =
  | { state: 'installed', path: string, source: string }
  | { state: 'absent', path: string, source: string }
  | { state: 'foreign', path: string, source: string, detail: string };

/** What {@link install} did. */
export interface InstallResult {
  state: 'installed' | 'already-installed' | 'replaced',
  path: string,
  source: string,
}

/** What {@link uninstall} did. */
export interface UninstallResult {
  state: 'removed' | 'absent',
  path: string,
  source: string,
}

/** Options for {@link install}. */
export interface InstallOptions {
  /**
   * Replace a foreign symlink or regular file at the install path. A directory
   * is never replaced, forced or not. Defaults to false.
   */
  force?: boolean,
}

/**
 * The conventional per-user bin directory, `~/.local/bin`.
 * @param env - Environment to read `HOME` from; defaults to the process environment
 * @throws When `HOME` is unset or blank
 */
export function defaultBinDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME;
  if (home === undefined || home.trim() === '') {
    throw new Error('HOME is not set, so ~/.local/bin cannot be located; pass --bin-dir');
  }
  return path.join(home, '.local', 'bin');
}

/** Narrows a thrown value to a Node error carrying the given `code`. */
function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Whether `target` resolves to the same file as {@link commandSource}. */
async function pointsToSource(target: string): Promise<boolean> {
  try {
    const [ actual, source ] = await Promise.all([ fs.realpath(target), fs.realpath(commandSource) ]);
    return actual === source;
  } catch {
    return false; // Dangling, or the source itself is gone.
  }
}

/** The install path for a bin directory. */
function targetIn(binDir: string): string {
  return path.join(path.resolve(binDir), commandName);
}

/**
 * Reports what is at `<binDir>/bare-claude` without touching it.
 * @param binDir - Directory the command is expected in
 */
export async function status(binDir: string): Promise<InstallStatus> {
  const target = targetIn(binDir);

  let entry;
  try {
    entry = await fs.lstat(target);
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) {
      return { state: 'absent', path: target, source: commandSource };
    }
    throw error;
  }

  if (entry.isSymbolicLink() && await pointsToSource(target)) {
    return { state: 'installed', path: target, source: commandSource };
  }

  const detail = entry.isSymbolicLink()
    ? `a symlink to ${await fs.readlink(target)}`
    : entry.isDirectory() ? 'a directory' : 'not a symlink';

  return { state: 'foreign', path: target, source: commandSource, detail };
}

/**
 * Symlinks this checkout's CLI into `binDir`, creating the directory as
 * needed. Idempotent: an existing correct link is reported, not recreated.
 * @param binDir - Directory to install into
 * @param options - See {@link InstallOptions}
 * @throws When the install path holds something foreign and `force` is not
 *   set, or a directory regardless
 */
export async function install(binDir: string, options: InstallOptions = {}): Promise<InstallResult> {
  const current = await status(binDir);
  const { path: target, source } = current;

  await fs.mkdir(path.dirname(target), { recursive: true });

  // The shebang only takes effect on an executable file. Git tracks the mode,
  // but a checkout is not the only way this file arrives on a machine.
  await fs.chmod(source, 0o755);

  switch (current.state) {
    case 'installed':
      return { state: 'already-installed', path: target, source };

    case 'foreign': {
      if (current.detail === 'a directory') {
        throw new Error(`refusing to replace ${target}: it is a directory`);
      }
      if (!options.force) {
        throw new Error(`refusing to replace ${target}: it is ${current.detail}; pass --force to replace it`);
      }
      await fs.unlink(target);
      await fs.symlink(source, target);
      return { state: 'replaced', path: target, source };
    }

    case 'absent':
      await fs.symlink(source, target);
      return { state: 'installed', path: target, source };
  }
}

/**
 * Removes `<binDir>/bare-claude`, but only when it is this checkout's symlink.
 * @param binDir - Directory to uninstall from
 * @throws When the install path holds something foreign
 */
export async function uninstall(binDir: string): Promise<UninstallResult> {
  const current = await status(binDir);
  const { path: target, source } = current;

  switch (current.state) {
    case 'absent':
      return { state: 'absent', path: target, source };

    case 'foreign':
      throw new Error(
        `refusing to remove ${target}: it is ${current.detail}, not this checkout's ${commandName}`
      );

    case 'installed':
      await fs.unlink(target);
      return { state: 'removed', path: target, source };
  }
}
