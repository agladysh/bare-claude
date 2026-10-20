import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cloneBranch } from '../test/helpers.ts';
import {
  assertSafeCallToAction,
  buildArgv,
  buildEnv,
  buildSettings,
  LaunchConfig,
  spawnClaude,
  type JsonObject,
  type LaunchOptions,
} from './index.ts';

/** A resolved config for the given overrides, with a fixed safe call to action. */
const cfg = (o: Partial<LaunchOptions> = {}): LaunchConfig =>
  LaunchConfig({ callToAction: '# do it', ...o });

/** The session id every argv expectation below is written against. */
const SID = '019000-session';

/** The settings `env` block, which is always an object. */
function settingsEnv(settings: JsonObject): JsonObject {
  const env = settings.env;
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new Error('settings.env is not an object');
  }
  return env;
}

describe('assertSafeCallToAction', () => {
  test('refuses a call to action claude would read as a flag', () => {
    expect(() => assertSafeCallToAction('-p is not a prompt')).toThrow('would parse it as a flag');
    expect(() => assertSafeCallToAction('--help')).toThrow('would parse it as a flag');
    expect(() => assertSafeCallToAction('-')).toThrow('would parse it as a flag');
  });

  test('accepts a prompt made safe by a prefix', () => {
    expect(() => assertSafeCallToAction('# -p is not a prompt')).not.toThrow();
  });

  test('accepts ordinary prompts, including ones containing dashes', () => {
    expect(() => assertSafeCallToAction('Explain this project')).not.toThrow();
    expect(() => assertSafeCallToAction('Run git log --oneline')).not.toThrow();
    expect(() => assertSafeCallToAction('')).not.toThrow();
  });
});

describe('LaunchConfig', () => {
  test('resolves every option, leaving nothing undefined', () => {
    const c = cfg();
    for (const [ key, value ] of Object.entries(c)) {
      expect(`${key}=${String(value === undefined)}`).toBe(`${key}=false`);
    }
  });

  test('applies the documented defaults', () => {
    expect(cfg()).toEqual({
      cwd: null,
      ephemeralClaudeHomePath: null,
      customSessionData: null,
      launcher: 'claude',
      claudePath: 'claude',
      model: null,
      effortLevel: 'high',
      permissionMode: 'auto',
      changeSystemPrompt: null,
      noInstructionFiles: true,
      noMemory: true,
      noSkills: true,
      noHooks: true,
      noPlugins: true,
      noMcp: true,
      noAgents: true,
      noTasks: false,
      noCompact: true,
      noIntegrations: true,
      noHousekeeping: true,
      noBashEditDiff: true,
      noMothership: false,
      noProcessEnv: false,
      auth: 'fallback',
      linkAuth: true,
      tokenFile: null,
      tools: null,
      disallowedTools: null,
      addDirs: [],
      maxBudgetUsd: null,
      maxTokens: null,
      maxOutputLength: null,
      extraEnv: {},
      extraArgs: [],
      extraSettings: {},
      callToAction: '# do it',
    });
  });

  test('noMothership branches on the resolved launcher, not the raw option', () => {
    // Regression: omitting `launcher` must behave exactly like passing 'claude'.
    expect(cfg().noMothership).toBe(false);
    expect(cfg({ launcher: 'claude' }).noMothership).toBe(false);
    expect(cfg({ launcher: 'ollama' }).noMothership).toBe(true);
    expect(cfg({ launcher: 'ollama', noMothership: false }).noMothership).toBe(false);
    expect(cfg({ noMothership: true }).noMothership).toBe(true);
  });

  test('caller-managed auth turns the credential link off by default', () => {
    expect(cfg().linkAuth).toBe(true);
    expect(cfg({ auth: 'caller' }).linkAuth).toBe(false);
    expect(cfg({ auth: 'caller', linkAuth: false }).linkAuth).toBe(false);
    expect(cfg({ auth: 'fallback', linkAuth: false }).linkAuth).toBe(false);
  });

  test('caller-managed auth refuses a credential source of Bare Claude\'s own', () => {
    expect(() => cfg({ auth: 'caller', linkAuth: true })).toThrow('cannot also take linkAuth');
    expect(() => cfg({ auth: 'caller', tokenFile: '/some/oauth' })).toThrow('cannot also take a tokenFile');
    // Unset, in each of the ways the token file resolution treats as unset.
    expect(cfg({ auth: 'caller', tokenFile: null }).tokenFile).toBeNull();
    expect(cfg({ auth: 'caller', tokenFile: '' }).auth).toBe('caller');
  });

  test('refuses an auth mode that is neither, as a JavaScript caller could pass', () => {
    // An unknown mode used to switch every fallback off without a word.
    for (const auth of [ 'none', 'Fallback', '', 0, null ]) {
      const options: LaunchOptions = { callToAction: '# do it' };
      Object.assign(options, { auth });
      expect(() => LaunchConfig(options)).toThrow('auth must be "fallback" or "caller"');
    }
  });

  test('refuses a session id that cannot name a journal file, and takes one that can', () => {
    for (const sessionId of [ '../escape', 'a/b', 'a\\b', '', '.', '..', '.hidden', '-flag', 'x'.repeat(129) ]) {
      expect(() => cfg({ customSessionData: { sessionId, value: '' } })).toThrow('cannot name a journal file');
      expect(() => cfg({ customSessionData: { sessionId, sourcePath: '/p' } })).toThrow('cannot name a journal file');
    }
    for (const sessionId of [ '01900000-0000-7000-8000-000000000001', 'seed_1.v2', 'x'.repeat(128) ]) {
      expect(cfg({ customSessionData: { sessionId, value: '' } }).customSessionData?.sessionId).toBe(sessionId);
    }
  });

  test('keeps falsy values a caller passed explicitly', () => {
    expect(cfg({ noInstructionFiles: false }).noInstructionFiles).toBe(false);
    expect(cfg({ effortLevel: '' }).effortLevel).toBe('');
    expect(cfg({ maxBudgetUsd: 0 }).maxBudgetUsd).toBe(0);
    expect(cfg({ maxTokens: 0 }).maxTokens).toBe(0);
    expect(cfg({ maxOutputLength: 0 }).maxOutputLength).toBe(0);
    expect(cfg({ tools: [] }).tools).toEqual([]);
  });
});

describe('buildArgv', () => {
  test('builds the default command vector', () => {
    expect(buildArgv(cfg(), SID)).toEqual([
      'claude',
      '--session-id', SID,
      '--effort', 'high',
      '--permission-mode', 'auto',
      '--setting-sources', 'user',
      '--disable-slash-commands',
      '--no-chrome',
      '--print', '# do it',
    ]);
  });

  test('--print is always the last flag before the prompt', () => {
    // Measured constraint: a flag after --print is swallowed by the parser.
    const configs: LaunchConfig[] = [
      cfg(),
      cfg({ launcher: 'ollama', model: 'qwen3' }),
      cfg({
        tools: [],
        disallowedTools: [ '*' ],
        addDirs: [ '/a', '/b' ],
        maxBudgetUsd: 1.5,
        extraArgs: [ '--verbose', '--output-format', 'stream-json' ],
        changeSystemPrompt: { type: 'setString', value: 'be brief' },
        customSessionData: { sessionId: SID, value: '' },
      }),
    ];
    for (const c of configs) {
      const argv = buildArgv(c, SID);
      expect(argv.slice(-2)).toEqual([ '--print', c.callToAction ]);
      expect(argv.indexOf('--print')).toBe(argv.length - 2);
    }
  });

  test('launcher selects argv[0] and the wrapper arguments', () => {
    expect(buildArgv(cfg({ launcher: 'claude' }), SID)[0]).toBe('claude');
    expect(buildArgv(cfg({ launcher: 'ollama' }), SID).slice(0, 5))
      .toEqual([ 'ollama', 'launch', 'claude', '--yes', '--' ]);
  });

  test('claudePath selects argv[0] for the claude launcher, defaulting to claude', () => {
    expect(buildArgv(cfg(), SID)[0]).toBe('claude');
    expect(buildArgv(cfg({ claudePath: '/opt/shims/claude' }), SID)[0]).toBe('/opt/shims/claude');
  });

  test('claudePath does not reach the ollama launcher: "claude" there names what ollama launches, not a path', () => {
    const argv = buildArgv(cfg({ launcher: 'ollama', claudePath: '/opt/shims/claude' }), SID);
    expect(argv.slice(0, 5)).toEqual([ 'ollama', 'launch', 'claude', '--yes', '--' ]);
  });

  test('model is passed to the launcher, before the wrapper terminator', () => {
    expect(buildArgv(cfg({ model: 'opus' }), SID).slice(0, 3))
      .toEqual([ 'claude', '--model', 'opus' ]);
    expect(buildArgv(cfg({ launcher: 'ollama', model: 'qwen3' }), SID).slice(0, 7))
      .toEqual([ 'ollama', 'launch', 'claude', '--model', 'qwen3', '--yes', '--' ]);
    expect(buildArgv(cfg(), SID)).not.toContain('--model');
  });

  test('rejects an unknown launcher', () => {
    // Presets come from YAML, so the launcher can be an arbitrary string at
    // run time however well typed the option is.
    const bad = LaunchConfig({ callToAction: '# do it' });
    Object.assign(bad, { launcher: 'not-a-launcher' });
    expect(() => buildArgv(bad, SID)).toThrow('Unknown launcher "not-a-launcher"');
    expect(() => buildArgv(bad, SID)).toThrow('known launchers are claude, ollama');
  });

  test('resumes with --resume and starts fresh with --session-id', () => {
    expect(buildArgv(cfg(), SID)).toContain('--session-id');
    expect(buildArgv(cfg(), SID)).not.toContain('--resume');

    const resumed = buildArgv(cfg({ customSessionData: { sessionId: SID, value: '{}' } }), SID);
    expect(resumed).toContain('--resume');
    expect(resumed).not.toContain('--session-id');
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(SID);
  });

  test('passes effort and permission mode through verbatim', () => {
    const argv = buildArgv(cfg({ effortLevel: 'xhigh', permissionMode: 'plan' }), SID);
    expect(argv[argv.indexOf('--effort') + 1]).toBe('xhigh');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  test('always restricts setting sources to the ephemeral user settings', () => {
    const argv = buildArgv(cfg(), SID);
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
  });

  test('maps every system prompt operation to its flag', () => {
    const flags: Record<string, string> = {
      appendString: '--append-system-prompt',
      appendFile: '--append-system-prompt-file',
      setString: '--system-prompt',
      setFile: '--system-prompt-file',
    };
    for (const [ type, flag ] of Object.entries(flags)) {
      const c = cfg({ changeSystemPrompt: { type: 'setString', value: 'V' } });
      Object.assign(c, { changeSystemPrompt: { type, value: 'V' } });
      const argv = buildArgv(c, SID);
      expect(argv).toContain(flag);
      expect(argv[argv.indexOf(flag) + 1]).toBe('V');
    }
  });

  test('emits no system prompt flag by default', () => {
    const argv = buildArgv(cfg(), SID);
    expect(argv.some((a) => a.includes('system-prompt'))).toBe(false);
  });

  test('noSkills toggles --disable-slash-commands', () => {
    expect(buildArgv(cfg({ noSkills: true }), SID)).toContain('--disable-slash-commands');
    expect(buildArgv(cfg({ noSkills: false }), SID)).not.toContain('--disable-slash-commands');
  });

  test('noIntegrations toggles --no-chrome', () => {
    expect(buildArgv(cfg({ noIntegrations: true }), SID)).toContain('--no-chrome');
    expect(buildArgv(cfg({ noIntegrations: false }), SID)).not.toContain('--no-chrome');
  });

  test('tool policy uses --tools and --disallowed-tools', () => {
    const none = buildArgv(cfg({ tools: [] }), SID);
    // An empty array must still emit an argument, or --tools would swallow the
    // next flag. '' is how claude spells "no tools".
    expect(none[none.indexOf('--tools') + 1]).toBe('');

    const some = buildArgv(cfg({ tools: [ 'Read', 'Bash' ] }), SID);
    expect(some[some.indexOf('--tools') + 1]).toBe('Read,Bash');

    const blocked = buildArgv(cfg({ disallowedTools: [ '*' ] }), SID);
    expect(blocked[blocked.indexOf('--disallowed-tools') + 1]).toBe('*');

    const argv = buildArgv(cfg(), SID);
    expect(argv).not.toContain('--tools');
    expect(argv).not.toContain('--disallowed-tools');
  });

  test('addDirs emits one --add-dir per directory, in order', () => {
    const argv = buildArgv(cfg({ addDirs: [ '/a', '/b', '/c' ] }), SID);
    const dirs = argv.flatMap((a, i) => a === '--add-dir' ? [ argv[i + 1] ] : []);
    expect(dirs).toEqual([ '/a', '/b', '/c' ]);
    expect(buildArgv(cfg(), SID)).not.toContain('--add-dir');
  });

  test('maxBudgetUsd emits a stringified ceiling, zero included', () => {
    const argv = buildArgv(cfg({ maxBudgetUsd: 0.25 }), SID);
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('0.25');
    const zero = buildArgv(cfg({ maxBudgetUsd: 0 }), SID);
    expect(zero[zero.indexOf('--max-budget-usd') + 1]).toBe('0');
    expect(buildArgv(cfg(), SID)).not.toContain('--max-budget-usd');
  });

  test('extraArgs land after derived flags and before --print', () => {
    const argv = buildArgv(cfg({ extraArgs: [ '--verbose' ], maxBudgetUsd: 1 }), SID);
    expect(argv.indexOf('--verbose')).toBeGreaterThan(argv.indexOf('--max-budget-usd'));
    expect(argv.indexOf('--verbose')).toBe(argv.indexOf('--print') - 1);
  });

  test('is pure: repeated calls agree and nothing is retained between them', () => {
    const c = cfg({ addDirs: [ '/a' ], extraArgs: [ '--verbose' ] });
    expect(buildArgv(c, SID)).toEqual(buildArgv(c, SID));
  });
});

describe('buildEnv', () => {
  const home = '/tmp/ephemeral-home';

  test('inherits the ambient environment and forces CLAUDE_CONFIG_DIR', () => {
    const env = buildEnv(cfg(), {
      ephemeralClaudeHomePath: home,
      processEnv: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/real/.claude' },
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.CLAUDE_CONFIG_DIR).toBe(home);
  });

  test('strips the markers that would make the child think it is a sub-session', () => {
    const env = buildEnv(cfg(), {
      ephemeralClaudeHomePath: home,
      processEnv: {
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_EXECPATH: '/x',
        CLAUDE_CODE_SESSION_ID: 'parent',
        CLAUDE_EFFORT: 'high',
        CLAUDE_PID: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'keep-me',
        HOME: '/home/u',
      },
    });
    expect(Object.keys(env).sort()).toEqual([ 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME' ]);
    // Auth is deliberately not a marker: it is how a bare run authenticates.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('keep-me');
  });

  test('noProcessEnv drops the ambient environment entirely', () => {
    const env = buildEnv(cfg({ noProcessEnv: true }), {
      ephemeralClaudeHomePath: home,
      processEnv: { PATH: '/usr/bin', HOME: '/home/u' },
    });
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: home });
  });

  test('noProcessEnv keeps spawnEnv and extraEnv, which are explicit', () => {
    const env = buildEnv(cfg({ noProcessEnv: true, extraEnv: { B: 'b' } }), {
      ephemeralClaudeHomePath: home,
      processEnv: { PATH: '/usr/bin' },
      spawnEnv: { A: 'a' },
    });
    expect(env).toEqual({ A: 'a', B: 'b', CLAUDE_CONFIG_DIR: home });
  });

  test('spawnEnv overrides the inherited environment', () => {
    // Regression: spawnOptions.env used to be discarded without a word.
    const env = buildEnv(cfg(), {
      ephemeralClaudeHomePath: home,
      processEnv: { PATH: '/usr/bin', SHARED: 'inherited' },
      spawnEnv: { SHARED: 'spawn', ONLY_SPAWN: 'yes' },
    });
    expect(env.SHARED).toBe('spawn');
    expect(env.ONLY_SPAWN).toBe('yes');
    expect(env.PATH).toBe('/usr/bin');
  });

  test('extraEnv overrides spawnEnv, and CLAUDE_CONFIG_DIR overrides both', () => {
    const env = buildEnv(cfg({ extraEnv: { SHARED: 'extra', CLAUDE_CONFIG_DIR: '/hijack' } }), {
      ephemeralClaudeHomePath: home,
      processEnv: { SHARED: 'inherited' },
      spawnEnv: { SHARED: 'spawn', CLAUDE_CONFIG_DIR: '/also-hijack' },
    });
    expect(env.SHARED).toBe('extra');
    expect(env.CLAUDE_CONFIG_DIR).toBe(home);
  });

  test('defaults processEnv to the real process environment', () => {
    const env = buildEnv(cfg(), { ephemeralClaudeHomePath: home });
    expect(env.PATH).toBe(process.env.PATH);
  });

  test('does not mutate the environment it was handed', () => {
    const processEnv = { CLAUDECODE: '1', PATH: '/usr/bin' };
    buildEnv(cfg(), { ephemeralClaudeHomePath: home, processEnv });
    expect(processEnv.CLAUDECODE).toBe('1');
  });
});

describe('buildSettings', () => {
  test('builds the default settings document', () => {
    expect(buildSettings(cfg())).toEqual({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        failIfUnavailable: true,
      },
      effortLevel: 'high',
      permissions: {
        defaultMode: 'auto',
        disableBypassPermissionsMode: 'disable',
      },
      syncClaudeAiSkills: false,
      disableAllHooks: true,
      enabledPlugins: {},
      enableAllProjectMcpServers: false,
      enabledMcpjsonServers: [],
      disableDeepLinkRegistration: 'disable',
      cleanupPeriodDays: 99999,
      env: {
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_CRON: '1',
        CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
        DISABLE_COMPACT: '1',
        CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_INSTALLATION_CHECKS: '1',
        CLAUDE_CODE_BASH_EDIT_DIFF: '0',
      },
    });
  });

  test('turning every switch off leaves only the unconditional settings', () => {
    const off = buildSettings(cfg({
      noInstructionFiles: false,
      noMemory: false,
      noSkills: false,
      noHooks: false,
      noPlugins: false,
      noMcp: false,
      noAgents: false,
      noTasks: false,
      noCompact: false,
      noIntegrations: false,
      noHousekeeping: false,
      noBashEditDiff: false,
      noMothership: false,
    }));
    expect(off).toEqual({
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: true },
      effortLevel: 'high',
      permissions: { defaultMode: 'auto', disableBypassPermissionsMode: 'disable' },
      env: { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1' },
    });
  });

  test('every settings env value is a string, as the schema requires', () => {
    const env = settingsEnv(buildSettings(cfg({
      noTasks: true,
      noMothership: true,
      maxOutputLength: 4096,
      maxTokens: 8192,
    })));
    for (const [ key, value ] of Object.entries(env)) {
      expect(`${key}:${typeof value}`).toBe(`${key}:string`);
    }
  });

  test('noInstructionFiles gates CLAUDE.md discovery', () => {
    expect(settingsEnv(buildSettings(cfg())).CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    expect(settingsEnv(buildSettings(cfg({ noInstructionFiles: false })))
      .CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined();
  });

  test('noMemory gates auto memory', () => {
    expect(settingsEnv(buildSettings(cfg())).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(settingsEnv(buildSettings(cfg({ noMemory: false })))
      .CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });

  test('noSkills gates cron and policy skills', () => {
    const on = settingsEnv(buildSettings(cfg()));
    expect(on.CLAUDE_CODE_DISABLE_CRON).toBe('1');
    expect(on.CLAUDE_CODE_DISABLE_POLICY_SKILLS).toBe('1');
    const off = settingsEnv(buildSettings(cfg({ noSkills: false })));
    expect(off.CLAUDE_CODE_DISABLE_CRON).toBeUndefined();
    expect(off.CLAUDE_CODE_DISABLE_POLICY_SKILLS).toBeUndefined();
  });

  test('noSkills turns off claude.ai skill sync and composes with caller settings', () => {
    expect(buildSettings(cfg()).syncClaudeAiSkills).toBe(false);
    expect(buildSettings(cfg({ noSkills: false })).syncClaudeAiSkills).toBeUndefined();
    // A caller that already writes the key, alongside its own settings, keeps all of them.
    const grants = { permissions: { allow: [ 'Read' ] }, env: { ROUTINE: '1' } };
    const both = buildSettings(cfg({ extraSettings: { ...grants, bashEditDiffEnabled: false, syncClaudeAiSkills: false } }));
    expect(both.syncClaudeAiSkills).toBe(false);
    expect(both.bashEditDiffEnabled).toBe(false);
    expect(both.permissions).toEqual({ defaultMode: 'auto', disableBypassPermissionsMode: 'disable', allow: [ 'Read' ] });
    expect(settingsEnv(both).ROUTINE).toBe('1');
    expect(settingsEnv(both).CLAUDE_CODE_DISABLE_POLICY_SKILLS).toBe('1');
    // Opting out of noSkills omits only this key; a caller's own false still stands.
    const optedOut = buildSettings(cfg({ noSkills: false, extraSettings: { syncClaudeAiSkills: false } }));
    expect(optedOut.syncClaudeAiSkills).toBe(false);
    // The slash-command switch is unchanged; the two act on different things.
    expect(buildArgv(cfg(), SID)).toContain('--disable-slash-commands');
  });

  test('noHooks sets disableAllHooks', () => {
    expect(buildSettings(cfg()).disableAllHooks).toBe(true);
    expect(buildSettings(cfg({ noHooks: false })).disableAllHooks).toBeUndefined();
  });

  test('noPlugins empties enabledPlugins', () => {
    expect(buildSettings(cfg()).enabledPlugins).toEqual({});
    expect(buildSettings(cfg({ noPlugins: false })).enabledPlugins).toBeUndefined();
  });

  test('noMcp disables project, mcpjson and claude.ai servers', () => {
    const on = buildSettings(cfg());
    expect(on.enableAllProjectMcpServers).toBe(false);
    expect(on.enabledMcpjsonServers).toEqual([]);
    expect(settingsEnv(on).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');

    const off = buildSettings(cfg({ noMcp: false }));
    expect(off.enableAllProjectMcpServers).toBeUndefined();
    expect(off.enabledMcpjsonServers).toBeUndefined();
    expect(settingsEnv(off).ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
  });

  test('noAgents gates the built-in agents', () => {
    expect(settingsEnv(buildSettings(cfg())).CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe('1');
    expect(settingsEnv(buildSettings(cfg({ noAgents: false })))
      .CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBeUndefined();
  });

  test('noTasks is off by default and sets CLAUDE_CODE_ENABLE_TASKS=0 when on', () => {
    expect(settingsEnv(buildSettings(cfg())).CLAUDE_CODE_ENABLE_TASKS).toBeUndefined();
    expect(settingsEnv(buildSettings(cfg({ noTasks: true }))).CLAUDE_CODE_ENABLE_TASKS).toBe('0');
  });

  test('noCompact gates compaction', () => {
    expect(settingsEnv(buildSettings(cfg())).DISABLE_COMPACT).toBe('1');
    expect(settingsEnv(buildSettings(cfg({ noCompact: false }))).DISABLE_COMPACT).toBeUndefined();
  });

  test('noIntegrations disables deep links and both IDE behaviours', () => {
    const on = buildSettings(cfg());
    expect(on.disableDeepLinkRegistration).toBe('disable');
    expect(settingsEnv(on).CLAUDE_CODE_AUTO_CONNECT_IDE).toBe('false');
    expect(settingsEnv(on).CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBe('1');

    const off = buildSettings(cfg({ noIntegrations: false }));
    expect(off.disableDeepLinkRegistration).toBeUndefined();
    expect(settingsEnv(off).CLAUDE_CODE_AUTO_CONNECT_IDE).toBeUndefined();
    expect(settingsEnv(off).CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBeUndefined();
  });

  test('never writes the IDE toggles as settings keys', () => {
    // Verified 2026-07-26 against 2.1.220: autoConnectIde and
    // autoInstallIdeExtension are global config store keys, absent from the
    // settings schema. Written here they were silently dropped.
    const on = buildSettings(cfg({ noIntegrations: true }));
    const off = buildSettings(cfg({ noIntegrations: false }));
    for (const settings of [ on, off ]) {
      expect(settings.autoConnectIde).toBeUndefined();
      expect(settings.autoInstallIdeExtension).toBeUndefined();
    }
  });

  test('noHousekeeping parks cleanup and disables updater checks', () => {
    const on = buildSettings(cfg());
    expect(on.cleanupPeriodDays).toBe(99999);
    expect(settingsEnv(on).DISABLE_AUTOUPDATER).toBe('1');
    expect(settingsEnv(on).DISABLE_INSTALLATION_CHECKS).toBe('1');

    const off = buildSettings(cfg({ noHousekeeping: false }));
    expect(off.cleanupPeriodDays).toBeUndefined();
    expect(settingsEnv(off).DISABLE_AUTOUPDATER).toBeUndefined();
    expect(settingsEnv(off).DISABLE_INSTALLATION_CHECKS).toBeUndefined();
  });

  test('noBashEditDiff composes with caller settings rather than replacing them', () => {
    const grants = { permissions: { allow: [ 'Bash(git status:*)' ] }, env: { ROUTINE: '1' } };
    // Default on, with a caller that also disables the diff and grants tools.
    const both = buildSettings(cfg({ extraSettings: { ...grants, bashEditDiffEnabled: false } }));
    expect(both.bashEditDiffEnabled).toBe(false);
    expect(both.permissions).toEqual({
      defaultMode: 'auto', disableBypassPermissionsMode: 'disable', allow: [ 'Bash(git status:*)' ],
    });
    expect(settingsEnv(both).ROUTINE).toBe('1');
    expect(settingsEnv(both).CLAUDE_CODE_BASH_EDIT_DIFF).toBe('0');
    // Opting out removes only this library's variable; the caller's false stands.
    const optedOut = buildSettings(cfg({ noBashEditDiff: false, extraSettings: { bashEditDiffEnabled: false } }));
    expect(settingsEnv(optedOut).CLAUDE_CODE_BASH_EDIT_DIFF).toBeUndefined();
    expect(optedOut.bashEditDiffEnabled).toBe(false);
    // A caller's settings key alone does not override the variable Claude reads first.
    const keyOnly = buildSettings(cfg({ extraSettings: { bashEditDiffEnabled: true } }));
    expect(settingsEnv(keyOnly).CLAUDE_CODE_BASH_EDIT_DIFF).toBe('0');
  });

  test('noBashEditDiff turns off the per-command working-tree snapshots', () => {
    expect(settingsEnv(buildSettings(cfg())).CLAUDE_CODE_BASH_EDIT_DIFF).toBe('0');
    expect(settingsEnv(buildSettings(cfg({ noBashEditDiff: false }))).CLAUDE_CODE_BASH_EDIT_DIFF).toBeUndefined();
    // A caller's explicit settings still win, like every other key.
    const kept = buildSettings(cfg({ extraSettings: { env: { CLAUDE_CODE_BASH_EDIT_DIFF: '1' } } }));
    expect(settingsEnv(kept).CLAUDE_CODE_BASH_EDIT_DIFF).toBe('1');
  });

  test('noMothership silences attribution, nonessential traffic and telemetry', () => {
    const on = settingsEnv(buildSettings(cfg({ noMothership: true })));
    expect(on.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(on.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(on.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('0');

    // Off for the claude launcher, on for anything else.
    expect(settingsEnv(buildSettings(cfg())).CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined();
    expect(settingsEnv(buildSettings(cfg({ launcher: 'ollama' })))
      .CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
  });

  test('model is mirrored into settings only when set', () => {
    expect(buildSettings(cfg({ model: 'opus' })).model).toBe('opus');
    expect(buildSettings(cfg()).model).toBeUndefined();
  });

  test('effortLevel and permissionMode reach settings as well as argv', () => {
    const s = buildSettings(cfg({ effortLevel: 'low', permissionMode: 'plan' }));
    expect(s.effortLevel).toBe('low');
    expect(s.permissions).toEqual({
      defaultMode: 'plan',
      disableBypassPermissionsMode: 'disable',
    });
  });

  test('maxOutputLength caps every tool output channel', () => {
    const env = settingsEnv(buildSettings(cfg({ maxOutputLength: 4096 })));
    expect(env.TASK_MAX_OUTPUT_LENGTH).toBe('4096');
    expect(env.BASH_MAX_OUTPUT_LENGTH).toBe('4096');
    expect(env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS).toBe('4096');

    const zero = settingsEnv(buildSettings(cfg({ maxOutputLength: 0 })));
    expect(zero.BASH_MAX_OUTPUT_LENGTH).toBe('0');

    expect(settingsEnv(buildSettings(cfg())).BASH_MAX_OUTPUT_LENGTH).toBeUndefined();
  });

  test('maxTokens caps generation, separately from maxOutputLength', () => {
    const env = settingsEnv(buildSettings(cfg({ maxTokens: 8192 })));
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8192');
    expect(env.BASH_MAX_OUTPUT_LENGTH).toBeUndefined();
    expect(settingsEnv(buildSettings(cfg())).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  test('the sandbox fails loudly rather than silently running unsandboxed', () => {
    // Without failIfUnavailable a host lacking sandbox support only warns and
    // runs commands unsandboxed, at which point autoAllowBashIfSandboxed no
    // longer applies and headless --print has no way to grant Bash.
    expect(buildSettings(cfg()).sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      failIfUnavailable: true,
    });
  });

  test('is pure: repeated calls agree', () => {
    const c = cfg({ extraSettings: { permissions: { allow: [ 'Bash' ] } } });
    expect(buildSettings(c)).toEqual(buildSettings(c));
  });
});

describe('buildSettings extraSettings', () => {
  test('overrides keys that used to be assigned after the spread', () => {
    // Regression: extraSettings was spread in before these were written, so a
    // caller could only ever override $schema and sandbox.
    const s = buildSettings(cfg({
      model: 'opus',
      extraSettings: {
        effortLevel: 'low',
        disableAllHooks: false,
        enabledPlugins: { 'x@y': true },
        enableAllProjectMcpServers: true,
        disableDeepLinkRegistration: 'disable',
        cleanupPeriodDays: 1,
        model: 'sonnet',
      },
    }));
    expect(s.effortLevel).toBe('low');
    expect(s.disableAllHooks).toBe(false);
    expect(s.enabledPlugins).toEqual({ 'x@y': true });
    expect(s.enableAllProjectMcpServers).toBe(true);
    expect(s.cleanupPeriodDays).toBe(1);
    expect(s.model).toBe('sonnet');
  });

  test('merges deeply rather than replacing nested objects', () => {
    const s = buildSettings(cfg({
      extraSettings: {
        permissions: { allow: [ 'Bash(git *)' ] },
        sandbox: { network: { allowedDomains: [ '*.example.com' ] } },
      },
    }));
    expect(s.permissions).toEqual({
      defaultMode: 'auto',
      disableBypassPermissionsMode: 'disable',
      allow: [ 'Bash(git *)' ],
    });
    expect(s.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      failIfUnavailable: true,
      network: { allowedDomains: [ '*.example.com' ] },
    });
  });

  test('can override a nested value, not only add to it', () => {
    const s = buildSettings(cfg({
      permissionMode: 'auto',
      extraSettings: {
        permissions: { defaultMode: 'plan' },
        sandbox: { enabled: false, failIfUnavailable: false },
      },
    }));
    expect(s.permissions).toEqual({
      defaultMode: 'plan',
      disableBypassPermissionsMode: 'disable',
    });
    expect(s.sandbox).toEqual({
      enabled: false,
      autoAllowBashIfSandboxed: true,
      failIfUnavailable: false,
    });
  });

  test('folds the env block into the general merge, later winning', () => {
    // env used to be the one specially handled key, and the flags below it
    // overwrote whatever the caller put there.
    const env = settingsEnv(buildSettings(cfg({
      noInstructionFiles: true,
      extraSettings: {
        env: {
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
          CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '0',
          MY_OWN: 'value',
        },
      },
    })));
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('0');
    expect(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe('0');
    expect(env.MY_OWN).toBe('value');
    // Untouched keys survive the merge.
    expect(env.DISABLE_COMPACT).toBe('1');
  });

  test('adds keys this library never writes', () => {
    const s = buildSettings(cfg({ extraSettings: { outputStyle: 'Explanatory', verbose: true } }));
    expect(s.outputStyle).toBe('Explanatory');
    expect(s.verbose).toBe(true);
  });

  test('concatenates arrays, matching preset merge semantics', () => {
    const s = buildSettings(cfg({ extraSettings: { enabledMcpjsonServers: [ 'mine' ] } }));
    expect(s.enabledMcpjsonServers).toEqual([ 'mine' ]);
  });

  test('an empty extraSettings changes nothing', () => {
    expect(buildSettings(cfg({ extraSettings: {} }))).toEqual(buildSettings(cfg()));
  });

  test('does not mutate the caller\'s extraSettings', () => {
    const extraSettings: JsonObject = { env: { MY_OWN: 'value' } };
    buildSettings(cfg({ extraSettings }));
    expect(extraSettings).toEqual({ env: { MY_OWN: 'value' } });
  });
});

describe('spawnClaude and the token file', () => {
  /**
   * Every run here execs a shell script in place of `claude` that prints the
   * child's CLAUDE_CODE_OAUTH_TOKEN and exits: what reached the child is the
   * whole question. `noProcessEnv` keeps this process's environment out, so
   * HOME and everything else the resolution reads is what the test supplies,
   * and the operator's real token file is never in reach.
   */
  const roots: string[] = [];

  async function tempDir(label: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bare-claude-spawn-token-${label}-`));
    roots.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  // One script for every run here, not one per run: in the 2026-10-15 suite
  // each run of a freshly written script took 0.1-1.4 s, against 20-50 ms for
  // the checked-in fake below, enough to time out a test making three runs.
  let probeDir = '';
  let probe = '';

  beforeAll(async () => {
    probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-spawn-token-probe-'));
    probe = path.join(probeDir, 'claude');
    await fs.writeFile(probe, '#!/bin/sh\nprintf \'%s\' "${CLAUDE_CODE_OAUTH_TOKEN-<unset>}"\n', { mode: 0o755 });
    await fs.chmod(probe, 0o755);
  });

  afterAll(async () => {
    await fs.rm(probeDir, { recursive: true, force: true });
  });

  /** A HOME whose default token file holds `content`, or none when null. */
  async function homeWith(content: string | null): Promise<string> {
    const home = await tempDir('home');
    if (content !== null) {
      const dir = path.join(home, '.config', 'bare-claude');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'oauth'), content, { mode: 0o600 });
    }
    return home;
  }

  async function tokenSeenBy(options: Partial<LaunchOptions>): Promise<string> {
    const claude = await spawnClaude({
      callToAction: '# probe',
      claudePath: probe,
      noProcessEnv: true,
      linkAuth: false,
      ...options,
    }, { stdout: 'pipe', stderr: 'ignore' });
    try {
      const [ stdout ] = await Promise.all([
        new Response(claude.subprocess.stdout).text(),
        claude.subprocess.exited,
      ]);
      return stdout;
    } finally {
      await claude.dispose();
    }
  }

  test('reads the default file when the environment has no token', async () => {
    const home = await homeWith('  sk-ant-oat01-from-default-file\n');
    expect(await tokenSeenBy({ extraEnv: { HOME: home } })).toBe('sk-ant-oat01-from-default-file');
  });

  test('an explicit environment token wins over the file', async () => {
    const home = await homeWith('sk-ant-oat01-from-default-file');
    expect(await tokenSeenBy({ extraEnv: { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-env' } }))
      .toBe('sk-ant-oat01-from-env');
  });

  test('the tokenFile option beats BARE_CLAUDE_TOKEN_FILE, which beats the default', async () => {
    const home = await homeWith('sk-ant-oat01-from-default-file');
    const fromVariable = path.join(await tempDir('var'), 'oauth');
    await fs.writeFile(fromVariable, 'sk-ant-oat01-from-variable\n', { mode: 0o600 });
    const explicit = path.join(await tempDir('explicit'), 'oauth');
    await fs.writeFile(explicit, 'sk-ant-oat01-from-option\n', { mode: 0o600 });

    expect(await tokenSeenBy({ extraEnv: { HOME: home, BARE_CLAUDE_TOKEN_FILE: fromVariable } }))
      .toBe('sk-ant-oat01-from-variable');
    expect(await tokenSeenBy({ tokenFile: explicit, extraEnv: { HOME: home, BARE_CLAUDE_TOKEN_FILE: fromVariable } }))
      .toBe('sk-ant-oat01-from-option');
  });

  test('honours XDG_CONFIG_HOME for the default location', async () => {
    const xdg = await tempDir('xdg');
    await fs.mkdir(path.join(xdg, 'bare-claude'), { recursive: true });
    await fs.writeFile(path.join(xdg, 'bare-claude', 'oauth'), 'sk-ant-oat01-from-xdg', { mode: 0o600 });
    const home = await homeWith('sk-ant-oat01-from-default-file');

    expect(await tokenSeenBy({ extraEnv: { HOME: home, XDG_CONFIG_HOME: xdg } })).toBe('sk-ant-oat01-from-xdg');
  });

  test('leaves the child without a token when there is no file', async () => {
    expect(await tokenSeenBy({ extraEnv: { HOME: await homeWith(null) } })).toBe('<unset>');
  });

  test('does not read the file beside an alternate credential', async () => {
    const home = await homeWith('sk-ant-oat01-from-default-file');
    expect(await tokenSeenBy({ extraEnv: { HOME: home, ANTHROPIC_AUTH_TOKEN: 'lmstudio' } })).toBe('<unset>');
    expect(await tokenSeenBy({ extraEnv: { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api-not-real' } })).toBe('<unset>');
  });

  test('refuses an empty file before spawning, naming the path only', async () => {
    const home = await homeWith('\n');
    const file = path.join(home, '.config', 'bare-claude', 'oauth');
    await expect(tokenSeenBy({ extraEnv: { HOME: home } })).rejects.toThrow(`token file ${file} is empty`);
  });

  test('caller-managed auth never puts a token file beside the caller\'s route', async () => {
    // The case a managed launcher is in: it brings its own credential, so the
    // environment it is handed carries none. Under 'fallback' that absence is
    // exactly what triggers the file; under 'caller' nothing is read at all.
    const home = await homeWith('sk-ant-oat01-from-default-file');
    const fromVariable = path.join(await tempDir('var'), 'oauth');
    await fs.writeFile(fromVariable, 'sk-ant-oat01-from-variable\n', { mode: 0o600 });

    expect(await tokenSeenBy({ extraEnv: { HOME: home } })).toBe('sk-ant-oat01-from-default-file');
    expect(await tokenSeenBy({ auth: 'caller', extraEnv: { HOME: home } })).toBe('<unset>');
    expect(await tokenSeenBy({ auth: 'caller', extraEnv: { HOME: home, BARE_CLAUDE_TOKEN_FILE: fromVariable } }))
      .toBe('<unset>');
  });

  test('caller-managed auth does not even inspect a broken token file', async () => {
    // An empty file is an error under 'fallback'; under 'caller' it is not
    // this run's business.
    const home = await homeWith('\n');
    expect(await tokenSeenBy({ auth: 'caller', extraEnv: { HOME: home } })).toBe('<unset>');
  });

  test('caller-managed auth passes the caller\'s own credential through untouched', async () => {
    const home = await homeWith('sk-ant-oat01-from-default-file');
    expect(await tokenSeenBy({
      auth: 'caller',
      extraEnv: { HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-caller' },
    })).toBe('sk-ant-oat01-from-caller');
  });
});

describe('spawnClaude and a caller\'s Claude home', () => {
  /**
   * The fake `claude` under test/ stands in for the child: it writes a
   * two-record transcript into the session file under the home it is given
   * (appending, as the real one does) and exits. `noProcessEnv` plus an
   * explicit PATH keeps this process's environment, and with it any real
   * credential, out of the child.
   */
  const fakeClaude = path.join(import.meta.dir, '..', 'test', 'fake-claude', 'claude');
  const roots: string[] = [];

  async function tempDir(label: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bare-claude-spawn-home-${label}-`));
    roots.push(dir);
    return fs.realpath(dir);
  }

  afterEach(async () => {
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  async function run(options: Partial<LaunchOptions>, env: Record<string, string> = {}) {
    const claude = await spawnClaude({
      callToAction: '# continue',
      claudePath: fakeClaude,
      noProcessEnv: true,
      auth: 'caller',
      ...options,
    }, { env: { PATH: path.dirname(process.execPath), ...env }, stdout: 'ignore', stderr: 'ignore' });
    const exitCode = await claude.subprocess.exited;
    await claude.dispose();
    return { claude, exitCode };
  }

  /** A real directory under `root`, and a symbolic link to it beside it: a cwd and its alias. */
  async function aliasedDir(root: string): Promise<{ real: string, alias: string }> {
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    await fs.mkdir(real);
    await fs.symlink(real, alias);
    return { real, alias };
  }

  /** The project key Claude Code uses for a short absolute path. */
  const projectKey = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-');

  test('a fresh run in a cwd given through an alias reports the journal the child actually writes', async () => {
    // The fake writes where the real binary does: under the key of its own,
    // physical cwd. A journal path keyed on the alias would not exist.
    const root = await tempDir('root');
    const { real, alias } = await aliasedDir(root);
    const home = path.join(root, 'home');
    const result = await run({ cwd: alias, ephemeralClaudeHomePath: home });

    expect(result.exitCode).toBe(0);
    expect(result.claude.projectHomePath).toBe(path.join(home, 'projects', projectKey(real)));
    expect(path.dirname(result.claude.sessionJsonlPath)).toBe(result.claude.projectHomePath);
    expect(await Bun.file(result.claude.sessionJsonlPath).exists()).toBe(true);
    expect(await fs.readdir(path.join(home, 'projects'))).toEqual([ projectKey(real) ]);
  });

  test('a relative cwd through an alias resolves against this process\'s cwd, then to the physical directory', async () => {
    const root = await tempDir('root');
    const { real, alias } = await aliasedDir(root);
    const home = path.join(root, 'home');
    const result = await run({ cwd: path.relative(process.cwd(), alias), ephemeralClaudeHomePath: home });

    expect(result.exitCode).toBe(0);
    expect(result.claude.projectHomePath).toBe(path.join(home, 'projects', projectKey(real)));
    expect(await Bun.file(result.claude.sessionJsonlPath).exists()).toBe(true);
  });

  test('a seed published for an aliased cwd lands where the child resumes it, and history names the real one', async () => {
    const root = await tempDir('root');
    const { real, alias } = await aliasedDir(root);
    const home = path.join(root, 'home');
    const seed = { sessionId: '01900000-0000-7000-8000-000000000005', value: '{"type":"user"}\n' };
    const result = await run({ cwd: alias, ephemeralClaudeHomePath: home, customSessionData: seed });

    expect(result.exitCode).toBe(0);
    const journal = await fs.readFile(result.claude.sessionJsonlPath, 'utf8');
    // The seed and the child's own appends are one file, not two.
    expect(journal.startsWith(seed.value)).toBe(true);
    expect(journal.length).toBeGreaterThan(seed.value.length);
    expect(await fs.readdir(path.join(home, 'projects'))).toEqual([ projectKey(real) ]);
    const history: unknown = JSON.parse((await fs.readFile(path.join(home, 'history.jsonl'), 'utf8')).trim());
    expect(history).toMatchObject({ project: real, sessionId: seed.sessionId });
  });

  test('a cwd that does not exist is refused before anything is created', async () => {
    const root = await tempDir('root');
    const home = path.join(root, 'home');
    const missing = path.join(root, 'missing');

    await expect(run({ cwd: missing, ephemeralClaudeHomePath: home })).rejects.toThrow(`cwd ${missing} cannot be resolved`);
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('a missing home is created, and dispose() leaves it, after success and failure alike', async () => {
    const root = await tempDir('root');
    for (const exitCode of [ '0', '3' ]) {
      const home = path.join(root, `home-${exitCode}`);
      const result = await run({ cwd: root, ephemeralClaudeHomePath: home }, { FAKE_CLAUDE_EXIT_CODE: exitCode });

      expect(result.exitCode).toBe(Number(exitCode));
      expect(result.claude.ephemeralClaudeHomePath).toBe(home);
      expect(await Bun.file(result.claude.sessionJsonlPath).exists()).toBe(true);
      expect(await Bun.file(path.join(home, 'settings.json')).exists()).toBe(true);
    }
  });

  test('a relative home is resolved before the child sees it', async () => {
    // The child resolves CLAUDE_CONFIG_DIR against its own cwd; handing it a
    // relative path would put the session somewhere the parent never looks.
    const root = await tempDir('root');
    const cwd = path.join(root, 'work');
    await fs.mkdir(cwd);
    const relative = path.relative(process.cwd(), path.join(root, 'home'));
    const result = await run({ cwd, ephemeralClaudeHomePath: relative });

    expect(result.exitCode).toBe(0);
    expect(result.claude.ephemeralClaudeHomePath).toBe(path.join(root, 'home'));
    expect(await Bun.file(result.claude.sessionJsonlPath).exists()).toBe(true);
  });

  test('an in-memory seed never overwrites a journal already in the home', async () => {
    const root = await tempDir('root');
    const home = path.join(root, 'home');
    const seed = { sessionId: '01900000-0000-7000-8000-000000000001', value: '{"type":"user"}\n' };
    const first = await run({ cwd: root, ephemeralClaudeHomePath: home, customSessionData: seed });
    expect(first.exitCode).toBe(0);
    const journal = await fs.readFile(first.claude.sessionJsonlPath, 'utf8');
    expect(journal.startsWith(seed.value)).toBe(true);
    expect(journal.length).toBeGreaterThan(seed.value.length);

    await expect(run({ cwd: root, ephemeralClaudeHomePath: home, customSessionData: seed }))
      .rejects.toThrow('already exists');
    expect(await fs.readFile(first.claude.sessionJsonlPath, 'utf8')).toBe(journal);
    // The refused seed added nothing to the home's history either.
    const history = await fs.readFile(path.join(home, 'history.jsonl'), 'utf8');
    expect(history.trimEnd().split('\n')).toHaveLength(1);
  });

  test('a refused seed in a temporary home leaves no temporary home behind', async () => {
    const root = await tempDir('root');
    const seed = { sessionId: '01900000-0000-7000-8000-000000000002', sourcePath: path.join(root, 'absent.jsonl') };
    const before = new Set(await fs.readdir(os.tmpdir()));

    await expect(run({ cwd: root, customSessionData: seed })).rejects.toThrow();

    // bun test runs one test at a time unless told otherwise, so any new
    // home here is this refusal's.
    const leaked = (await fs.readdir(os.tmpdir()))
      .filter(name => name.startsWith('bare-claude-home-') && !before.has(name));
    expect(leaked).toEqual([]);
  });

  test('a spawn that fails after publishing takes back its journal and history line, so a retry works', async () => {
    // The counterexample: a claudePath that does not exist. The seed and the
    // history line are published before Bun.spawn throws; left in place, the
    // same invocation would be refused as "already exists" from then on.
    const root = await tempDir('root');
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    const history = path.join(home, 'history.jsonl');
    await fs.writeFile(history, '{"earlier":true}\n');
    const seed = { sessionId: '01900000-0000-7000-8000-000000000004', value: '{"type":"user"}\n' };

    await expect(run({
      cwd: root, ephemeralClaudeHomePath: home, customSessionData: seed, claudePath: path.join(root, 'no-such-claude'),
    })).rejects.toThrow();

    expect(await fs.readFile(history, 'utf8')).toBe('{"earlier":true}\n');
    const projects = path.join(home, 'projects');
    for (const project of await fs.readdir(projects)) {
      expect(await fs.readdir(path.join(projects, project))).toEqual([]);
    }

    const retried = await run({ cwd: root, ephemeralClaudeHomePath: home, customSessionData: seed });
    expect(retried.exitCode).toBe(0);
    expect((await fs.readFile(retried.claude.sessionJsonlPath, 'utf8')).startsWith(seed.value)).toBe(true);
    expect((await fs.readFile(history, 'utf8')).trimEnd().split('\n')).toHaveLength(2);
  });

  test('settings.json is replaced whole, mode 0600, leaving no temporary file beside it', async () => {
    // It can carry a caller's extraSettings.env, and a run still reading the
    // home must never see half of it.
    const root = await tempDir('root');
    const home = path.join(root, 'home');
    for (const value of [ 'first', 'second' ]) {
      const result = await run({ cwd: root, ephemeralClaudeHomePath: home, extraSettings: { env: { MARK: value } } });
      expect(result.exitCode).toBe(0);
    }
    const settings = path.join(home, 'settings.json');
    expect((await fs.stat(settings)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(settings).text()).toContain('"MARK": "second"');
    expect((await fs.readdir(home)).filter(name => name.startsWith('.settings.json.'))).toEqual([]);
  });

  test('a session id that cannot name a journal file is refused before anything is created', async () => {
    const root = await tempDir('root');
    const home = path.join(root, 'home');
    for (const sessionId of [ '../escape', 'a/b', '', '.hidden', 'x'.repeat(129) ]) {
      await expect(run({ cwd: root, ephemeralClaudeHomePath: home, customSessionData: { sessionId, value: '' } }))
        .rejects.toThrow('cannot name a journal file');
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('processGroup is the spawned PID only when spawned detached', async () => {
    const root = await tempDir('root');
    const plain = await spawnClaude({
      callToAction: '# probe', claudePath: fakeClaude, noProcessEnv: true, auth: 'caller', cwd: root,
    }, { env: { PATH: path.dirname(process.execPath) }, stdout: 'ignore', stderr: 'ignore' });
    await plain.subprocess.exited;
    await plain.dispose();
    expect(plain.processGroup).toBeNull();

    const detached = await spawnClaude({
      callToAction: '# probe', claudePath: fakeClaude, noProcessEnv: true, auth: 'caller', cwd: root,
    }, { env: { PATH: path.dirname(process.execPath) }, stdout: 'ignore', stderr: 'ignore', detached: true });
    await detached.subprocess.exited;
    await detached.dispose();
    expect(detached.processGroup).toBe(process.platform === 'win32' ? null : detached.subprocess.pid);
  });

  test(`a file seed resumes from an exact clone, and the source outlives the new appends [${cloneBranch} branch]`, async () => {
    const root = await tempDir('root');
    const sessionId = '01900000-0000-7000-8000-000000000003';
    const source = path.join(root, 'prior', `${sessionId}.jsonl`);
    await fs.mkdir(path.dirname(source));
    const prior = Buffer.from(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'before é' } })}\n`);
    await fs.writeFile(source, prior);
    const sourceSha256 = createHash('sha256').update(prior).digest('hex');
    const home = path.join(root, 'next-home');
    const options: Partial<LaunchOptions> = {
      cwd: root, ephemeralClaudeHomePath: home, customSessionData: { sessionId, sourcePath: source, sourceSha256 },
    };

    if (cloneBranch === 'refusal') {
      await expect(run(options)).rejects.toThrow('no byte copy is made');
      expect((await fs.readFile(source)).equals(prior)).toBe(true);
      const projects = path.join(home, 'projects');
      for (const project of await fs.readdir(projects)) {
        expect(await fs.readdir(path.join(projects, project))).toEqual([]);
      }
      return;
    }

    const result = await run(options);
    expect(result.exitCode).toBe(0);
    expect(result.claude.sessionId).toBe(sessionId);
    const received = await fs.readFile(result.claude.sessionJsonlPath);
    expect(received.subarray(0, prior.length).equals(prior)).toBe(true);
    expect(received.length).toBeGreaterThan(prior.length);
    expect((await fs.readFile(source)).equals(prior)).toBe(true);
  });
});
