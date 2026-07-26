import { $ } from 'bun';

import path from 'node:path';

import { isBinaryFile } from 'isbinaryfile';

import type { SessionBuilder } from '@agladysh/bare-claude/SessionBuilder';

/**
 * Typed preload descriptors: the layer that turns a list of heterogeneous
 * entries into pre-executed turns of a synthetic session.
 *
 * One generalization out from `--read`, whose unit is a path. Here the unit is
 * a typed descriptor, and each kind lands through the tool-typed emit that
 * matches it — file and glob via `emitRead`, shell and ls via `emitBash` (a
 * real Bash tool result, not narration about one), inline via `emitContext`.
 * The model therefore sees work it appears to have already done, in the shapes
 * it would have produced itself.
 */

/**
 * Default raw-content-byte budget, the Opus 1M context floor. Measured on raw
 * content, before JSON escaping: budgeting serialized wire bytes would count
 * the escaping rather than the context.
 */
export const defaultMaxContentBytes = 2_880_000;

/**
 * One unit of preloaded context. `path` and `pattern` resolve against the
 * {@link PreloadContext} cwd; `cmd` runs there via `sh -c`; `text` is framing
 * prose.
 */
export type PreloadEntry =
  | { type: 'file', path: string }
  | { type: 'glob', pattern: string }
  | { type: 'shell', cmd: string, description?: string }
  | { type: 'ls', path: string }
  | { type: 'inline', text: string, label?: string };

/** Preloads a single file. */
export const file = (path: string): PreloadEntry => ({ type: 'file', path });

/** Preloads every non-ignored file matching a Git pathspec. */
export const glob = (pattern: string): PreloadEntry => ({ type: 'glob', pattern });

/** Preloads the output of a shell command as a Bash tool result. */
export const shell = (cmd: string, description?: string): PreloadEntry =>
  ({ type: 'shell', cmd, description });

/** Preloads a recursive directory listing as a Bash tool result. */
export const ls = (path: string): PreloadEntry => ({ type: 'ls', path });

/** Preloads literal text as a framing context turn. */
export const inline = (text: string, label?: string): PreloadEntry =>
  ({ type: 'inline', text, label });

/**
 * Where preload entries resolve.
 */
export interface PreloadContext {
  /** Directory paths, globs and shell commands resolve against. */
  cwd: string,

  /** Shared raw-content-byte budget. Defaults to {@link defaultMaxContentBytes}. */
  maxBytes?: number,
}

/** Running total of raw content bytes that actually landed. */
export interface Spent {
  bytes: number,
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Expands Git pathspecs to a file list — tracked plus untracked-not-ignored,
 * deduplicated — relative to `cwd`.
 * @param patterns - Git pathspec patterns
 * @param cwd - Directory to resolve against
 */
export async function globFilenames(
  patterns: string[],
  cwd: string = process.cwd()
): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }

  const output = await $`git ls-files --cached --others --exclude-standard --deduplicate -z -- ${patterns}`
    .cwd(cwd).text();

  return output.split('\0').filter(Boolean);
}

async function runShell(
  argv: string[],
  cwd: string
): Promise<{ stdout: string, stderr: string, exitCode: number }> {
  const result = await $`${argv}`.cwd(cwd).nothrow().quiet();
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

/**
 * Resolves one descriptor into an existing session, honoring a shared
 * raw-content-byte budget.
 *
 * Three deliberate behaviours: an entry over budget is skipped **whole**,
 * because a truncated file is a lie about what was read; a preload command
 * that exits nonzero warns and preloads its output anyway, because a preload
 * must not abort the run; and `glob` flattens to `file` entries so every
 * handler stays single-valued.
 *
 * @param builder - Session under construction
 * @param entry - The descriptor to resolve
 * @param context - Where it resolves, and the budget
 * @param spent - Accumulator for bytes that landed
 */
export async function emitPreload(
  builder: SessionBuilder,
  entry: PreloadEntry,
  context: PreloadContext,
  spent: Spent
): Promise<void> {
  const maxBytes = context.maxBytes ?? defaultMaxContentBytes;

  const fits = (n: number, label: string): boolean => {
    if (spent.bytes + n > maxBytes) {
      process.stderr.write(
        `bare-claude: preload ${label} is ${n} bytes, over the ${maxBytes}-byte budget `
        + `with ${spent.bytes} already spent; skipping whole.\n`
      );
      return false;
    }
    return true;
  };

  switch (entry.type) {
    case 'file': {
      const absolute = path.resolve(context.cwd, entry.path);
      const target = Bun.file(absolute);
      if (!await target.exists()) {
        process.stderr.write(`bare-claude: preload file "${entry.path}" does not exist; skipping.\n`);
        return;
      }
      if (await isBinaryFile(absolute)) {
        process.stderr.write(`bare-claude: preload file "${entry.path}" is binary; skipping.\n`);
        return;
      }
      const content = await target.text();
      const n = byteLength(content);
      if (!fits(n, `file ${entry.path}`)) {
        return;
      }
      // The authored path, not the absolute one: the model sees what the
      // caller wrote, matching the Git-relative filenames `--read` produces.
      builder.emitRead(entry.path, content);
      spent.bytes += n;
      return;
    }

    case 'glob': {
      for (const hit of await globFilenames([ entry.pattern ], context.cwd)) {
        await emitPreload(builder, { type: 'file', path: hit }, context, spent);
      }
      return;
    }

    case 'shell':
    case 'ls': {
      const argv = entry.type === 'ls' ? [ 'ls', '-lR', entry.path ] : [ 'sh', '-c', entry.cmd ];
      const command = entry.type === 'ls' ? `ls -lR ${entry.path}` : entry.cmd;
      const description = entry.type === 'ls'
        ? `list ${entry.path}`
        : (entry.description ?? entry.cmd);
      const result = await runShell(argv, context.cwd);
      if (result.exitCode !== 0) {
        process.stderr.write(
          `bare-claude: preload command "${command}" exited ${result.exitCode}; `
          + `preloading its output anyway.\n${result.stderr}`
        );
      }
      const n = byteLength(result.stdout);
      if (!fits(n, `command "${command}"`)) {
        return;
      }
      builder.emitBash(command, description, result);
      spent.bytes += n;
      return;
    }

    case 'inline': {
      const n = byteLength(entry.text);
      if (!fits(n, 'inline context')) {
        return;
      }
      builder.emitContext(entry.label ?? 'Context', entry.text, 'Context noted');
      spent.bytes += n;
      return;
    }
  }
}
