/**
 * Black-box `--display` tests: run the real `bin/bare-claude.ts` against a
 * committed session-JSONL fixture and assert on its stdout.
 *
 * `--display` renders and exits without ever touching a model or the
 * network, so these are as cheap as a unit test but exercise the actual CLI
 * argument parsing, file loading and `TranscriptRenderer` wiring — the path
 * `src/display.test.ts` cannot reach, since it calls the renderer directly.
 *
 * Fixtures live in `test/fixtures/`, one small file per shape, each derived
 * from a record shape seen in real `~/.claude/projects/**\/*.jsonl` sessions
 * (see the comment above each `describe` block for which one) and hand
 * redacted: no real paths, no real prompt or file content beyond harmless
 * placeholders, no ids that matter.
 *
 * Assertions deliberately check for substrings that carry meaning — a label,
 * a collapse count, a piece of content being present or absent — rather than
 * pinning a fixture's entire rendered output. Another agent is actively
 * changing how tool results are decorated; matching the whole transcript
 * verbatim would make these tests fail on a decoration change that broke
 * nothing.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { cliPath } from './helpers.ts';

const fixturesDir = path.join(import.meta.dir, 'fixtures');

/** Runs `--display <fixture>` and returns stdout. Exits 0 in every case here. */
async function display(fixture: string, extraArgs: string[] = []): Promise<string> {
  const subprocess = Bun.spawn({
    cmd: [ 'bun', cliPath, '--display', path.join(fixturesDir, fixture), ...extraArgs ],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [ stdout, stderr, exitCode ] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  return stdout;
}

// basic-turn.jsonl: shape of a top-level `user` record with a bare string
// `message.content`, followed by an `assistant` record with a one-block
// `message.content` array (`{ type: 'text' }`). Both envelopes (cwd,
// gitBranch, version, uuid/parentUuid chaining) mirror what a real session
// carries; every value that would identify a person, machine or repo was
// replaced with a placeholder.
describe('a user prompt plus an assistant reply', () => {
  test('renders both, in order', async () => {
    const out = await display('basic-turn.jsonl');
    const userAt = out.indexOf('What does the frobnicate module do?');
    const replyAt = out.indexOf('It normalizes widget identifiers before lookup.');

    expect(userAt).toBeGreaterThan(-1);
    expect(replyAt).toBeGreaterThan(userAt);
    expect(out).toContain('User');
    expect(out).toContain('Assistant');
  });
});

// tool-call-and-result.jsonl: shape of an `assistant` record whose one
// content block is `{ type: 'tool_use', name: 'Bash', ... }`, paired with the
// `user` record carrying the matching `tool_result` (real corpus shape: a
// `Bash` call's result content is the command's stdout as a plain string).
describe('a tool call with its paired result', () => {
  test('renders the call and its result', async () => {
    const out = await display('tool-call-and-result.jsonl');

    expect(out).toContain('Bash');
    expect(out).toContain('echo hello');
    expect(out).toContain('hello'); // The result of running it.
  });
});

// read-collapse.jsonl: shape of a `Read` tool_use paired with a tool_result
// whose content is real-format numbered text (`1\tline`, 1-based, one tab,
// no padding — the measured format in CLAUDE.md). Outside --verbose this
// collapses to a line count; --verbose expands it to the numbered text.
describe('a Read result outside and inside --verbose', () => {
  test('collapses to a line count by default', async () => {
    const out = await display('read-collapse.jsonl');

    expect(out).toContain('/repo/NOTES.md');
    expect(out).toMatch(/\[\d+ lines?\]/);
    expect(out).not.toContain('First distinctive line of content.');
  });

  test('expands to the file text under --verbose', async () => {
    const out = await display('read-collapse.jsonl', [ '--verbose' ]);

    expect(out).toContain('First distinctive line of content.');
    expect(out).toContain('Second distinctive line of content.');
    expect(out).toContain('Third distinctive line of content.');
  });
});

// mixed-content.jsonl: shape of an `assistant` record whose `message.content`
// mixes a `{ type: 'text' }` block with a `{ type: 'tool_use' }` block in one
// record — measured in the real corpus (11 records, all subagent transcripts
// or non-Opus models) and previously rendered as nothing at all under
// per-*event* dispatch, because neither guard matched the whole record.
describe('an assistant record mixing prose with a tool call', () => {
  test('renders both halves, not neither', async () => {
    const out = await display('mixed-content.jsonl');

    expect(out).toContain('Running the test suite now.');
    expect(out).toContain('Bash');
    expect(out).toContain('bun test');
  });
});

// unrecognized-record.jsonl: an ordinary user+assistant turn, plus a
// `{ type: 'relocated' }` record — a genuine record type from a real
// worktree-relocation session (`~/.claude/projects/**\/*.jsonl`), which
// carries no guard in src/events.ts and therefore cannot be a fabricated
// shape no rule was ever meant to recognize.
describe('a record type no rule recognizes', () => {
  test('is silent by default', async () => {
    const out = await display('unrecognized-record.jsonl');

    expect(out).not.toContain('relocated');
    // The ordinary turn around it still renders.
    expect(out).toContain('Summarize the log.');
    expect(out).toContain('Nothing unusual in the log.');
  });

  test('prints as JSON under --verbose, alongside the ordinary turn', async () => {
    const out = await display('unrecognized-record.jsonl', [ '--verbose' ]);

    expect(out).toContain('"type":"relocated"');
    expect(out).toContain('Summarize the log.');
  });

  // --debug's behaviour is the inverse of plain/verbose: a record a rule
  // *recognizes* renders nothing (even the ones --verbose would show), and
  // only a shape no rule understands reaches the JSON fallback.
  test('under --debug, shows only what no rule recognizes', async () => {
    const out = await display('unrecognized-record.jsonl', [ '--debug' ]);

    expect(out).toContain('"type":"relocated"');
    expect(out).not.toContain('Summarize the log.');
    expect(out).not.toContain('Nothing unusual in the log.');
  });
});
