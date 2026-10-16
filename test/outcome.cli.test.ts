/**
 * Black-box `--outcome`, `--journal` and `--outcome-batch` tests: the real CLI
 * against files written into a temporary directory. Every record is
 * constructed for these tests; nothing comes from a retained run. No model,
 * no network, no Git working copy needed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from './helpers.ts';

const session = 'session-constructed-1';
const result = {
  type: 'result', subtype: 'success', is_error: true, terminal_reason: 'blocking_limit',
  result: 'Prompt is too long', stop_reason: 'stop_sequence', safety_stops: 0,
  duration_api_ms: 200000, total_cost_usd: 20.25, session_id: session,
  usage: { output_tokens: 700, iterations: [ { input_tokens: 3, cache_creation_input_tokens: 2000, cache_read_input_tokens: 900000, output_tokens: 700 } ] },
};
const journalRows = [
  { type: 'assistant', sessionId: session, version: '2.1.292', uuid: 'a1', message: { model: 'constructed-model', content: [], usage: { input_tokens: 3, cache_creation_input_tokens: 2000, cache_read_input_tokens: 900000, output_tokens: 700 } } },
  { type: 'assistant', sessionId: session, version: '2.1.292', uuid: 'e1', isApiErrorMessage: true, error: 'invalid_request', message: { model: '<synthetic>', content: [ { type: 'text', text: 'Prompt is too long' } ] } },
  { type: 'cost-state', sessionId: session, totalCostUSD: 20.25, totalAPIDuration: 200000 },
];

const dirs: string[] = [];

async function files(): Promise<{ dir: string, resultPath: string, journalPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-outcome-'));
  dirs.push(dir);
  const resultPath = path.join(dir, 'result.json');
  const journalPath = path.join(dir, 'session.jsonl');
  await fs.writeFile(resultPath, JSON.stringify(result));
  await fs.writeFile(journalPath, journalRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { dir, resultPath, journalPath };
}

afterAll(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('--outcome and --journal', () => {
  test('offline reading ignores composed launch configuration and creates no custody directory', async () => {
    const { dir, resultPath } = await files();
    const custody = path.join(dir, 'no-run');
    const run = await runCli([
      '--outcome', resultPath, '--config', path.join(dir, 'missing-profile.yaml'),
      '--config', path.join(dir, 'missing-run.yaml'), '--no-config', '--custody', custody,
    ], { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toMatchObject({ result: { status: 'error' }, journal: null });
    expect(await fs.stat(custody).then(() => true, () => false)).toBe(false);
  });

  test('read a result and its journal, and join them', async () => {
    const { dir, resultPath, journalPath } = await files();
    const run = await runCli([ '--outcome', resultPath, '--journal', journalPath ], { cwd: dir });
    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);
    const report: unknown = JSON.parse(run.stdout);
    expect(report).toMatchObject({
      result: { file: 'result', status: 'error', subtype: 'success', stopReason: 'stop_sequence', safetyStops: 0, contextLimit: { terminalReason: true, text: true } },
      journal: { versions: [ '2.1.292' ], openTail: false },
      join: { kind: 'joined', segment: 0, contextLimitRecord: 'e1', versions: [ '2.1.292' ] },
    });
  });

  test('--journal alone reads the journal', async () => {
    const { dir, journalPath } = await files();
    const run = await runCli([ '--journal', journalPath ], { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ result: null, join: null, journal: { lines: 3 } });
  });

  test('a file that cannot be read is exit 1, named on stderr', async () => {
    const { dir } = await files();
    const missing = path.join(dir, 'no-such-result.json');
    const run = await runCli([ '--outcome', missing ], { cwd: dir });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(missing);
  });
});

describe('--outcome-batch', () => {
  test('reads every request from stdin in one process, one line out per line in', async () => {
    const { dir, resultPath, journalPath } = await files();
    const lines = [
      JSON.stringify({ id: 'both', result: resultPath, journal: journalPath }),
      JSON.stringify({ id: 'journal', journal: journalPath }),
      'not json',
      JSON.stringify({ id: 'missing', result: path.join(dir, 'missing.json') }),
    ].join('\n') + '\n';
    const run = await runCli([ '--outcome-batch', '-' ], { cwd: dir, stdin: lines });
    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);
    const out: unknown[] = run.stdout.trim().split('\n').map((line): unknown => JSON.parse(line));
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ id: 'both', line: 1, error: null, reading: { join: { kind: 'joined' } } });
    expect(out[1]).toMatchObject({ id: 'journal', line: 2, reading: { result: null } });
    expect(out[2]).toMatchObject({ id: null, line: 3, reading: null });
    expect(out[3]).toMatchObject({ id: 'missing', line: 4, reading: null });
  });

  test('reads requests from a named file', async () => {
    const { dir, resultPath } = await files();
    const requests = path.join(dir, 'requests.jsonl');
    await fs.writeFile(requests, `${JSON.stringify({ id: 'r', result: resultPath })}\n`);
    const run = await runCli([ '--outcome-batch', requests ], { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toMatchObject({ id: 'r', reading: { result: { status: 'error' } } });
  });

  test('cannot be combined with --outcome or --journal', async () => {
    const { dir, resultPath } = await files();
    const run = await runCli([ '--outcome-batch', '-', '--outcome', resultPath ], { cwd: dir });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('--outcome-batch');
  });
});
