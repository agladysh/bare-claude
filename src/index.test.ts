import { describe, expect, test } from 'bun:test';

import {
  assertSafeCallToAction,
  buildArgv,
  buildEnv,
  buildSettings,
  LaunchConfig,
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
      noMothership: false,
      noProcessEnv: false,
      linkAuth: true,
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
