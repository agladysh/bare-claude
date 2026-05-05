import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Represents a JSON structure that can be either an object or array.
 */
export type JsonStructure = JsonObject | JsonArray

/**
 * Interface representing a JSON object with string keys and Json values.
 */
export interface JsonObject {
	[k: string]: Json
}

/**
 * Represents a JSON array containing Json values.
 */
export type JsonArray = Json[]

/**
 * Represents a JSON primitive value (string, boolean, number, or null).
 */
export type JsonPrimitive = string | boolean | number | null

/**
 * Represents any valid JSON value - either a structure (object/array) or primitive.
 */
export type Json = JsonStructure | JsonPrimitive

/**
 * Sanitizes a string for use as a filename by replacing non-alphanumeric characters with hyphens.
 * @param s - The string to sanitize
 * @returns A sanitized string safe for use as a filename
 */
function sanitizeForFilename(s: string) {
  return s.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Converts a file path to a filename suitable for filesystem use.
 * @param path - The file path to convert
 * @returns A sanitized filename, truncated with hash if too long
 */
function pathToFilename(path: string): string {
  const maxLength = 200;
  const filename = sanitizeForFilename(path);
  return filename.length <= maxLength
    ? filename
    : `${filename.slice(0, maxLength)}-${Bun.hash(path).toString(36)}`;
}

/**
 * Available launcher types for spawning Claude processes.
 */
export const Launchers = {
  claude: 'claude',
  ollama: 'ollama',
} as const;

/**
 * Type representing all possible launcher values.
 */
export type Launchers = typeof Launchers;

/**
 * Type representing a single launcher key.
 */
export type Launcher = keyof Launchers;
/**
 * Operations that can be performed to modify the system prompt.
 */
type SystemPromptOp = 'appendString' | 'setString' | 'appendFile' | 'setFile';

// TODO: Support worktrees.
/**
 * Options for launching a Claude subprocess.
 */
export interface LaunchOptions {
  /**
   * Working directory for the Claude process. Defaults to process.cwd().
   */
  cwd?: string | null,

  /**
   * Path to ephemeral Claude home directory. If not provided, a temporary directory will be created.
   */
  ephemeralClaudeHomePath?: string | null,

  /**
   * Custom session data to use for resuming a session.
   */
  customSessionData?: null | { sessionId: string, value: string },

  /**
   * Launcher to use for spawning Claude. Defaults to 'claude'.
   */
  launcher?: Launcher,

  /**
   * Model to use for Claude. Defaults to null (uses Claude's default).
   */
  model?: null | string,

  /**
   * Effort level for Claude. Defaults to 'high'.
   */
  effortLevel?: string,

  /**
   * Permission mode for Claude. Defaults to 'auto'.
   */
  permissionMode?: string,

  /**
   * Configuration for modifying the system prompt.
   */
  changeSystemPrompt?: null | { type: SystemPromptOp, value: string },

  /**
   * Whether to disable instruction files. Defaults to true.
   */
  noInstructionFiles?: boolean,

  /**
   * Whether to disable memory. Defaults to true.
   */
  noMemory?: boolean,

  /**
   * Whether to disable skills. Defaults to true.
   */
  noSkills?: boolean,

  /**
   * Whether to disable hooks. Defaults to true.
   */
  noHooks?: boolean,

  /**
   * Whether to disable plugins. Defaults to true.
   */
  noPlugins?: boolean,

  /**
   * Whether to disable MCP. Defaults to true.
   */
  noMcp?: boolean,

  /**
   * Whether to disable agents. Defaults to true.
   */
  noAgents?: boolean,

  /**
   * Whether to disable tasks. Defaults to false.
   */
  noTasks?: boolean,

  /**
   * Whether to disable compact. Defaults to true.
   */
  noCompact?: boolean,

  /**
   * Whether to disable integrations. Defaults to true.
   */
  noIntegrations?: boolean,

  /**
   * Whether to disable housekeeping. Defaults to true.
   */
  noHousekeeping?: boolean,

  /**
   * Whether to disable calling the mothership.
   * Defaults to false when launcher is claude, true otherwise.
   */
  noMothership?: boolean,

  /**
   * Whether to disable process environment inheritance. Defaults to false.
   */
  noProcessEnv?: boolean,

  /**
   * Maximum output length for various Claude components. Defaults to null (default limit).
   */
  maxOutputLength?: null | number,

  /**
   * Additional environment variables to set for the Claude process.
   */
  extraEnv?: Record<string, string>,

  /**
   * Additional command-line arguments to pass to Claude.
   */
  extraArgs?: string[],

  /**
   * Additional settings to merge into Claude's configuration.
   */
  extraSettings?: JsonObject,

  /**
   * The call-to-action prompt to send to Claude.
   */
  callToAction: string
}

/**
 * Type representing a fully resolved launch configuration with all required fields.
 */
type LaunchConfig = Required<LaunchOptions>;

/**
 * Converts LaunchOptions to a fully resolved LaunchConfig by applying defaults.
 * @param o - The launch options to convert
 * @returns A LaunchConfig with all fields resolved to non-optional values
 */
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
    noTasks: o.noTasks ?? false,
    noCompact: o.noCompact ?? true,
    noIntegrations: o.noIntegrations ?? true,
    noHousekeeping: o.noHousekeeping ?? true,
    noMothership: o.noMothership ?? (o.launcher === 'claude' ? false : true),
    noProcessEnv: o.noProcessEnv ?? false,
    maxOutputLength: o.maxOutputLength ?? null,
    extraEnv: o.extraEnv ?? {},
    extraArgs: o.extraArgs ?? [],
    extraSettings: o.extraSettings ?? {},
    callToAction: o.callToAction,
  };
}

/**
 * Represents a spawned Claude subprocess with associated metadata.
 * @template In - The type of writable stdin stream
 * @template Out - The type of readable stdout stream
 * @template Err - The type of readable stderr stream
 */
interface ClaudeSubprocess<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
> {
  /** The spawned Bun subprocess */
  subprocess: Bun.Subprocess<In, Out, Err>,
  /** Path to the ephemeral Claude home directory */
  ephemeralClaudeHomePath: string,
  /** Unique identifier for the Claude session */
  sessionId: string,
  /** Path to the project home directory within Claude home */
  projectHomePath: string,
  /** Path to the JSONL session file */
  sessionJsonlPath: string,
};

/**
 * Spawns a Claude subprocess with the given launch options.
 * @template In - The type of writable stdin stream
 * @template Out - The type of readable stdout stream
 * @template Err - The type of readable stderr stream
 * @param launchOptions - Configuration options for launching Claude
 * @param spawnOptions - Optional Bun spawn options for customizing the subprocess
 * @returns A Promise that resolves to a ClaudeSubprocess containing the spawned process and metadata
 */
export async function spawnClaude<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
>(
  launchOptions: LaunchOptions,
  spawnOptions: Bun.Spawn.SpawnOptions<In, Out, Err> = {}
): Promise<ClaudeSubprocess<In, Out, Err>> {
  const c = LaunchConfig(launchOptions);
  const cwd = c.cwd ?? process.cwd();

  // Assumes directory to be created if path is supplied.
  const ephemeralClaudeHomePath = c.ephemeralClaudeHomePath ?? await fs.mkdtemp(
    path.join(os.tmpdir(), 'bare-claude-home')
  );

  const sessionId = c.customSessionData?.sessionId ?? Bun.randomUUIDv7();
  const projectHomePath = path.join(ephemeralClaudeHomePath, 'projects', pathToFilename(cwd));
  const sessionJsonlPath = path.join(projectHomePath, `${sessionId}.jsonl`)

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
      CLAUDE_CONFIG_DIR: ephemeralClaudeHomePath,
    },
  };

  const modelFlag = (c: LaunchConfig): string[] => (!c.model) ? [] : [ '--model', c.model ];
  const launcher: Record<Launcher, ()=>void> = {
    claude: () => o.cmd.push('claude', ...modelFlag(c)),
    ollama: () => o.cmd.push('ollama', 'launch', 'claude', ...modelFlag(c), '--yes', '--'),
  };

  if (!(c.launcher in Launchers)) {
    throw new Error(
      `Unknown launcher "${c.launcher}", known launchers are ${Object.keys(launcher).join(', ')}`
    );
  }

  launcher[c.launcher]();

  if (c.model) {
    s.model = c.model;
  }

  if (c.customSessionData) {
    o.cmd.push('--resume', c.customSessionData.sessionId);
  } else {
    o.cmd.push('--session-id', sessionId);
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

  // TODO: This still feeds model a ton of skills
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

  // Creating unconditionally to simplify watch() logic.
  fs.mkdir(projectHomePath, { recursive: true });

  if (c.customSessionData) {
    await Bun.file(path.join(ephemeralClaudeHomePath, 'history.jsonl')).write(`${JSON.stringify({
      display: 'bare-claude',
      pastedContents: {},
      timestamp: Date.now(),
      project: path.resolve(cwd),
      sessionId: c.customSessionData.sessionId,
    })}\n`);
    await Bun.file(sessionJsonlPath).write(c.customSessionData.value);
  }

  await Bun.file(path.join(ephemeralClaudeHomePath, 'settings.json')).write(`${JSON.stringify(s, null, 2)}\n`);

  return {
    subprocess: Bun.spawn(o),
    ephemeralClaudeHomePath: ephemeralClaudeHomePath,
    sessionId,
    projectHomePath,
    sessionJsonlPath,
  }
}
