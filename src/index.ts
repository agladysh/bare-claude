import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deepmerge } from 'deepmerge-ts';

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
 * Narrows an arbitrary value to a {@link JsonObject}.
 * @param v - The value to test
 * @returns True when `v` is a non-null, non-array object
 */
function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merges JSON objects left to right, so the rightmost argument wins.
 *
 * Objects merge key by key at every depth and arrays concatenate, which is the
 * `deepmerge-ts` behaviour `src/preset.ts` already relies on.
 * @param objects - The objects to merge, least significant first
 * @returns The merged object
 */
function mergeJson(...objects: JsonObject[]): JsonObject {
  const merged: unknown = deepmerge(...objects);
  if (!isJsonObject(merged)) {
    // Unreachable: deepmerge of plain objects is a plain object. Guarded
    // rather than cast, because the library's return type is not JsonObject.
    throw new Error('deep merge of JSON objects did not produce a JSON object');
  }
  return merged;
}

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
 * Rejects call-to-action strings claude would misparse.
 *
 * Measured trap: a call to action starting with `-` is consumed by claude's
 * flag parser even after `--print`. On 2.1.220 that surfaces as
 * `error: unknown option` and exit 1 with empty stdout; older versions exited
 * 0 silently. Either way the run does nothing, so refuse it before spawning.
 * The workaround is to prefix the prompt, e.g. with `# `.
 * @param callToAction - The prompt about to be passed to `--print`
 */
export function assertSafeCallToAction(callToAction: string): void {
  if (callToAction.startsWith('-')) {
    throw new Error(
      'callToAction starts with "-" and claude would parse it as a flag, not a prompt. '
      + 'Prefix it, e.g. with "# ", to make it safe.'
    );
  }
}

/**
 * Markers Claude Code injects into processes it spawns, and reads back to
 * recognize itself as a child session. Inheriting them makes a bare run
 * believe it belongs to the session that launched it — it would report the
 * parent's session id and entrypoint. Auth variables are deliberately not in
 * this list: they are how a bare run authenticates.
 */
const parentSessionMarkers = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];

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
   * Path to the Claude Code executable. Defaults to `claude` on `PATH`.
   * Only affects the `claude` launcher's own argv[0] — the `ollama` launcher
   * spawns `ollama`, and the `claude` in its argv names what `ollama launch`
   * runs, not a filesystem path, so this option does not reach it.
   */
  claudePath?: string,

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
   * Whether to symlink the credential file from the real Claude config dir into
   * the ephemeral home, so a bare run keeps the subscription session. Only the
   * credential file is linked, never `.claude.json`, so the child cannot
   * clobber the real config, and a token refresh writes back through the link.
   *
   * Platform note: this only helps where Claude Code keeps credentials in a
   * file. On macOS they live in the login keychain and there is nothing to
   * link — use `CLAUDE_CODE_OAUTH_TOKEN` there. Defaults to true.
   */
  linkAuth?: boolean,

  /**
   * Tools the run may use, as passed to `--tools`. An empty array disables all
   * tools. Note that `--allowedTools ''` does *not*: it fails open, and the
   * model still reaches the filesystem. Defaults to null (Claude's default set).
   */
  tools?: null | string[],

  /**
   * Tools the run may not use, as passed to `--disallowed-tools`.
   * `['*']` blocks everything. Defaults to null.
   */
  disallowedTools?: null | string[],

  /**
   * Extra directories the run may reach, as passed to `--add-dir`. A headless
   * run cannot read outside its cwd without these.
   */
  addDirs?: string[],

  /**
   * Hard spend ceiling for the run in US dollars, as passed to
   * `--max-budget-usd`. Defaults to null (no ceiling).
   */
  maxBudgetUsd?: null | number,

  /**
   * Maximum tokens the model may generate, via `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
   * Distinct from `maxOutputLength`, which caps *tool* output going into
   * context. Note that exceeding this errors the turn rather than truncating
   * it. Defaults to null (default limit).
   */
  maxTokens?: null | number,

  /**
   * Maximum output length for various Claude components. Defaults to null (default limit).
   */
  maxOutputLength?: null | number,

  /**
   * Additional environment variables for the Claude *process*. Distinct from
   * `extraSettings.env`, which Claude Code applies to itself after startup.
   * See {@link spawnClaude} for where this sits in the environment precedence.
   */
  extraEnv?: Record<string, string>,

  /**
   * Additional command-line arguments to pass to Claude. Appended after every
   * flag this library derives and before the trailing `--print`.
   */
  extraArgs?: string[],

  /**
   * Additional settings deep-merged into Claude's `settings.json`, applied
   * last so a caller can override anything {@link buildSettings} derives —
   * including nested keys such as `permissions.defaultMode`, `sandbox.enabled`
   * and individual entries of the `env` block. Objects merge key by key at
   * every depth and arrays concatenate; there is no way to delete a key this
   * library writes, only to give it another value.
   */
  extraSettings?: JsonObject,

  /**
   * The call-to-action prompt to send to Claude.
   */
  callToAction: string
}

/**
 * A fully resolved {@link LaunchOptions}: every field present, every default
 * applied. This is the sole input to {@link buildArgv}, {@link buildEnv} and
 * {@link buildSettings}, so those three never have to re-derive a default.
 */
export type LaunchConfig = Required<LaunchOptions>;

/**
 * Converts LaunchOptions to a fully resolved LaunchConfig by applying defaults.
 * @param o - The launch options to convert
 * @returns A LaunchConfig with all fields resolved to non-optional values
 */
export function LaunchConfig(o: LaunchOptions): LaunchConfig {
  return {
    cwd: o.cwd ?? null,
    ephemeralClaudeHomePath: o.ephemeralClaudeHomePath ?? null,
    customSessionData: o.customSessionData ?? null,
    launcher: o.launcher ?? 'claude',
    claudePath: o.claudePath ?? 'claude',
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
    // Branches on the resolved launcher, not the raw option: omitting
    // `launcher` means `claude`, and must behave like passing it.
    noMothership: o.noMothership ?? ((o.launcher ?? 'claude') !== 'claude'),
    noProcessEnv: o.noProcessEnv ?? false,
    linkAuth: o.linkAuth ?? true,
    tools: o.tools ?? null,
    disallowedTools: o.disallowedTools ?? null,
    addDirs: o.addDirs ?? [],
    maxBudgetUsd: o.maxBudgetUsd ?? null,
    maxTokens: o.maxTokens ?? null,
    maxOutputLength: o.maxOutputLength ?? null,
    extraEnv: o.extraEnv ?? {},
    extraArgs: o.extraArgs ?? [],
    extraSettings: o.extraSettings ?? {},
    callToAction: o.callToAction,
  };
}

/**
 * Flags for each way of changing the system prompt. `--system-prompt` replaces
 * the built-in prompt; note that it does *not* suppress CLAUDE.md discovery,
 * which is what `noInstructionFiles` is for.
 */
const systemPromptFlags: Record<SystemPromptOp, string> = {
  'appendString': '--append-system-prompt',
  'appendFile': '--append-system-prompt-file',
  'setString': '--system-prompt',
  'setFile': '--system-prompt-file',
};

/**
 * Builds the complete command vector for a launch, `argv[0]` included.
 *
 * Pure: no filesystem, no clock, no environment. Every ordering constraint the
 * CLI imposes lives here, and one of them is load-bearing — `--print` and its
 * prompt are always the last two elements, because a flag after `--print` is
 * measured to be swallowed by the parser rather than treated as the prompt.
 * `extraArgs` is therefore appended just before them.
 * @param config - The resolved launch configuration
 * @param sessionId - The session id to run under; for a resumed run this is
 *   `customSessionData.sessionId`
 * @returns The command vector to hand to `Bun.spawn`
 * @throws If `config.launcher` is not a known launcher
 */
export function buildArgv(config: LaunchConfig, sessionId: string): string[] {
  if (!(config.launcher in Launchers)) {
    throw new Error(
      `Unknown launcher "${config.launcher}", known launchers are ${Object.keys(Launchers).join(', ')}`
    );
  }

  const modelFlag = config.model ? [ '--model', config.model ] : [];
  const launcherArgv: Record<Launcher, string[]> = {
    claude: [ config.claudePath, ...modelFlag ],
    // `claude` here is not a path: it is the target name `ollama launch`
    // takes, unrelated to config.claudePath, which only ever names a
    // filesystem executable. See the LaunchOptions.claudePath TSDoc.
    ollama: [ 'ollama', 'launch', 'claude', ...modelFlag, '--yes', '--' ],
  };

  const argv: string[] = [ ...launcherArgv[config.launcher] ];

  // A resumed session must be named with --resume; --session-id would ask for
  // a fresh one and collide with the transcript already on disk.
  argv.push(config.customSessionData ? '--resume' : '--session-id', sessionId);

  argv.push('--effort', config.effortLevel);
  argv.push('--permission-mode', config.permissionMode);

  // Only the ephemeral home's own settings.json may contribute; project and
  // local .claude/settings*.json would otherwise still be loaded, which is
  // the opposite of running bare.
  argv.push('--setting-sources', 'user');

  if (config.changeSystemPrompt) {
    argv.push(systemPromptFlags[config.changeSystemPrompt.type], config.changeSystemPrompt.value);
  }

  // TODO: This still feeds model a ton of skills
  if (config.noSkills) {
    argv.push('--disable-slash-commands');
  }

  if (config.noIntegrations) {
    // The only part of noIntegrations that is a CLI flag; the IDE half is env
    // vars, see buildSettings. Verified 2026-07-26 on 2.1.220: `--no-chrome`
    // parses, and an invented `--no-zzzchrome` is rejected with
    // `error: unknown option` plus a "Did you mean --no-chrome?" suggestion.
    argv.push('--no-chrome');
  }

  if (config.tools !== null) {
    // '' is the documented way to say "no tools"; an empty array must not
    // become a missing argument, which would swallow the next flag.
    argv.push('--tools', config.tools.join(','));
  }

  if (config.disallowedTools !== null) {
    argv.push('--disallowed-tools', config.disallowedTools.join(','));
  }

  for (const dir of config.addDirs) {
    argv.push('--add-dir', dir);
  }

  if (config.maxBudgetUsd !== null) {
    argv.push('--max-budget-usd', String(config.maxBudgetUsd));
  }

  argv.push(...config.extraArgs);

  // Measured (thai/oracle-runtime): --print must be the last flag before the
  // prompt text. Nothing may be appended after these two.
  argv.push('--print', config.callToAction);

  return argv;
}

/**
 * Inputs {@link buildEnv} needs that are not part of a {@link LaunchConfig}.
 */
export interface EnvContext {
  /**
   * Ephemeral `CLAUDE_CONFIG_DIR` for the run. Forced into the result last and
   * cannot be overridden: redirecting the config dir is what makes a run bare.
   */
  ephemeralClaudeHomePath: string,

  /**
   * Ambient environment to inherit, minus {@link parentSessionMarkers}.
   * Defaults to `process.env`. Ignored entirely when `noProcessEnv` is set.
   * Pass an explicit value to keep the call pure.
   */
  processEnv?: Record<string, string | undefined>,

  /**
   * The caller's `spawnOptions.env`, layered above the inherited environment
   * and below `extraEnv`. Taken as given — parent-session markers are not
   * stripped from it, since a caller naming one means it.
   */
  spawnEnv?: Record<string, string | undefined>,
}

/**
 * Builds the environment of the Claude *process*.
 *
 * Distinct from the `env` block {@link buildSettings} writes into
 * `settings.json`: this one is what the child is exec'd with, that one is what
 * Claude Code applies to itself once it has read its settings.
 *
 * Layered, later wins: inherited process environment (unless `noProcessEnv`,
 * and always minus the parent-session markers), then `spawnEnv`, then
 * `extraEnv`, then `CLAUDE_CONFIG_DIR`.
 * @param config - The resolved launch configuration
 * @param context - Run-specific values the config does not carry
 * @returns The environment to spawn the child with
 */
export function buildEnv(
  config: LaunchConfig,
  context: EnvContext
): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = {};
  if (!config.noProcessEnv) {
    Object.assign(inherited, context.processEnv ?? process.env);
    for (const marker of parentSessionMarkers) {
      delete inherited[marker];
    }
  }

  return {
    ...inherited,
    ...context.spawnEnv,
    ...config.extraEnv,
    CLAUDE_CONFIG_DIR: context.ephemeralClaudeHomePath,
  };
}

/**
 * Builds the `settings.json` written into the ephemeral Claude home.
 *
 * Pure: no filesystem, no clock, no environment. Claude Code ignores unknown
 * settings keys silently, so nesting matters more than it looks — every key
 * here is present in `https://json.schemastore.org/claude-code-settings.json`,
 * and that property must hold for anything added later.
 *
 * `extraSettings` is deep-merged last and therefore wins over everything
 * below, including the `env` block.
 * @param config - The resolved launch configuration
 * @returns The settings object, ready to serialize
 */
export function buildSettings(config: LaunchConfig): JsonObject {
  const env: JsonObject = {
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1', // Less confusing for models.
  };

  const settings: JsonObject = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',

    // TODO: Shouldn't we have flags for these too?
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // Verified 2026-07-26 against the settings schema and claude 2.1.220:
      // `failIfUnavailable` defaults to false, which means a host missing the
      // sandbox dependencies only logs a warning and then runs commands
      // *unsandboxed*. `autoAllowBashIfSandboxed` explicitly "only applies to
      // commands that will run sandboxed", so it evaporates in that case and
      // every Bash call falls back to a permission decision that headless
      // `--print` cannot prompt for. Failing at startup is the honest
      // outcome; Claude Code's own programmatic sandbox option does the same,
      // defaulting failIfUnavailable to true whenever enabled is true.
      failIfUnavailable: true,
    },
  };

  if (config.model) {
    settings.model = config.model;
  }

  settings.effortLevel = config.effortLevel;

  // Both of these live under `permissions`, and disableBypassPermissionsMode
  // is the string 'disable', not a boolean. At the settings root they are
  // unknown keys, which Claude Code drops without a word.
  settings.permissions = {
    defaultMode: config.permissionMode,
    disableBypassPermissionsMode: 'disable',
  };

  if (config.noInstructionFiles) {
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  }

  if (config.noMemory) {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  }

  if (config.noSkills) {
    env.CLAUDE_CODE_DISABLE_CRON = '1';
    env.CLAUDE_CODE_DISABLE_POLICY_SKILLS = '1';
  }

  if (config.noHooks) {
    settings.disableAllHooks = true;
  }

  if (config.noPlugins) {
    settings.enabledPlugins = {};
  }

  if (config.noMcp) {
    settings.enableAllProjectMcpServers = false;
    settings.enabledMcpjsonServers = [];
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  }

  if (config.noAgents) {
    env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = '1';
  }

  if (config.noTasks) {
    env.CLAUDE_CODE_ENABLE_TASKS = '0';
  }

  if (config.noCompact) {
    env.DISABLE_COMPACT = '1';
  }

  if (config.noIntegrations) {
    settings.disableDeepLinkRegistration = 'disable';
    // The IDE toggles are *not* settings keys. Verified 2026-07-26 against
    // 2.1.220: `autoConnectIde` and `autoInstallIdeExtension` are absent from
    // the settings schema and are read out of the global config store
    // (`.claude.json`, written by the /config panel), where they default to
    // false and true respectively. Writing them into settings.json did
    // nothing, and left extension auto-install on. These two env vars are the
    // documented route and are the values Claude Code actually checks:
    // auto-connect short-circuits on CLAUDE_CODE_AUTO_CONNECT_IDE === false,
    // and auto-install is skipped when CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL is
    // one of 1/true/yes/on.
    env.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';
    env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = '1';
  }

  if (config.noHousekeeping) {
    settings.cleanupPeriodDays = 99999;
    env.DISABLE_AUTOUPDATER = '1';
    env.DISABLE_INSTALLATION_CHECKS = '1';
  }

  // If using with Anthropic models, best set to false.
  if (config.noMothership) {
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'; // May kill caching on some vendors if enabled.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'; // May kill caching with Antropic if enabled.
    env.CLAUDE_CODE_ENABLE_TELEMETRY = '0'; // May kill caching with Antropic if disabled.
  }

  if (config.maxOutputLength !== null) {
    env.TASK_MAX_OUTPUT_LENGTH = String(config.maxOutputLength);
    env.BASH_MAX_OUTPUT_LENGTH = String(config.maxOutputLength);
    env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = String(config.maxOutputLength);
  }

  if (config.maxTokens !== null) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(config.maxTokens);
  }

  settings.env = env;

  return mergeJson(settings, config.extraSettings);
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
  /**
   * Removes the ephemeral Claude home directory, but only when spawnClaude
   * created it: a caller-supplied `ephemeralClaudeHomePath` is left alone.
   * Idempotent. Without this every spawn leaks a temporary directory.
   */
  dispose: () => Promise<void>,
};

/**
 * Spawns a Claude subprocess with the given launch options.
 *
 * The construction is factored out into {@link buildArgv}, {@link buildEnv}
 * and {@link buildSettings}, which are pure and individually testable; this
 * function resolves the config, calls them, does the filesystem work and
 * spawns. Anything that decides *what* claude is invoked with belongs in a
 * builder, not here.
 *
 * `spawnOptions` is forwarded to `Bun.spawn` except for two fields this
 * function resolves rather than passes through:
 *
 * - `cwd` — `launchOptions.cwd ?? spawnOptions.cwd ?? process.cwd()`. The
 *   winner is also what the ephemeral project directory is keyed on, so the
 *   spawn cwd and the session transcript path can never disagree.
 * - `env` — layered, later wins: the inherited process environment (unless
 *   `noProcessEnv`, and always minus the parent-session markers), then
 *   `spawnOptions.env`, then `launchOptions.extraEnv`, then
 *   `CLAUDE_CONFIG_DIR`. The last is forced and not overridable: pointing the
 *   child at the ephemeral config dir is what makes the run bare.
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

  assertSafeCallToAction(c.callToAction); // Before any filesystem work, so a refusal leaves nothing behind.

  const cwd = c.cwd ?? spawnOptions.cwd ?? process.cwd();
  const sessionId = c.customSessionData?.sessionId ?? Bun.randomUUIDv7();

  // Built before the filesystem work below for the same reason
  // assertSafeCallToAction runs first: an unknown launcher must not leave a
  // temporary directory behind.
  const cmd = buildArgv(c, sessionId);
  const settings = buildSettings(c);

  // Assumes directory to be created if path is supplied.
  const ownsClaudeHome = c.ephemeralClaudeHomePath === null;
  const ephemeralClaudeHomePath = c.ephemeralClaudeHomePath ?? await fs.mkdtemp(
    path.join(os.tmpdir(), 'bare-claude-home-')
  );

  // The ephemeral CLAUDE_CONFIG_DIR below leaves the child logged out. Symlink
  // — not copy — the credential file from the real config dir so no secret is
  // duplicated on disk and a refresh writes straight back through the link.
  // Only the credential file, never .claude.json.
  if (c.linkAuth && c.launcher === 'claude') {
    const realConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    for (const name of [ '.credentials.json', 'auth.json', 'credentials.json' ]) {
      const source = path.join(realConfigDir, name);
      if (await Bun.file(source).exists()) {
        try {
          await fs.symlink(source, path.join(ephemeralClaudeHomePath, name));
        } catch { /* Already linked, or something is there; either way, leave it. */ }
      }
    }
  }

  const projectHomePath = path.join(ephemeralClaudeHomePath, 'projects', pathToFilename(cwd));
  const sessionJsonlPath = path.join(projectHomePath, `${sessionId}.jsonl`)

  const o: Bun.Spawn.SpawnOptions<In, Out, Err> & { cmd: string[] } = {
    ...spawnOptions,
    cwd,
    cmd,
    env: buildEnv(c, { ephemeralClaudeHomePath, spawnEnv: spawnOptions.env }),
  };

  // Creating unconditionally to simplify watch() logic. Must complete before
  // the session file below is written and before the child is spawned.
  await fs.mkdir(projectHomePath, { recursive: true });

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

  await Bun.file(path.join(ephemeralClaudeHomePath, 'settings.json'))
    .write(`${JSON.stringify(settings, null, 2)}\n`);

  let disposed = false;

  return {
    subprocess: Bun.spawn(o),
    ephemeralClaudeHomePath: ephemeralClaudeHomePath,
    sessionId,
    projectHomePath,
    sessionJsonlPath,
    dispose: async () => {
      if (disposed || !ownsClaudeHome) {
        return;
      }
      disposed = true;
      await fs.rm(ephemeralClaudeHomePath, { recursive: true, force: true });
    },
  }
}
