import type { LaunchOptions } from '@agladysh/bare-claude';
import type { Config } from '@agladysh/bare-claude/config';
import type { PreloadEntry } from '@agladysh/bare-claude/preload';
import { deepmergeIntoCustom } from 'deepmerge-ts';

/**
 * A fully resolved run configuration: every `LaunchOptions` field, plus the
 * CLI-only fields that govern what the wrapper itself prints and preloads.
 */
export interface Preset extends LaunchOptions {
  /** Do not render the transcript. */
  quiet: boolean;

  /** Print what `claude --print` printed. */
  print: boolean;

  /** Render more of the transcript. */
  verbose: boolean;

  /** Print the resolved configuration and unrecognized events. */
  debug: boolean;

  /** Git pathspecs to preload as `Read` tool results. */
  read?: string[];

  /** Typed preload descriptors, resolved through `emitPreload`. */
  preload?: PreloadEntry[];

  /**
   * After the CLI receives SIGTERM, SIGINT or SIGHUP, how long the run gets
   * before everything left in its process group is sent SIGKILL. Defaults to
   * 10000.
   */
  stopGraceMs?: number;
}

/**
 * A preset as written in `bare-claude.yaml` or assembled from argv: every field
 * optional, `use` naming the presets it inherits from, and `read` accepting a
 * bare string as shorthand for a one-element list.
 */
export interface DynamicPreset extends Omit<Partial<Preset>, 'read'> {
  /** Preset ids to inherit from, merged left to right. Never itself inherited. */
  use?: string | string[];

  /** Git pathspecs to preload; a bare string means a one-element list. */
  read?: string | string[];
}

/**
 * A preset with its `use` chain folded in and `read` normalized, but before
 * defaults are applied. The honest type of a partial merge: `callToAction` and
 * the display flags may still be missing, so this is not yet a {@link Preset}.
 */
export type MergedPreset = Omit<DynamicPreset, 'use' | 'read'> & { read?: string[] };

/**
 * `deepmergeInto` with every in-place strategy made copy-on-merge. Its
 * defaults write into the record, array, set or map already at the target's
 * key, which may be one a layer passed in; these put a fresh one there first.
 * The root record is left alone (`meta` is undefined only there), because
 * `mergePresets` owns it and the merge must land in it.
 */
const mergeInto = deepmergeIntoCustom({
  mergeRecords: (target, _values, utils, meta) => {
    if (meta !== undefined) {
      target.value = {};
    }
    return utils.actions.defaultMerge;
  },
  mergeArrays: (target, values) => {
    target.value = values.flat();
  },
  mergeSets: (target, values) => {
    target.value = new Set(values.flatMap(set => [ ...set ]));
  },
  mergeMaps: (target, values) => {
    target.value = new Map(values.flatMap(map => [ ...map ]));
  },
});

/**
 * Deep-merges presets left to right into a new object, with `deepmerge-ts`'s
 * default semantics: records merge key by key at every depth, arrays
 * concatenate, an undefined value never overrides, and anything else is
 * replaced by the later value, by reference — functions and class instances
 * included, as `deepmerge` itself passes them.
 *
 * Not `deepmerge`, whose result type is computed from its arguments' types and
 * for a preset exceeds TypeScript's instantiation depth (TS2589). Like
 * `deepmerge`, it never changes what it is given: the top level is copied
 * here, and every nested record, array, set or map it merges is a new one (see
 * {@link mergeInto}). A value only one layer holds is shared with that layer,
 * as `deepmerge` shares it. Layers go in one at a time: given several sources,
 * `deepmergeInto` picks the strategy from the target's own value, so a key the
 * target holds as undefined would make two later records or arrays replace
 * rather than merge.
 * @param base - The least significant layer
 * @param layers - Later layers, each overriding everything before it
 * @returns A fresh merged object
 */
function mergePresets<T extends object>(base: T, ...layers: T[]): T {
  const merged = { ...base };
  for (const layer of layers) {
    mergeInto(merged, layer);
  }
  return merged;
}

function resolvePresetImpl(
  preset: DynamicPreset,
  presets: Record<string, DynamicPreset>,
  visited: string[]
): MergedPreset {
  const { use, read, ...rest } = preset;
  const result: MergedPreset = read === undefined
    ? rest
    : { ...rest, read: Array.isArray(read) ? read : [ read ] };

  if (!use) {
    return result;
  }

  const lastId = visited[visited.length - 1] ?? '<root>';

  // Used presets are folded left to right, so a later one overrides an earlier
  // one and their arrays concatenate in reading order. The referring preset is
  // applied last, so it always wins over everything it uses.
  let inherited: MergedPreset = {};
  for (const id of Array.isArray(use) ? use : [ use ]) {
    const using = presets[id];
    if (!using) {
      throw new Error(`Preset "${id}" referenced from "${lastId}" not found`);
    }

    inherited = mergePresets(inherited, resolvePresetImpl(using, presets, [ ...visited, id ]));
  }

  return mergePresets(inherited, result);
}

/**
 * Folds a preset's `use` chain into it and applies the display defaults.
 *
 * @param preset - The preset to resolve, typically the configuration file root merged with argv
 * @param presets - Named presets `use` may refer to
 * @returns A runnable configuration
 * @throws When `use` names a preset that does not exist, or nothing supplies a `callToAction`
 */
export function resolvePreset(preset: DynamicPreset, presets: Record<string, DynamicPreset>): Preset {
  return completePreset(resolvePresetImpl(preset, presets, []));
}

/**
 * Merges what one invocation says, the way a run merges it: the
 * configuration's root preset, then `overrides` (what the command line set)
 * on top, then the `use` chain — `use` replacing the root's own when given —
 * folded in. Nothing is required of the result, so the doctor can resolve an
 * invocation that has no call to action.
 * @param config - The configuration the invocation reads
 * @param overrides - Fields set on the command line
 * @param use - The preset id from `--use`, replacing the root preset's `use`;
 *   empty or absent leaves the root's in force
 * @returns The merged fields
 * @throws When `use` names a preset that does not exist
 */
export function mergeInvocation(config: Config, overrides: DynamicPreset, use?: string): MergedPreset {
  const preset = mergePresets(config.configPreset, overrides);
  if (use) {
    preset.use = use; // The use field is not merged.
  }
  return resolvePresetImpl(preset, config.presets, []);
}

/**
 * {@link mergeInvocation}, then the display defaults, as a runnable preset.
 * @throws As {@link mergeInvocation}, and when nothing supplies a `callToAction`
 */
export function resolveInvocation(config: Config, overrides: DynamicPreset, use?: string): Preset {
  return completePreset(mergeInvocation(config, overrides, use));
}

function completePreset(merged: MergedPreset): Preset {
  const { callToAction } = merged;
  if (callToAction === undefined) {
    throw new Error('failed to resolve preset: callToAction is undefined');
  }
  return {
    ...merged,
    callToAction,
    quiet: merged.quiet ?? false,
    print: merged.print ?? false,
    verbose: merged.verbose ?? false,
    debug: merged.debug ?? false,
  };
}
