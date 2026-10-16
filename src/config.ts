import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { scope, type } from 'arktype';

import { composeConfigs, type ConfigLayer, type DynamicPreset } from '@agladysh/bare-claude/preset';

/**
 * Runtime schema for `bare-claude.yaml`.
 *
 * The configuration file is hand-written, and every key it carries ends up in
 * either a `claude` flag or the generated `settings.json`. Both punish a typo,
 * and one of them punishes it silently: `claude --help` states, under `-p`,
 * that "settings files that fail validation are silently ignored in this mode
 * (no error dialog is shown)". One bad `permissionMode` therefore takes
 * `disableAllHooks`, `enabledPlugins` and the whole `env` block down with it,
 * and the run proceeds looking healthy while being anything but bare.
 *
 * So the schema is strict: an unknown key is an error, not a warning. This file
 * is written by hand and read by nobody but this program — there is no
 * forward-compatibility argument for tolerating a key it does not understand,
 * and a warning printed to stderr is exactly what a `--quiet --print` pipeline
 * throws away. `extraArgs`, `extraEnv` and `extraSettings` are the declared
 * escape hatches for anything this schema does not model.
 */

/** Anything `JSON.stringify` round-trips, for the free-form settings block. */
const json = scope({
  json: 'jsonPrimitive | jsonObject | jsonArray',
  jsonPrimitive: 'string | number | boolean | null',
  jsonObject: { '[string]': 'json' },
  jsonArray: 'json[]',
}).export();

/**
 * Effort levels `claude` accepts, verified against `claude --effort` on 2.1.220
 * (2026-07-26). Note the settings-file mirror `effortLevel` documents only
 * `low`/`medium`/`high`/`xhigh`, so `max` reaches the flag but may not survive
 * settings validation.
 */
export const effortLevel = type("'low' | 'medium' | 'high' | 'xhigh' | 'max'");

/** An effort level `claude` accepts. */
export type EffortLevel = typeof effortLevel.infer;

/**
 * Permission modes safe to pass through this library, verified 2026-07-26 on
 * 2.1.220. This is deliberately the *intersection* of two vocabularies, because
 * `spawnClaude` writes the value to both: `--permission-mode` accepts
 * `manual` but the settings schema does not, and `permissions.defaultMode`
 * accepts `default` and `delegate` but the flag does not. A value from either
 * private half fails — `manual` silently, by invalidating the settings file.
 */
export const permissionMode = type(
  "'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'plan'"
);

/** A permission mode both the flag and the settings file accept. */
export type PermissionMode = typeof permissionMode.infer;

/** Who supplies the child's credential; see `AuthMode` in the main module. */
export const authMode = type("'fallback' | 'caller'");

/**
 * A session id that can name a journal file. The same expression as
 * `sessionIdPattern` in the main module, which `LaunchConfig` enforces; a
 * test holds the two together.
 */
export const sessionIdSchema = type('/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/');

/**
 * A session to continue: in memory, or from a journal file. The two shapes
 * share no key but `sessionId`, and each rejects the other's, so a seed that
 * names both `value` and `sourcePath` is an error rather than a guess.
 */
const sessionSeed = type({ '+': 'reject', sessionId: sessionIdSchema, value: 'string' })
  .or({
    '+': 'reject',
    sessionId: sessionIdSchema,
    sourcePath: 'string',
    'sourceSha256?': '/^[a-f0-9]{64}$/',
  });

/** Mirrors the `PreloadEntry` tagged union from `./preload.ts`. */
const preloadEntry = type({ '+': 'reject', type: "'file'", path: 'string' })
  .or({ '+': 'reject', type: "'glob'", pattern: 'string' })
  .or({ '+': 'reject', type: "'shell'", cmd: 'string', 'description?': 'string' })
  .or({ '+': 'reject', type: "'ls'", path: 'string' })
  .or({ '+': 'reject', type: "'inline'", text: 'string', 'label?': 'string' });

/**
 * A preset as written in the configuration file: every `LaunchOptions` field,
 * every CLI-only field, and the scalar-or-array leniency the README documents
 * for `use` and `read`. Everything is optional — resolution, not validation,
 * decides whether the merged result is runnable.
 */
const preset = type({
  '+': 'reject',

  // Composition. Not merged: a preset's own `use` is consumed, never inherited.
  'use?': 'string | string[]',

  // The CLI-only half of a preset: transcript rendering and output.
  'quiet?': 'boolean',
  'print?': 'boolean',
  'verbose?': 'boolean',
  'debug?': 'boolean',
  'stopGraceMs?': 'number.integer >= 0',
  'custody?': type({ '+': 'reject', directory: 'string', 'keepCallToAction?': 'boolean' }),

  // Preloaded context. `read` is preload's file/glob case, kept separate
  // because it is also a flag.
  'read?': 'string | string[]',
  'preload?': preloadEntry.array(),

  // What to run.
  'callToAction?': 'string',
  'launcher?': "'claude' | 'ollama'",
  'claudePath?': 'string',
  'model?': 'string | null',
  'effortLevel?': effortLevel,
  'permissionMode?': permissionMode,
  'changeSystemPrompt?': type({
    '+': 'reject',
    type: "'appendString' | 'setString' | 'appendFile' | 'setFile'",
    value: 'string',
  }).or('null'),

  // Where it runs.
  'cwd?': 'string | null',
  'ephemeralClaudeHomePath?': 'string | null',
  'customSessionData?': sessionSeed.or('null'),
  'addDirs?': 'string[]',
  'auth?': authMode,
  'linkAuth?': 'boolean',
  'tokenFile?': 'string | null',
  'noProcessEnv?': 'boolean',

  // What it may do.
  'tools?': 'string[] | null',
  'disallowedTools?': 'string[] | null',
  'maxBudgetUsd?': 'number > 0 | null',
  'maxTokens?': 'number.integer > 0 | null',
  'maxOutputLength?': 'number.integer > 0 | null',

  // How bare it runs.
  'noInstructionFiles?': 'boolean',
  'noMemory?': 'boolean',
  'noSkills?': 'boolean',
  'noHooks?': 'boolean',
  'noPlugins?': 'boolean',
  'noMcp?': 'boolean',
  'noAgents?': 'boolean',
  'noTasks?': 'boolean',
  'noCompact?': 'boolean',
  'noIntegrations?': 'boolean',
  'noHousekeeping?': 'boolean',
  'noBashEditDiff?': 'boolean',
  'noMothership?': 'boolean',

  // Escape hatches, deliberately unconstrained.
  'extraEnv?': { '[string]': 'string' },
  'extraArgs?': 'string[]',
  'extraSettings?': json.jsonObject,
});

/** The configuration file: a root preset plus the named presets it may use. */
const configFile = type({
  '...': preset,
  '+': 'reject',
  'presets?': { '[string]': preset },
});

/**
 * Compile-time drift guard. `T` names any key the schema and
 * {@link DynamicPreset} disagree about; both instantiations below must resolve
 * to `never` or this file does not typecheck. Without it, a new `LaunchOptions`
 * field would be documented, accepted by the API, and rejected in YAML as an
 * unknown key.
 */
type AssertNoDrift<T extends never> = T;

type _SchemaModelsEveryPresetField = AssertNoDrift<
  Exclude<keyof DynamicPreset, keyof typeof preset.infer>
>;

type _PresetHasEverySchemaField = AssertNoDrift<
  Exclude<keyof typeof preset.infer, keyof DynamicPreset>
>;

type _SchemaAcceptsEveryAuthMode = AssertNoDrift<
  Exclude<NonNullable<DynamicPreset['auth']>, typeof authMode.infer>
>;

/**
 * A parsed and validated `bare-claude.yaml`.
 */
export interface Config {
  /** The root preset: every top-level key except `presets`. */
  configPreset: DynamicPreset,

  /** Named presets, by preset id. */
  presets: Record<string, DynamicPreset>,
}

/** The empty configuration, for when there is no file to read. */
export const emptyConfig = (): Config => ({ configPreset: {}, presets: {} });

/** Name of the configuration file, looked up at the root of the Git working copy. */
export const configFileName = 'bare-claude.yaml';

/**
 * Where the configuration file would be read from: `bare-claude.yaml` at the
 * root of the Git working copy containing `cwd`. The file need not exist —
 * this answers "which file", and the caller decides what a missing one means.
 *
 * Both the CLI and `--doctor` resolve through here, so what the doctor
 * reports is by construction what a run would load.
 * @param cwd - Directory to resolve from; defaults to the process cwd
 * @returns The configuration file path, or null when `cwd` is not inside a
 *   Git working copy
 */
export async function locateConfig(cwd: string = process.cwd()): Promise<string | null> {
  // TODO: Use cosmiconfig instead?
  // TODO: Verify this handles git submodules and git worktrees correctly.
  const git = Bun.spawn({
    cmd: [ 'git', 'rev-parse', '--show-toplevel' ],
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [ stdout, exitCode ] = await Promise.all([
    new Response(git.stdout).text(),
    git.exited,
  ]);
  if (exitCode !== 0) {
    return null;
  }
  return path.join(stdout.trim(), configFileName);
}

/**
 * Which configuration a run reads.
 *
 * - `located`: `bare-claude.yaml` at the root of the Git working copy, see
 *   {@link locateConfig}. Optional: a missing file is the empty configuration.
 * - `file`: the file at `path`, which must exist. No Git working copy is
 *   needed. Several named files are read by {@link loadConfigFiles}.
 * - `none`: no file at all, so nothing but the caller's own options and the
 *   library defaults applies — in particular nothing from a repository's
 *   example configuration.
 */
export type ConfigSource =
  | { kind: 'located' }
  | { kind: 'file', path: string }
  | { kind: 'none' };

/**
 * One configuration file as it was read: the name it was read by, the file
 * that name led to, and the size and SHA-256 of exactly the bytes that were
 * parsed. Never what they say: a configuration file can hold a credential,
 * in `extraEnv` for one. A digest is not the content, but anyone holding a
 * candidate file can confirm it against one.
 */
export interface ConfigFileRecord {
  /** As named, made absolute against the process cwd; symbolic links kept. */
  path: string,

  /**
   * `path` with every symbolic link resolved, just after the bytes were read,
   * and only when what it resolved to is the file read, by device and inode.
   * Null when the name led elsewhere by then, or could not be resolved.
   */
  realPath: string | null,

  bytes: number,
  sha256: string,
}

/** Where a configuration was read from: by which route, and which files, in the order composed. */
export interface ConfigProvenance {
  /**
   * The route: a {@link ConfigSource} kind, or `files` for
   * {@link readConfigFiles}, which is what the CLI reads any `--config` by.
   */
  source: ConfigSource['kind'] | 'files',

  /** Every file read, least significant first. Empty when none was, a located file that does not exist included. */
  files: ConfigFileRecord[],
}

/** A validated configuration and where it was read from. */
export interface ConfigReading {
  config: Config,
  provenance: ConfigProvenance,
}

/** Narrows a thrown value to the errno `code` a Node system error carries. */
function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

/** One file read once, through one handle, and parsed from those same bytes. */
interface FileRead {
  config: Config,
  record: ConfigFileRecord,

  /** Device and inode of the file read, so two names for one file are one file. */
  identity: string,
}

/**
 * `file` with every symbolic link resolved, when it is still the file of
 * `identity`; null when it now names another, or cannot be resolved.
 */
async function realPathOf(file: string, identity: string): Promise<string | null> {
  try {
    const resolved = await fs.realpath(file);
    const stat = await fs.stat(resolved);
    return `${stat.dev}:${stat.ino}` === identity ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Opens `configPath` once and reads it whole through that handle; the digest
 * and the parse are both of those bytes. There is no second read to drift
 * from the first: no existence check before it, and nothing read again after.
 * Opened without blocking, so a FIFO is refused as not a regular file rather
 * than waited on for a writer; the flag changes nothing for a regular file.
 * @returns The reading, or null when nothing exists at that path
 */
async function readOnce(configPath: string): Promise<FileRead | null> {
  const absolute = path.resolve(configPath);
  let handle: FileHandle;
  try {
    handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`configuration file ${configPath} is not a regular file`);
    }
    const bytes = await handle.readFile();
    const config = parseConfig(new TextDecoder().decode(bytes), configPath);
    const identity = `${stat.dev}:${stat.ino}`;
    return {
      config,
      record: {
        path: absolute,
        realPath: await realPathOf(absolute, identity),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      identity,
    };
  } finally {
    await handle.close();
  }
}

/** A named configuration file, which must exist, read once and validated. */
async function readNamedFile(configPath: string): Promise<FileRead> {
  const read = await readOnce(configPath);
  if (read === null) {
    throw new Error(`configuration file ${configPath} does not exist`);
  }
  return read;
}

/**
 * Reads the configuration a {@link ConfigSource} selects, and says which file
 * it was read from.
 * @param source - Which configuration to read
 * @param cwd - Directory a `located` configuration is resolved from
 * @returns The validated configuration and its provenance
 * @throws When a `located` configuration is asked for outside a Git working
 *   copy, a named file does not exist, or the file is invalid
 */
export async function readConfig(source: ConfigSource, cwd: string = process.cwd()): Promise<ConfigReading> {
  switch (source.kind) {
    case 'none':
      return { config: emptyConfig(), provenance: { source: 'none', files: [] } };

    case 'file': {
      const { config, record } = await readNamedFile(source.path);
      return { config, provenance: { source: 'file', files: [ record ] } };
    }

    case 'located': {
      const configPath = await locateConfig(cwd);
      if (configPath === null) {
        throw new Error(
          `${cwd} is not inside a Git working copy, which is where ${configFileName} is looked up; `
          + 'name a file with --config, or read none with --no-config'
        );
      }
      const read = await readOnce(configPath);
      return read === null
        ? { config: emptyConfig(), provenance: { source: 'located', files: [] } }
        : { config: read.config, provenance: { source: 'located', files: [ read.record ] } };
    }
  }
}

/**
 * Reads the configuration a {@link ConfigSource} selects.
 * @param source - Which configuration to read
 * @param cwd - Directory a `located` configuration is resolved from
 * @returns The validated configuration
 * @throws As {@link readConfig}
 */
export async function loadConfig(source: ConfigSource, cwd: string = process.cwd()): Promise<Config> {
  return (await readConfig(source, cwd)).config;
}

/**
 * Reads named configuration files, each of which must exist, each once,
 * validates each on its own, and composes them in order with
 * `composeConfigs` from `@agladysh/bare-claude/preset`: later files over
 * earlier ones, named presets pooled. One canonical profile and one run's own
 * declaration, say, neither copied into the other. No Git working copy is
 * needed. One file is refused the second time it is named, by the same name
 * or another: a symbolic link to it, a path through a linked directory.
 * @param paths - The files, least significant first
 * @returns The composed configuration, and every file read with the digest
 *   of the bytes parsed, in order
 * @throws When no file, or one file twice, is named; when a file does not
 *   exist or is invalid; when the files do not compose
 */
export async function readConfigFiles(paths: readonly string[]): Promise<ConfigReading> {
  if (paths.length === 0) {
    throw new Error('no configuration file is named');
  }
  const named = new Set<string>();
  const read = new Map<string, string>();
  const layers: ConfigLayer[] = [];
  const files: ConfigFileRecord[] = [];
  for (const configPath of paths) {
    const resolved = path.resolve(configPath);
    if (named.has(resolved)) {
      throw new Error(`configuration file ${configPath} is named twice`);
    }
    named.add(resolved);
    const { config, record, identity } = await readNamedFile(configPath);
    const earlier = read.get(identity);
    if (earlier !== undefined) {
      throw new Error(`configuration file ${configPath} is named twice: it is the file ${earlier} names`);
    }
    read.set(identity, configPath);
    layers.push({ source: configPath, config });
    files.push(record);
  }
  return { config: composeConfigs(layers), provenance: { source: 'files', files } };
}

/**
 * {@link readConfigFiles}, the composed configuration alone.
 * @throws As {@link readConfigFiles}
 */
export async function loadConfigFiles(paths: readonly string[]): Promise<Config> {
  return (await readConfigFiles(paths)).config;
}

/** A YAML mapping, the only shape a configuration file may have at its root. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses configuration file text and validates it against the schema.
 *
 * Throws with the offending path and the value that failed — `bin/bare-claude`
 * turns a thrown message into a one-line diagnostic and exit 1.
 *
 * @param text - Configuration file contents
 * @param source - Path to name in error messages
 * @returns The root preset and the named presets, separated
 */
export function parseConfig(text: string, source = 'bare-claude.yaml'): Config {
  let data: unknown;
  try {
    data = Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  // An empty file parses to null or undefined, and a preset is allowed to be
  // empty, so the degenerate configuration file is valid.
  if (data === null || data === undefined) {
    return emptyConfig();
  }

  if (!isMapping(data)) {
    throw new Error(
      `${source} must be a mapping of preset fields at its root, got ${
        Array.isArray(data) ? 'a list' : `a ${typeof data}`}`
    );
  }

  const validated = configFile(data);
  if (validated instanceof type.errors) {
    throw new Error(
      `${source} is invalid:\n${validated.summary.split('\n').map(line => `  ${line}`).join('\n')}`
    );
  }

  const { presets = {}, ...configPreset } = validated;
  return { configPreset, presets };
}
