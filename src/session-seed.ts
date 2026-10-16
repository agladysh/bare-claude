import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, fstatSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readSync, realpathSync, rmSync, type BigIntStats,
} from 'node:fs';
import path from 'node:path';

/**
 * A continued session seeded from a journal file rather than from memory.
 *
 * `customSessionData.sourcePath` names a prior journal the caller keeps. The
 * resumed run needs a writable journal of its own under its own Claude home;
 * this module publishes one without writing to the source, as a copy-on-write
 * clone on the same filesystem, so the two share every existing byte and each
 * appends independently afterwards.
 *
 * File seeds are supported only on macOS and Linux. Bun 1.3.13's
 * `copyFileInner` uses clonefile/ioctl_ficlone for a forced clone there,
 * while its Windows branch calls CopyFileW without enforcing that flag.
 *
 * There is no byte-copy fallback. A filesystem that cannot clone, a source on
 * another filesystem, a source that changes while it is read, and a journal
 * already at the destination are all refusals, made before anything is
 * published. Callers who mean to allocate the bytes have the in-memory
 * `customSessionData.value` route.
 *
 * The checks assume the caller owns both the source's directory and the
 * destination's. Nothing here defends against a directory being swapped
 * between two checks: this is not a filesystem compare-and-swap.
 */

/**
 * A file a spawn published, by path and identity, so that taking it back can
 * check it is still that file.
 */
export interface PublishedFile {
  path: string,
  dev: bigint,
  ino: bigint,
}

/**
 * A seeded journal as published: the file, and the size and SHA-256 of
 * exactly the bytes put in it before the spawn. Whatever follows them was
 * appended afterwards.
 */
export interface PublishedSeed extends PublishedFile {
  bytes: number,
  sha256: string,
}

/** A full lowercase SHA-256 hex digest, the only form `sourceSha256` takes. */
export const sha256Pattern = /^[a-f0-9]{64}$/;

/** Narrows a thrown value to the errno `code` a Node filesystem error carries. */
function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown error';
}

/** Whether anything, a dangling symlink included, is at `filePath`. */
function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** One version of a file: any write moves its size, mtime or ctime. */
function identity(stats: BigIntStats): string {
  return [ stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs ].join(':');
}

/** SHA-256 of everything readable through `fd`, from offset 0. */
function digest(fd: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(128 * 1024);
  let offset = 0;
  while (true) {
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    if (read === 0) {
      return hash.digest('hex');
    }
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
}

/** Throws when `filePath`, or any directory above it, is a symbolic link. */
function refuseLinkedPath(filePath: string): void {
  for (let part = path.resolve(filePath); ; part = path.dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) {
      throw new Error(`session seed path ${filePath} passes through a symbolic link at ${part}`);
    }
    if (path.dirname(part) === part) {
      return;
    }
  }
}

/**
 * Publishes a writable copy-on-write clone of `sourcePath` at `destination`.
 *
 * The source must be a regular file with exactly one link — a second name
 * could write it from outside the caller's custody — and not a symbolic link.
 * Directory aliases above it, such as macOS `/var`, are resolved first. The
 * source is hashed, cloned into a private staging directory beside the
 * destination, the clone is hashed, the source is checked unchanged, and only
 * then is the clone hard-linked into place, which fails rather than replace a
 * file already there. The staging directory is removed on every path.
 * @param sourcePath - The prior journal, which is never written
 * @param destination - Where the new journal goes; must not exist
 * @param expectedSha256 - Digest the source must have, when the caller
 *   recorded one
 * @returns The published journal: its real path and its identity, taken from
 *   the staged clone before it was linked into place, and the size and
 *   digest of the bytes cloned, which the clone was checked to match
 * @throws When any of the above does not hold; nothing is left at
 *   `destination` then
 */
export function cloneSessionSeed(sourcePath: string, destination: string, expectedSha256?: string): PublishedSeed {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(
      `copy-on-write session seeds are unsupported on ${process.platform}; no byte copy is made`
    );
  }

  if (expectedSha256 !== undefined && !sha256Pattern.test(expectedSha256)) {
    throw new Error('session seed sourceSha256 must be a full lowercase SHA-256 hex digest');
  }

  const source = path.join(realpathSync(path.dirname(sourcePath)), path.basename(sourcePath));
  refuseLinkedPath(source);
  const before = lstatSync(source, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) {
    throw new Error(`session seed ${source} must be a regular file with a single link`);
  }

  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let staging: string | null = null;
  try {
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) {
      throw new Error(`session seed ${source} changed before it was opened`);
    }
    const sha256 = digest(fd);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new Error(`session seed ${source} does not match the expected SHA-256`);
    }
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) {
      throw new Error(`session seed ${source} changed while it was read`);
    }

    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const parent = realpathSync(path.dirname(destination));
    refuseLinkedPath(parent);
    const target = path.join(parent, path.basename(destination));
    if (pathExists(target)) {
      throw new Error(`session journal ${target} already exists; a seed never overwrites one`);
    }
    if (lstatSync(parent, { bigint: true }).dev !== before.dev) {
      throw new Error(
        `session seed ${source} is not on the filesystem of ${parent}; `
        + 'a copy-on-write clone cannot cross filesystems, and no byte copy is made'
      );
    }

    staging = mkdtempSync(path.join(parent, '.session-seed-'));
    const staged = path.join(staging, 'journal');
    try {
      copyFileSync(source, staged, constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      throw new Error(
        `copy-on-write clone of session seed ${source} failed (${errorCode(error)}); no byte copy is made`
      );
    }
    chmodSync(staged, 0o600);

    const clone = openSync(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (digest(clone) !== sha256) {
        throw new Error(`clone of session seed ${source} differs from its source`);
      }
    } finally {
      closeSync(clone);
    }

    refuseLinkedPath(source);
    if (identity(lstatSync(source, { bigint: true })) !== identity(before)
      || identity(fstatSync(fd, { bigint: true })) !== identity(before)
      || digest(fd) !== sha256) {
      throw new Error(`session seed ${source} changed while it was cloned`);
    }

    // The staging directory is private to this call, so the file there is
    // the clone, and a hard link keeps its identity.
    const published = lstatSync(staged, { bigint: true });
    try {
      linkSync(staged, target);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new Error(`session journal ${target} already exists; a seed never overwrites one`);
      }
      throw error;
    }
    // The source was unchanged throughout, so its size is the size of the bytes digested.
    return { path: target, dev: published.dev, ino: published.ino, bytes: Number(before.size), sha256 };
  } finally {
    closeSync(fd);
    if (staging !== null) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}
