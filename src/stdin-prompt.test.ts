import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnClaudeWithStdinPrompt, type LaunchOptions } from './index.ts';

const roots: string[] = [];
const child = `#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
if (process.env.CONTROLLED_EARLY_EXIT === '1') process.exit(7);
const bytes = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
const home = process.env.CLAUDE_CONFIG_DIR;
if (!home) throw Error('Missing controlled run home');
await fs.writeFile(path.join(home, 'input.bin'), bytes);
await fs.writeFile(path.join(home, 'argv.json'), JSON.stringify(process.argv.slice(2)));
process.stdout.write('received EOF\\n');
process.stderr.write('controlled stderr\\n');
if (process.env.CONTROLLED_DELAY === '1') await Bun.sleep(60000);
`;
async function fixture(prompt: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-stdin-'));
  roots.push(root);
  const executable = path.join(root, 'controlled-child');
  await fs.writeFile(executable, child, { mode: 0o700 });
  const home = path.join(root, 'home');
  const options: LaunchOptions = {
    callToAction: prompt, cwd: root, claudePath: executable,
    ephemeralClaudeHomePath: home, auth: 'caller', noProcessEnv: true,
    extraEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  };
  return { root, home, options };
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test('the SDK sends a large exact UTF-8 prompt and EOF without placing prompt bytes in argv', async () => {
  const prompt = '- exact input\r\n\0' + 'synthetic bytes α🙂\r\n'.repeat(100_000) + '\nend\n';
  const f = await fixture(prompt);
  const run = await spawnClaudeWithStdinPrompt(f.options, { stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.subprocess.stdout).text(), new Response(run.subprocess.stderr).text(), run.subprocess.exited,
  ]);
  expect(code).toBe(0); expect(stdout).toBe('received EOF\n'); expect(stderr).toBe('controlled stderr\n');
  const input = await fs.readFile(path.join(f.home, 'input.bin'));
  expect(input.byteLength).toBe(Buffer.byteLength(prompt));
  expect(createHash('sha256').update(input).digest('hex')).toBe(createHash('sha256').update(prompt).digest('hex'));
  const argv: unknown = JSON.parse(await fs.readFile(path.join(f.home, 'argv.json'), 'utf8'));
  if (!isStringArray(argv)) throw Error('Controlled child argv is not a string array');
  expect(argv.at(-1)).toBe('--print'); expect(argv).toContain('--input-format');
  expect(argv).not.toContain(prompt); expect(argv.join('\n')).not.toContain('synthetic bytes');
  expect(argv.join('\n').length).toBeLessThan(4096);
  await run.dispose();
  expect(await fs.readFile(path.join(f.home, 'input.bin'))).toEqual(input);
  expect(run.ephemeralClaudeHomePath).toBe(f.home);
}, 10000);

test('an early child exit propagates without a prompt-feed hang or a replay', async () => {
  const f = await fixture('synthetic large input\n'.repeat(100_000));
  f.options.extraEnv = { ...f.options.extraEnv, CONTROLLED_EARLY_EXIT: '1' };
  const started = Date.now();
  const run = await spawnClaudeWithStdinPrompt(f.options, { stdout: 'pipe', stderr: 'pipe', timeout: 3000 });
  const [, , code] = await Promise.all([
    new Response(run.subprocess.stdout).text(), new Response(run.subprocess.stderr).text(), run.subprocess.exited,
  ]);
  expect(code).toBe(7); expect(Date.now() - started).toBeLessThan(2500);
  expect(await fs.stat(f.home)).toBeDefined();
  await run.dispose(); expect(await fs.stat(f.home)).toBeDefined();
}, 5000);

test('the existing timeout and output capture still apply after text-input EOF', async () => {
  const f = await fixture('synthetic timeout input\n'.repeat(20_000));
  f.options.extraEnv = { ...f.options.extraEnv, CONTROLLED_DELAY: '1' };
  const run = await spawnClaudeWithStdinPrompt(f.options, { stdout: 'pipe', stderr: 'pipe', timeout: 500 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.subprocess.stdout).text(), new Response(run.subprocess.stderr).text(), run.subprocess.exited,
  ]);
  expect(code).not.toBe(0); expect(stdout).toBe('received EOF\n'); expect(stderr).toBe('controlled stderr\n');
  expect((await fs.readFile(path.join(f.home, 'input.bin'))).byteLength).toBe(Buffer.byteLength(f.options.callToAction));
  expect(await fs.stat(f.home)).toBeDefined();
}, 5000);
