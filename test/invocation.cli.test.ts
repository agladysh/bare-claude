/**
 * Black-box tests of an explicitly configured invocation through the real
 * CLI: which configuration file is read (`--config`, `--no-config`), how the
 * command line overrides it, what is refused before anything is spawned, the
 * custody of a caller's Claude home (`--claude-home`), a session continued
 * from a journal file, and caller-managed authentication (`--auth caller`).
 *
 * The fake `claude` reports its argv through `FAKE_CLAUDE_ARGV_FILE` — whose
 * absence proves it never ran — and one environment variable through
 * `FAKE_CLAUDE_ECHO_ENV`, which with `--quiet --print` is the CLI's whole
 * stdout. No real `claude`, model, or credential is involved; `runCli` keeps
 * the operator's real token file out of reach.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { constants, copyFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cliPath, fakeClaudeDir, makeTempRepo, runCli } from './helpers.ts';

const dirs: string[] = [];

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bare-claude-invocation-${label}-`));
  dirs.push(dir);
  return fs.realpath(dir);
}

/** A temporary Git working copy, with `bare-claude.yaml` at its root when given. */
async function repo(yaml?: string): Promise<string> {
  const dir = await fs.realpath(await makeTempRepo());
  dirs.push(dir);
  if (yaml !== undefined) {
    await Bun.file(path.join(dir, 'bare-claude.yaml')).write(yaml);
  }
  return dir;
}

/** A configuration file outside any working copy. */
async function configFile(yaml: string): Promise<string> {
  const file = path.join(await tempDir('config'), 'invocation.yaml');
  await Bun.file(file).write(yaml);
  return file;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

/** Where the fake writes its argv, and a reader that is null when it never ran. */
async function argvProbe(): Promise<{ file: string, read: () => Promise<string[] | null> }> {
  const file = path.join(await tempDir('argv'), 'argv.json');
  return {
    file,
    read: async () => {
      // A fresh handle per read: Bun.file() caches its stat (CLAUDE.md).
      const handle = Bun.file(file);
      if (!await handle.exists()) {
        return null;
      }
      const parsed: unknown = await handle.json();
      if (!isStringArray(parsed)) {
        throw new Error(`fake claude wrote something other than an argv: ${JSON.stringify(parsed)}`);
      }
      return parsed;
    },
  };
}

/** The values following each occurrence of `flag` in `argv`. */
function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, i) => arg === flag ? [ argv[i + 1] ?? '' ] : []);
}

/** Whether `dir`'s filesystem accepts a forced copy-on-write clone. */
async function canClone(dir: string): Promise<boolean> {
  const probe = await fs.mkdtemp(path.join(dir, 'probe-'));
  try {
    await fs.writeFile(path.join(probe, 'a'), 'probe');
    copyFileSync(path.join(probe, 'a'), path.join(probe, 'b'), constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

/** The `Claude session journal at` path the CLI reported, or null. */
function reportedJournal(stderr: string): string | null {
  return stderr.match(/^Claude session journal at (.+)$/m)?.[1] ?? null;
}

/**
 * The shape of this repository's own example: a root `use` that pulls in an
 * alternate provider's endpoint and credential. Run from a working copy that
 * carries it, every invocation silently talks to that endpoint.
 */
const providerExample = [
  'use: default',
  'presets:',
  '  default:',
  '    extraEnv:',
  '      ANTHROPIC_AUTH_TOKEN: example-provider',
  '      ANTHROPIC_BASE_URL: http://localhost:1234',
  '',
].join('\n');

/** The base URL as the child saw it; empty in the environment the tests hand the CLI. */
const echoBaseUrl = { FAKE_CLAUDE_ECHO_ENV: 'ANTHROPIC_BASE_URL', ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '' };

describe('which configuration is read', () => {
  test('the working copy\'s file is merged by default, and --no-config reads none', async () => {
    const cwd = await repo(providerExample);

    const located = await runCli([ '--quiet', '--print', 'hello' ], { cwd, env: echoBaseUrl });
    expect(located.stdout).toBe('ANTHROPIC_BASE_URL=http://localhost:1234\n');

    const none = await runCli([ '--no-config', '--quiet', '--print', 'hello' ], { cwd, env: echoBaseUrl });
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toBe('ANTHROPIC_BASE_URL=\n');
  });

  test('--config reads the named file instead of the working copy\'s', async () => {
    const cwd = await repo(providerExample);
    const argv = await argvProbe();
    const config = await configFile('model: from-config\n');

    const result = await runCli([ '--config', config, '--quiet', '--print', 'hello' ], {
      cwd, env: { ...echoBaseUrl, FAKE_CLAUDE_ARGV_FILE: argv.file },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ANTHROPIC_BASE_URL=\n');
    expect(flagValues(await argv.read() ?? [], '--model')).toEqual([ 'from-config' ]);
  });

  test('--config needs no Git working copy; the located file does', async () => {
    const cwd = await tempDir('plain');
    const config = await configFile('quiet: true\n');

    const named = await runCli([ '--config', config, 'hello' ], { cwd });
    expect(named.exitCode).toBe(0);

    const none = await runCli([ '--no-config', '--quiet', 'hello' ], { cwd });
    expect(none.exitCode).toBe(0);

    const located = await runCli([ '--quiet', 'hello' ], { cwd });
    expect(located.exitCode).toBe(1);
    expect(located.stderr).toContain('is not inside a Git working copy');
    expect(located.stderr).toContain('--no-config');
  });

  test('the command line overrides the named file: scalars replace, arrays concatenate', async () => {
    const cwd = await repo();
    const argv = await argvProbe();
    const config = await configFile([
      'model: from-config',
      'effortLevel: low',
      'tools: [Read]',
      'addDirs: [/from-config]',
      'presets:',
      '  wide:',
      '    disallowedTools: [Write]',
      '',
    ].join('\n'));

    const result = await runCli([
      '--config', config, '--use', 'wide', '--model', 'from-flag', '--add-dir', '/from-flag', '--quiet', 'hello',
    ], { cwd, env: { FAKE_CLAUDE_ARGV_FILE: argv.file } });

    expect(result.exitCode).toBe(0);
    const seen = await argv.read() ?? [];
    expect(flagValues(seen, '--model')).toEqual([ 'from-flag' ]);
    expect(flagValues(seen, '--effort')).toEqual([ 'low' ]);
    expect(flagValues(seen, '--tools')).toEqual([ 'Read' ]);
    expect(flagValues(seen, '--disallowed-tools')).toEqual([ 'Write' ]);
    expect(flagValues(seen, '--add-dir')).toEqual([ '/from-config', '/from-flag' ]);
  });

  test('a declared cwd is where the child runs and where --read resolves', async () => {
    const launchedFrom = await repo();
    const work = await repo();
    await Bun.file(path.join(work, 'notes.md')).write('only in the declared cwd\n');
    const home = path.join(await tempDir('home'), 'claude');
    const config = await configFile(`cwd: ${work}\n`);

    const result = await runCli([
      '--config', config, '--claude-home', home, '--read', 'notes.md', '--quiet', 'hello',
    ], { cwd: launchedFrom });

    expect(result.exitCode).toBe(0);
    const journal = reportedJournal(result.stderr);
    expect(journal).not.toBeNull();
    const text = await fs.readFile(journal ?? '', 'utf8');
    expect(text).toContain('only in the declared cwd');
    expect(text).toContain(`"cwd":"${work}"`);
  });
});

describe('refused before anything is spawned', () => {
  const cases: { name: string, yaml: string, args?: string[], message: string }[] = [
    { name: 'an unknown key', yaml: 'sessionSeed: x\n', message: 'sessionSeed must be removed' },
    {
      name: 'a session seed with both routes',
      yaml: 'customSessionData:\n  sessionId: s\n  value: "{}"\n  sourcePath: /p.jsonl\n',
      message: 'customSessionData',
    },
    {
      name: 'a malformed digest',
      yaml: 'customSessionData:\n  sessionId: s\n  sourcePath: /p.jsonl\n  sourceSha256: abc\n',
      message: 'customSessionData',
    },
    {
      name: 'caller-managed auth beside a token file',
      yaml: 'auth: caller\ntokenFile: /some/oauth\n',
      message: 'cannot also take a tokenFile',
    },
    {
      name: 'caller-managed auth beside a credential link',
      yaml: 'linkAuth: true\n',
      args: [ '--auth', 'caller' ],
      message: 'cannot also take linkAuth',
    },
    { name: 'an unknown auth mode', yaml: '', args: [ '--auth', 'none' ], message: '--auth must be' },
  ];

  for (const { name, yaml, args = [], message } of cases) {
    test(name, async () => {
      const cwd = await repo();
      const argv = await argvProbe();
      const home = path.join(await tempDir('home'), 'claude');
      const config = await configFile(yaml);

      const result = await runCli([ '--config', config, '--claude-home', home, ...args, '--quiet', 'hello' ], {
        cwd, env: { FAKE_CLAUDE_ARGV_FILE: argv.file },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(message);
      expect(await argv.read()).toBeNull();
      expect(await Bun.file(path.join(home, 'settings.json')).exists()).toBe(false);
    });
  }

  test('--config and --no-config together, and a named file that does not exist', async () => {
    const cwd = await repo();
    const argv = await argvProbe();
    const config = await configFile('quiet: true\n');
    const env = { FAKE_CLAUDE_ARGV_FILE: argv.file };

    const both = await runCli([ '--config', config, '--no-config', 'hello' ], { cwd, env });
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain('cannot be given together');

    const missing = path.join(path.dirname(config), 'absent.yaml');
    const absent = await runCli([ '--config', missing, 'hello' ], { cwd, env });
    expect(absent.exitCode).toBe(1);
    expect(absent.stderr).toBe(`bare-claude: configuration file ${missing} does not exist\n`);

    expect(await argv.read()).toBeNull();
  });
});

describe('--claude-home', () => {
  test('is created, kept and reported after success and after failure', async () => {
    const cwd = await repo();
    for (const exitCode of [ 0, 4 ]) {
      const home = path.join(await tempDir('home'), 'claude');
      const result = await runCli([ '--no-config', '--claude-home', home, '--quiet', 'hello' ], {
        cwd, env: { FAKE_CLAUDE_EXIT_CODE: String(exitCode) },
      });

      expect(result.exitCode).toBe(exitCode);
      expect(result.stderr).toContain(`Claude home kept at ${home}\n`);
      const journal = reportedJournal(result.stderr);
      expect(journal?.startsWith(path.join(home, 'projects'))).toBe(true);
      expect(await Bun.file(journal ?? '').exists()).toBe(true);
      expect(await Bun.file(path.join(home, 'settings.json')).exists()).toBe(true);
    }
  });

  test('outlives an interrupted run', async () => {
    const cwd = await repo();
    const home = path.join(await tempDir('home'), 'claude');
    const cli = Bun.spawn({
      cmd: [ 'bun', cliPath, '--no-config', '--claude-home', home, '--quiet', 'hello' ],
      cwd,
      env: {
        ...process.env,
        BARE_CLAUDE_TOKEN_FILE: path.join(cwd, 'no-token-file'),
        FAKE_CLAUDE_SLEEP_MS: '1500',
        PATH: `${fakeClaudeDir}:${process.env.PATH ?? ''}`,
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // The run is under way once the child has written its transcript.
    const projects = path.join(home, 'projects');
    const journal = async (): Promise<string | null> => {
      for (const project of await fs.readdir(projects).catch(() => [])) {
        for (const name of await fs.readdir(path.join(projects, project))) {
          if (name.endsWith('.jsonl')) {
            return path.join(projects, project, name);
          }
        }
      }
      return null;
    };
    const deadline = Date.now() + 10_000;
    while (await journal() === null && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(await journal()).not.toBeNull();

    cli.kill('SIGTERM');
    await cli.exited;

    expect(cli.exitCode === 0).toBe(false);
    const kept = await journal();
    expect(kept).not.toBeNull();
    expect(await fs.readFile(kept ?? '', 'utf8')).toContain('"hello"');
    // Let the orphaned fake finish its sleep before the directory goes.
    await Bun.sleep(1600);
  }, 20_000);
});

describe('a session continued from a journal file', () => {
  test('resumes from an exact clone and never writes the source, or refuses outright', async () => {
    const cwd = await repo();
    const root = await tempDir('seed');
    const sessionId = '01900000-0000-7000-8000-00000000000a';
    const source = path.join(root, 'prior', `${sessionId}.jsonl`);
    await fs.mkdir(path.dirname(source));
    const prior = Buffer.from(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'before' } })}\n`);
    await fs.writeFile(source, prior);
    const digest = createHash('sha256').update(prior).digest('hex');
    const home = path.join(root, 'next-home');
    const argv = await argvProbe();
    const config = await configFile([
      'customSessionData:',
      `  sessionId: ${sessionId}`,
      `  sourcePath: ${source}`,
      `  sourceSha256: ${digest}`,
      '',
    ].join('\n'));

    const result = await runCli([ '--config', config, '--claude-home', home, '--quiet', 'continue' ], {
      cwd, env: { FAKE_CLAUDE_ARGV_FILE: argv.file },
    });

    expect((await fs.readFile(source)).equals(prior)).toBe(true);

    if (!await canClone(root)) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no byte copy is made');
      expect(await argv.read()).toBeNull();
      return;
    }

    expect(result.exitCode).toBe(0);
    expect(flagValues(await argv.read() ?? [], '--resume')).toEqual([ sessionId ]);
    const journal = reportedJournal(result.stderr);
    expect(journal?.endsWith(`${sessionId}.jsonl`)).toBe(true);
    const received = await fs.readFile(journal ?? '');
    expect(received.subarray(0, prior.length).equals(prior)).toBe(true);
    expect(received.length).toBeGreaterThan(prior.length);
  });

  test('cannot be extended by --read, which would need its bytes in memory', async () => {
    const cwd = await repo();
    await Bun.file(path.join(cwd, 'notes.md')).write('notes\n');
    const argv = await argvProbe();
    const config = await configFile('customSessionData:\n  sessionId: s\n  sourcePath: /p.jsonl\n');

    const result = await runCli([ '--config', config, '--read', 'notes.md', '--quiet', 'hello' ], {
      cwd, env: { FAKE_CLAUDE_ARGV_FILE: argv.file },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot extend a file session seed');
    expect(await argv.read()).toBeNull();
  });
});

describe('--auth caller', () => {
  /** A HOME whose default token file holds a recognizable fake token. */
  async function homeWithTokenFile(): Promise<string> {
    const home = await tempDir('home');
    await fs.mkdir(path.join(home, '.config', 'bare-claude'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'bare-claude', 'oauth'), 'sk-ant-oat01-from-default-file', { mode: 0o600 });
    return home;
  }

  /**
   * Every credential variable the gate reads is set empty — which counts as
   * absent — so whatever the shell running the tests carries cannot decide
   * the outcome. The child then reports an empty token as `NAME=`.
   */
  const echoToken = {
    FAKE_CLAUDE_ECHO_ENV: 'CLAUDE_CODE_OAUTH_TOKEN',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    BARE_CLAUDE_TOKEN_FILE: '',
    XDG_CONFIG_HOME: '',
  };

  test('reads no token file where the default route would', async () => {
    const cwd = await repo();
    const env = { ...echoToken, HOME: await homeWithTokenFile() };

    const fallback = await runCli([ '--no-config', '--quiet', '--print', 'hello' ], { cwd, env });
    expect(fallback.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-from-default-file\n');

    const caller = await runCli([ '--no-config', '--auth', 'caller', '--quiet', '--print', 'hello' ], { cwd, env });
    expect(caller.exitCode).toBe(0);
    expect(caller.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=\n');

    const declared = await runCli([ '--config', await configFile('auth: caller\n'), '--quiet', '--print', 'hello' ], {
      cwd, env,
    });
    expect(declared.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=\n');
  });

  test('passes the caller\'s own credential through as given', async () => {
    const cwd = await repo();
    const env = {
      ...echoToken, HOME: await homeWithTokenFile(), CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-caller',
    };

    const result = await runCli([ '--no-config', '--auth', 'caller', '--quiet', '--print', 'hello' ], { cwd, env });
    expect(result.stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-from-caller\n');
  });

  test('a credential the configuration passes is not printed by --debug', async () => {
    const cwd = await repo();
    const config = await configFile([
      'auth: caller',
      'extraEnv:',
      '  CLAUDE_CODE_OAUTH_TOKEN: sk-ant-oat01-from-config',
      'extraSettings:',
      '  env:',
      '    ANTHROPIC_API_KEY: sk-ant-api-from-config',
      '',
    ].join('\n'));
    const home = path.join(await tempDir('home'), 'claude');

    const result = await runCli([ '--config', config, '--claude-home', home, '--debug', 'hello' ], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"CLAUDE_CODE_OAUTH_TOKEN": "<redacted>"');
    expect(result.stdout).not.toContain('sk-ant-oat01-from-config');
    expect(result.stdout).not.toContain('sk-ant-api-from-config');
    expect(result.stderr).not.toContain('sk-ant-');
  });

  test('is refused beside --token-file', async () => {
    const cwd = await repo();
    const result = await runCli([ '--no-config', '--auth', 'caller', '--token-file', '/some/oauth', 'hello' ], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot also take a tokenFile');
  });
});
