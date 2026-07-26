import { scope, type } from 'arktype';

import type { DynamicPreset } from '@agladysh/bare-claude/preset';

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
  'customSessionData?': type({ '+': 'reject', sessionId: 'string', value: 'string' }).or('null'),
  'addDirs?': 'string[]',
  'linkAuth?': 'boolean',
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
