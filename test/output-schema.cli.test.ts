/**
 * Black-box tests of `--output-schema`: the real CLI against the fake
 * `claude`, which writes whatever result a test constructs. Results follow the
 * shapes observed 2026-11-22 of claude 2.1.328 under `--output-format json`:
 * a conforming answer, a give-up, and, with native verbose, either as the
 * last element of an array of the run's messages. Every value is
 * constructed. No model, no network.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from './helpers.ts';

// Each test starts the CLI up to three times; under the whole suite's load one
// start has taken over 5 s.
setDefaultTimeout(20_000);

const conforming = { type: 'result', subtype: 'success', is_error: false, structured_output: { answer: 'ok' }, result: '{"answer":"ok"}' };
const gaveUp = {
  type: 'result', subtype: 'error_max_structured_output_retries', is_error: true,
  terminal_reason: 'structured_output_retry_exhausted', errors: [ 'constructed: no valid structured output' ],
};
const unstructured = { type: 'result', subtype: 'success', is_error: false, result: 'free text' };
/** What precedes the result in native's verbose array; the types as observed, the contents constructed. */
const verboseMessages = [ { type: 'system', subtype: 'init' }, { type: 'assistant' }, { type: 'user' } ];
const verbose = (result: Record<string, unknown> | null) => JSON.stringify(result === null ? verboseMessages : [ ...verboseMessages, result ]);
const schemaText ='{ "type": "object", "required": ["answer"], "additionalProperties": false,\n  "properties": { "answer": { "type": "string" } } }\n';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A directory to run in, holding the schema file, and where the fake writes its argv. */
async function setUp(): Promise<{ cwd: string, schema: string, argvFile: string }> {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-output-schema-cli-')));
  dirs.push(cwd);
  const schema = path.join(cwd, 'form.json');
  await fs.writeFile(schema, schemaText);
  return { cwd, schema, argvFile: path.join(cwd, 'argv.json') };
}

/** The argv the fake was given, or null when it never ran. */
async function argvOf(file: string): Promise<string[] | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

const base = [ '--no-config', '--auth', 'caller', '--quiet' ];

describe('a live run with --output-schema', () => {
  test('a conforming answer exits 0; the schema text is passed verbatim, with --output-format json asked for', async () => {
    const { cwd, schema, argvFile } = await setUp();
    const run = await runCli([ ...base, '--output-schema', schema, 'fill the form' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: JSON.stringify(conforming), FAKE_CLAUDE_ARGV_FILE: argvFile },
    });
    expect(run.stderr).not.toContain('output schema');
    expect(run.exitCode).toBe(0);
    const argv = await argvOf(argvFile) ?? [];
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe(schemaText);
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('json');
    expect(argv.slice(-2)).toEqual([ '--print', 'fill the form' ]);
  });

  test('a native give-up exits 65, whatever claude exited with, and says so on stderr', async () => {
    const { cwd, schema } = await setUp();
    for (const code of [ '0', '1' ]) {
      const run = await runCli([ ...base, '--output-schema', schema, 'fill the form' ], {
        cwd, env: { FAKE_CLAUDE_STDOUT: JSON.stringify(gaveUp), FAKE_CLAUDE_EXIT_CODE: code },
      });
      expect(run.exitCode).toBe(65);
      expect(run.stderr).toContain('output schema: not-conforming');
    }
  });

  test('no structured answer exits 66 when claude exited 0, and keeps claude\'s own failure otherwise', async () => {
    const { cwd, schema } = await setUp();
    const unanswered = await runCli([ ...base, '--output-schema', schema, 'fill the form' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: JSON.stringify(unstructured) },
    });
    expect(unanswered.exitCode).toBe(66);
    expect(unanswered.stderr).toContain('no-final-message (no-structured-output)');

    const failed = await runCli([ ...base, '--output-schema', schema, 'fill the form' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: 'Not logged in\n', FAKE_CLAUDE_EXIT_CODE: '1' },
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('no-final-message (unreadable-result)');
  });

  test('native verbose, forwarded: the array is read by its final result, and no final result is still a finding', async () => {
    const { cwd, schema, argvFile } = await setUp();
    const args = [ ...base, '--claude-arg=--verbose', '--output-schema', schema, 'fill the form' ];
    const answered = await runCli(args, { cwd, env: { FAKE_CLAUDE_STDOUT: verbose(conforming), FAKE_CLAUDE_ARGV_FILE: argvFile } });
    expect(answered.stderr).not.toContain('output schema');
    expect(answered.exitCode).toBe(0);
    expect(await argvOf(argvFile)).toContain('--verbose');

    const gaveUpVerbose = await runCli(args, { cwd, env: { FAKE_CLAUDE_STDOUT: verbose(gaveUp), FAKE_CLAUDE_EXIT_CODE: '1' } });
    expect(gaveUpVerbose.exitCode).toBe(65);

    const unended = await runCli(args, { cwd, env: { FAKE_CLAUDE_STDOUT: verbose(null) } });
    expect(unended.exitCode).toBe(66);
    expect(unended.stderr).toContain('no-final-message (unreadable-result)');
    expect(unended.stderr).toContain('last element is not a Claude Code result object');
  });

  test('--print still passes the result through, read whole for the exit status', async () => {
    const { cwd, schema } = await setUp();
    const run = await runCli([ ...base, '--print', '--output-schema', schema, 'fill the form' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: JSON.stringify(conforming) },
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(conforming);
  });

  test('a forwarded --output-format json is kept as the one format', async () => {
    const { cwd, schema, argvFile } = await setUp();
    const run = await runCli([ ...base, '--claude-arg=--output-format=json', '--output-schema', schema, 'x' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: JSON.stringify(conforming), FAKE_CLAUDE_ARGV_FILE: argvFile },
    });
    expect(run.exitCode).toBe(0);
    const argv = await argvOf(argvFile) ?? [];
    expect(argv.filter(arg => arg.startsWith('--output-format'))).toEqual([ '--output-format=json' ]);
  });

  test('without --output-schema the run is unchanged: no schema, no output format, claude\'s own exit', async () => {
    const { cwd, argvFile } = await setUp();
    const run = await runCli([ ...base, 'hello' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: JSON.stringify(unstructured), FAKE_CLAUDE_ARGV_FILE: argvFile },
    });
    expect(run.exitCode).toBe(0);
    const argv = await argvOf(argvFile) ?? [];
    expect(argv).not.toContain('--json-schema');
    expect(argv.some(arg => arg.startsWith('--output-format'))).toBe(false);
  });
});

describe('refused before anything is spawned', () => {
  const cases: [ string, (dir: string, schema: string) => Promise<string[]>, string ][] = [
    [ 'a missing file', async dir => [ '--output-schema', path.join(dir, 'missing.json') ], 'cannot be read' ],
    [ 'a file that is not JSON', async dir => {
      const file = path.join(dir, 'broken.json');
      await fs.writeFile(file, '{ "type": ');
      return [ '--output-schema', file ];
    }, 'is not one JSON document' ],
    [ 'JSON that is not an object', async dir => {
      const file = path.join(dir, 'list.json');
      await fs.writeFile(file, '[]');
      return [ '--output-schema', file ];
    }, 'is not a JSON object' ],
    [ '--json-schema forwarded beside it', async (_, schema) => [ '--claude-arg=--json-schema={}', '--output-schema', schema ], 'two schemas' ],
    [ 'another output format forwarded', async (_, schema) => [ '--claude-arg=--output-format=text', '--output-schema', schema ], '--output-format text was forwarded' ],
  ];
  for (const [ name, args, message ] of cases) {
    test(name, async () => {
      const { cwd, schema, argvFile } = await setUp();
      const run = await runCli([ ...base, ...await args(cwd, schema), 'x' ], { cwd, env: { FAKE_CLAUDE_ARGV_FILE: argvFile } });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(message);
      expect(await argvOf(argvFile)).toBeNull();
    });
  }

  test('a preset cannot carry it: a configuration naming outputSchemaFile is refused', async () => {
    const { cwd, schema, argvFile } = await setUp();
    const config = path.join(cwd, 'run.yaml');
    await fs.writeFile(config, `outputSchemaFile: ${schema}\n`);
    const run = await runCli([ '--config', config, '--auth', 'caller', '--quiet', 'x' ], { cwd, env: { FAKE_CLAUDE_ARGV_FILE: argvFile } });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('outputSchemaFile');
    expect(await argvOf(argvFile)).toBeNull();
  });
});

describe.if(process.platform === 'darwin' || process.platform === 'linux')('--output-schema under --custody', () => {
  test('the exit status is the directory\'s own schema outcome, which --outcome-custody reports', async () => {
    const { cwd, schema } = await setUp();
    const directory = path.join(cwd, 'run');
    const run = await runCli([ ...base, '--custody', directory, '--output-schema', schema, 'x' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: JSON.stringify(gaveUp), FAKE_CLAUDE_EXIT_CODE: '1' },
    });
    expect(run.exitCode).toBe(65);

    const read = await runCli([ '--outcome-custody', directory ], { cwd });
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      schema: { kind: 'not-conforming', enforcedBy: 'native', errors: [ 'constructed: no valid structured output' ], finalMessage: null },
      invocation: { record: { extraArgs: [ '--output-format', 'json' ], outputSchema: { kept: path.join(directory, 'output-schema.json') } } },
    });
    const brief = await runCli([ '--outcome-custody', directory, '--brief' ], { cwd });
    expect(JSON.parse(brief.stdout)).toMatchObject({ schema: { kind: 'not-conforming', enforcedBy: 'native', reason: null } });
  });

  test('a conforming answer under custody exits 0', async () => {
    const { cwd, schema } = await setUp();
    const run = await runCli([ ...base, '--custody', path.join(cwd, 'run'), '--output-schema', schema, 'x' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: JSON.stringify(conforming) },
    });
    expect(run.exitCode).toBe(0);
  });

  test('native verbose under custody: a conforming array exits 0, read as the array, the schema named by its digest', async () => {
    const { cwd, schema } = await setUp();
    const directory = path.join(cwd, 'run');
    const run = await runCli([ ...base, '--custody', directory, '--claude-arg=--verbose', '--output-schema', schema, 'x' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: verbose(conforming) },
    });
    expect(run.exitCode).toBe(0);

    const digest = new Bun.CryptoHasher('sha256').update(schemaText).digest('hex');
    const read = await runCli([ '--outcome-custody', directory ], { cwd });
    expect(JSON.parse(read.stdout)).toMatchObject({
      schema: { kind: 'conforming', enforcedBy: 'native', value: { answer: 'ok' }, schemaSha256: digest },
      stdout: { result: { status: 'read', reading: { file: 'result', form: 'array' } } },
      invocation: { record: { outputSchema: { sha256: digest } } },
    });

    const unended = await runCli([ ...base, '--custody', path.join(cwd, 'unended'), '--claude-arg=--verbose', '--output-schema', schema, 'x' ], {
      cwd, env: { FAKE_CLAUDE_STDOUT: verbose(null) },
    });
    expect(unended.exitCode).toBe(66);
  });
});

describe('offline readers', () => {
  test('--outcome with --outcome-schema reports the schema outcome; without it the reading has none', async () => {
    const { cwd } = await setUp();
    const file = path.join(cwd, 'result.json');
    await fs.writeFile(file, JSON.stringify(conforming));
    const withSchema = await runCli([ '--outcome', file, '--outcome-schema' ], { cwd });
    expect(withSchema.exitCode).toBe(0);
    // A bare result file does not say which schema it answered.
    expect(JSON.parse(withSchema.stdout)).toMatchObject({
      result: { form: 'object', schema: { kind: 'conforming', value: { answer: 'ok' }, schemaSha256: null } },
    });
    const without = await runCli([ '--outcome', file ], { cwd });
    expect(JSON.parse(without.stdout).result).not.toHaveProperty('schema');
  });

  test('--outcome reads a verbose array by its final result', async () => {
    const { cwd } = await setUp();
    const file = path.join(cwd, 'result.json');
    await fs.writeFile(file, verbose(gaveUp));
    const run = await runCli([ '--outcome', file, '--outcome-schema' ], { cwd });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      result: { file: 'result', form: 'array', status: 'error', schema: { kind: 'not-conforming', finalMessage: null } },
    });
  });

  test('--outcome-schema needs --outcome', async () => {
    const { cwd } = await setUp();
    const run = await runCli([ '--outcome-schema', '--journal', path.join(cwd, 'j.jsonl') ], { cwd });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('--outcome-schema needs --outcome');
  });

  test('--outcome-batch reads a line that declares the schema', async () => {
    const { cwd } = await setUp();
    const file = path.join(cwd, 'result.json');
    await fs.writeFile(file, JSON.stringify(gaveUp));
    const run = await runCli([ '--outcome-batch', '-' ], {
      cwd, stdin: `${JSON.stringify({ id: 's', result: file, outputSchema: true })}\n${JSON.stringify({ id: 'p', result: file })}\n`,
    });
    expect(run.exitCode).toBe(0);
    const [ declared, plain ] = run.stdout.trim().split('\n').map((line): unknown => JSON.parse(line));
    expect(declared).toMatchObject({ id: 's', reading: { result: { schema: { kind: 'not-conforming' } } } });
    expect(plain).toMatchObject({ id: 'p', reading: { result: { status: 'error' } } });
    expect(plain).not.toHaveProperty('reading.result.schema');
  });
});
