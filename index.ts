import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type JsonStructure = JsonObject | JsonArray
export interface JsonObject {
	[k: string]: Json
}
export type JsonArray = Json[]
export type JsonPrimitive = string | boolean | number | null
export type Json = JsonStructure | JsonPrimitive

function sanitizeForFilename(s: string) {
  return s.replace(/[^a-zA-Z0-9]/g, '-');
}

function pathToFilename(path: string): string {
  const maxLength = 200;
  const filename = sanitizeForFilename(path);
  return filename.length <= maxLength
    ? filename
    : `${filename.slice(0, maxLength)}-${Bun.hash(path).toString(36)}`;
}

export const Launchers = {
  claude: 'claude',
  ollama: 'ollama',
} as const;

export type Launchers = typeof Launchers;
export type Launcher = keyof Launchers;
type SystemPromptOp = 'appendString' | 'setString' | 'appendFile' | 'setFile';

// TODO: Support worktrees.
interface LaunchOptions {
  cwd?: string | null,
  ephemeralClaudeHomePath?: string | null,
  customSessionData?: null | { sessionId: string, value: string },
  launcher?: Launcher,
  model?: null | string,
  effortLevel?: string,
  permissionMode?: string,
  changeSystemPrompt?: null | { type: SystemPromptOp, value: string },
  noInstructionFiles?: boolean,
  noMemory?: boolean,
  noSkills?: boolean,
  noHooks?: boolean,
  noPlugins?: boolean,
  noMcp?: boolean,
  noAgents?: boolean,
  noTasks?: boolean,
  noCompact?: boolean,
  noIntegrations?: boolean,
  noHousekeeping?: boolean,
  noMothership?: boolean,
  noProcessEnv?: boolean,
  maxOutputLength?: null | number,
  extraEnv?: Record<string, string>,
  extraArgs?: string[],
  extraSettings?: JsonObject,
  callToAction: string
}

type LaunchConfig = Required<LaunchOptions>;

function LaunchConfig(o: LaunchOptions): LaunchConfig {
  return {
    cwd: o.cwd ?? null,
    ephemeralClaudeHomePath: o.ephemeralClaudeHomePath ?? null,
    customSessionData: o.customSessionData ?? null,
    launcher: o.launcher ?? 'claude',
    model: o.model ?? null,
    effortLevel: o.effortLevel ?? 'high',
    permissionMode: o.permissionMode ?? 'auto',
    changeSystemPrompt: o.changeSystemPrompt ?? null,
    noInstructionFiles: o.noInstructionFiles ?? true,
    noMemory: o.noMemory ?? true,
    noSkills: o.noSkills ?? true,
    noHooks: o.noHooks ?? true,
    noPlugins: o.noPlugins ?? true,
    noMcp: o.noMcp ?? true,
    noAgents: o.noAgents ?? true,
    noTasks: o.noTasks ?? true,
    noCompact: o.noCompact ?? true,
    noIntegrations: o.noIntegrations ?? true,
    noHousekeeping: o.noHousekeeping ?? true,
    noMothership: o.noMothership ?? true,
    noProcessEnv: o.noProcessEnv ?? false,
    maxOutputLength: o.maxOutputLength ?? null,
    extraEnv: o.extraEnv ?? {},
    extraArgs: o.extraArgs ?? [],
    extraSettings: o.extraSettings ?? {},
    callToAction: o.callToAction,
  };
}

export async function spawnClaude<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
>(launchOptions: LaunchOptions, spawnOptions: Bun.Spawn.SpawnOptions<In, Out, Err> = {}) {
  const c = LaunchConfig(launchOptions);

  const cwd = c.cwd ?? process.cwd();

  // Assumes directory to be created if path is supplied.
  const homeDir = c.ephemeralClaudeHomePath ?? await fs.mkdtemp(path.join(os.tmpdir(), 'bare-claude-home'));

  const s: JsonObject = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',

    // TODO: Shouldn't we have flags for these too?
    disableBypassPermissionsMode: true,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
    },

    ...c.extraSettings,
  };
  s.env = {
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1', // Less confusing for models.
  };

  const o: Bun.Spawn.SpawnOptions<In, Out, Err> & { cmd: string[] }= {
    ...spawnOptions,
    cwd,
    cmd: [] as string[],
    env: {
      ...(c.noProcessEnv ? {} : process.env),
      ...c.extraEnv, // TODO: Why don't we use spawnOptions here?
      CLAUDE_CONFIG_DIR: homeDir,
    },
  };

  const modelFlag = (c: LaunchConfig): string[] => (!c.model) ? [] : [ '--model', c.model ];
  const launcher: Record<Launcher, ()=>void> = {
    claude: () => o.cmd.push('claude', ...modelFlag(c)),
    ollama: () => o.cmd.push('ollama', 'launch', 'claude', ...modelFlag(c), '--yes', '--'),
  };

  launcher[c.launcher]();

  if (c.model) {
    s.model = c.model;
  }

  if (c.customSessionData) {
    o.cmd.push('--resume', c.customSessionData.sessionId);
  }

  o.cmd.push('--effort', c.effortLevel);
  s.effortLevel = c.effortLevel;

  o.cmd.push('--permission-mode', c.permissionMode);
  s.defaultMode = c.permissionMode;

  if (c.changeSystemPrompt) {
    const flags: Record<SystemPromptOp, string> = {
      'appendString': '--append-system-prompt',
      'appendFile': '--append-system-prompt-file',
      'setString': '--system-prompt',
      'setFile': '--system-prompt-file',
    };
    o.cmd.push(flags[c.changeSystemPrompt.type], c.changeSystemPrompt.value);
  }

  if (c.noInstructionFiles) {
    s.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  }

  if (c.noMemory) {
    s.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }

  if (c.noSkills) {
    o.cmd.push('--disable-slash-commands');
    s.env.CLAUDE_CODE_DISABLE_CRON = '1';
    s.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1';
  }

  if (c.noHooks) {
    s.disableAllHooks = true;
  }

  if (c.noPlugins) {
    s.enabledPlugins = {};
  }

  if (c.noMcp) {
    s.enableAllProjectMcpServers = false;
    s.enabledMcpjsonServers = [];
    s.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  }

  if (c.noAgents) {
    s.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = '1';
  }

  if (c.noTasks) {
    s.env.CLAUDE_CODE_ENABLE_TASKS = '0';
  }

  if (c.noCompact) {
    s.env.DISABLE_COMPACT = '1';
  }

  if (c.noIntegrations) {
    o.cmd.push('--no-chrome');
    s.disableDeepLinkRegistration = 'disable';
    s.autoConnectIde = false;
    s.autoInstallIdeExtension = false;
  }

  if (c.noHousekeeping) {
    s.cleanupPeriodDays = 99999;
    s.env.DISABLE_AUTOUPDATER = '1';
    s.env.DISABLE_INSTALLATION_CHECKS = '1';
  }

  // If using with Anthropic models, best set to false.
  if (c.noMothership) {
    s.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'; // May kill caching on some vendors if enabled.
    s.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'; // May kill caching with Antropic if enabled.
    s.env.CLAUDE_CODE_ENABLE_TELEMETRY = '0'; // May kill caching with Antropic if disabled.
  }

  if (c.maxOutputLength !== null) {
    s.env.TASK_MAX_OUTPUT_LENGTH = String(c.maxOutputLength);
    s.env.BASH_MAX_OUTPUT_LENGTH = String(c.maxOutputLength);
    s.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = String(c.maxOutputLength);
  }

  o.cmd.push(...c.extraArgs);

  o.cmd.push('--print', c.callToAction);

  if (c.customSessionData) {
    await Bun.file(path.join(homeDir, 'history.jsonl')).write(`${JSON.stringify({
      display: 'bare-claude',
      pastedContents: {},
      timestamp: Date.now(),
      project: path.resolve(cwd),
      sessionId: c.customSessionData.sessionId,
    })}\n`);

    const sessionDir = path.join(homeDir, 'projects', pathToFilename(cwd));
    fs.mkdir(sessionDir, { recursive: true });

    await Bun.file(
      path.join(sessionDir, `${c.customSessionData.sessionId}.jsonl`)
    ).write(c.customSessionData.value);
  }

  await Bun.file(path.join(homeDir, 'settings.json')).write(`${JSON.stringify(s, null, 2)}\n`);

  return Bun.spawn(o);
}
