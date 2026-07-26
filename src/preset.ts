import type { LaunchOptions } from '@agladysh/bare-claude';
import type { PreloadEntry } from '@agladysh/bare-claude/preload';
import { deepmerge } from 'deepmerge-ts';

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
type MergedPreset = Omit<DynamicPreset, 'use' | 'read'> & { read?: string[] };

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

    inherited = deepmerge(inherited, resolvePresetImpl(using, presets, [ ...visited, id ]));
  }

  return deepmerge(inherited, result);
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
  const merged = resolvePresetImpl(preset, presets, []);
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
