import type { LaunchOptions } from '@agladysh/bare-claude';
import { deepmerge } from 'deepmerge-ts';

export interface Preset extends LaunchOptions {
  quiet: boolean;
  print: boolean;
  verbose: boolean;
  debug: boolean;
  read?: string[];
}

export interface DynamicPreset extends Omit<Partial<Preset>, 'read'> {
  use?: string | string[];
  read?: string | string[];
}

function resolvePresetImpl(
  preset: DynamicPreset,
  presets: Record<string, DynamicPreset>,
  visited: string[]
): Preset {
  let { use, ...result } = preset;
  if (result.read && !Array.isArray(result.read)) {
    result.read = [ result.read ];
  }

  if (!use) {
    return result as Preset;
  }

  if (!Array.isArray(use)) {
    use = [ use ];
  }

  const lastId = visited[visited.length - 1] ?? '<root>';
  for (const id of use) {
    const using = presets[id];
    if (!using) {
      throw new Error(`Preset "${id}" referenced from "${lastId}" not found`);
    }

    result = deepmerge(resolvePresetImpl(using, presets, [ ...visited, id ]), result);
  }

  return result as Preset;
}

export function resolvePreset(preset: DynamicPreset, presets: Record<string, DynamicPreset>): Preset {
  const result = resolvePresetImpl(preset, presets, []);
  if (result.callToAction === undefined) {
    throw new Error('failed to resolve preset: callToAction is undefined');
  }
  result.quiet ??= false;
  result.print ??= false;
  result.verbose ??= false;
  result.debug ??= false;
  return result;
}