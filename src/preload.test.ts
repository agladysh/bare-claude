import { describe, expect, test } from 'bun:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { emitPreload, file, glob, inline, ls, shell, type Spent } from './preload.ts';
import { SessionBuilder } from './SessionBuilder.ts';

function build(): SessionBuilder {
  return new SessionBuilder('session-1', '2.1.220', '/tmp/project', 'main', 'test-model');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Every content block across a committed session, in order. */
function allBlocks(records: unknown[]): Record<string, unknown>[] {
  return records.flatMap(record => {
    if (!isRecord(record) || !isRecord(record.message) || !Array.isArray(record.message.content)) {
      return [];
    }
    return record.message.content.filter(isRecord);
  });
}

/** Names of the tools whose calls appear in a committed session. */
function toolNames(records: unknown[]): string[] {
  return allBlocks(records).filter(b => b.type === 'tool_use').map(b => String(b.name));
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-preload-test-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('emitPreload', () => {
  test('lands a file as a Read call and counts its bytes', async () => {
    await withTempDir(async dir => {
      await Bun.write(path.join(dir, 'a.txt'), 'alpha\nbeta\n');
      const builder = build();
      const spent: Spent = { bytes: 0 };

      await emitPreload(builder, file('a.txt'), { cwd: dir }, spent);

      expect(toolNames(builder.commit())).toEqual([ 'Read' ]);
      expect(spent.bytes).toBe(11);
    });
  });

  test('lands shell output as a real Bash tool result', async () => {
    await withTempDir(async dir => {
      const builder = build();
      const spent: Spent = { bytes: 0 };

      await emitPreload(builder, shell('echo hello', 'greet'), { cwd: dir }, spent);
      const records = builder.commit();

      expect(toolNames(records)).toEqual([ 'Bash' ]);
      expect(allBlocks(records).find(b => b.type === 'tool_result')?.content).toBe('hello\n');
    });
  });

  test('lands a listing as a Bash tool result', async () => {
    await withTempDir(async dir => {
      await Bun.write(path.join(dir, 'a.txt'), 'x');
      const builder = build();

      await emitPreload(builder, ls('.'), { cwd: dir }, { bytes: 0 });

      expect(toolNames(builder.commit())).toEqual([ 'Bash' ]);
    });
  });

  test('lands inline text as a framing conversation turn, not a tool call', async () => {
    const builder = build();

    await emitPreload(builder, inline('remember this', 'Brief'), { cwd: process.cwd() }, { bytes: 0 });
    const records = builder.commit();

    expect(toolNames(records)).toEqual([]);
    expect(records.some(r => r.type === 'user'
      && String(r.message?.content).startsWith('# Brief'))).toBe(true);
  });

  test('skips an over-budget entry whole rather than truncating it', async () => {
    await withTempDir(async dir => {
      await Bun.write(path.join(dir, 'big.txt'), 'x'.repeat(100));
      const builder = build();
      const spent: Spent = { bytes: 0 };

      await emitPreload(builder, file('big.txt'), { cwd: dir, maxBytes: 10 }, spent);

      expect(toolNames(builder.commit())).toEqual([]);
      expect(spent.bytes).toBe(0);
    });
  });

  test('shares one budget across entries, admitting what still fits', async () => {
    await withTempDir(async dir => {
      await Bun.write(path.join(dir, 'a.txt'), 'x'.repeat(8));
      await Bun.write(path.join(dir, 'b.txt'), 'y'.repeat(8));
      const builder = build();
      const spent: Spent = { bytes: 0 };
      const context = { cwd: dir, maxBytes: 10 };

      await emitPreload(builder, file('a.txt'), context, spent);
      await emitPreload(builder, file('b.txt'), context, spent);

      expect(toolNames(builder.commit())).toEqual([ 'Read' ]);
      expect(spent.bytes).toBe(8);
    });
  });

  test('skips a missing file without aborting the preload', async () => {
    await withTempDir(async dir => {
      const builder = build();

      await emitPreload(builder, file('nope.txt'), { cwd: dir }, { bytes: 0 });

      expect(toolNames(builder.commit())).toEqual([]);
    });
  });

  test('preloads the output of a failing command anyway', async () => {
    await withTempDir(async dir => {
      const builder = build();

      await emitPreload(builder, shell('echo out; exit 3'), { cwd: dir }, { bytes: 0 });
      const records = builder.commit();

      expect(toolNames(records)).toEqual([ 'Bash' ]);
      expect(allBlocks(records).find(b => b.type === 'tool_result')?.is_error).toBe(true);
    });
  });

  test('flattens a glob into one Read per matching file', async () => {
    await withTempDir(async dir => {
      await Bun.write(path.join(dir, 'a.txt'), 'a');
      await Bun.write(path.join(dir, 'b.txt'), 'b');
      await Bun.write(path.join(dir, 'c.md'), 'c');
      await Bun.$`git init -q .`.cwd(dir).quiet();
      const builder = build();

      await emitPreload(builder, glob('*.txt'), { cwd: dir }, { bytes: 0 });

      expect(toolNames(builder.commit())).toEqual([ 'Read', 'Read' ]);
    });
  });
});
