#!/usr/bin/env bun

import { $ } from 'bun';

import { parseArgs } from 'node:util';
import path from 'node:path';
import { watch } from 'node:fs/promises';

import TailFile from '@logdna/tail-file';
import { isBinaryFile } from 'isbinaryfile';

import { Launchers, spawnClaude, type Launcher, type LaunchOptions } from '@agladysh/bare-claude';
import { displayClaudeEvent } from '@agladysh/bare-claude/display';
import { SessionBuilder } from '@agladysh/bare-claude/SessionBuilder';

import pkg from '../package.json';
import { resolvePreset, type DynamicPreset, type Preset } from '@agladysh/bare-claude/preset';
import { deepmerge } from 'deepmerge-ts';

///////////////////////////////////////////////////////////////////////////////

function displayHelp() {
  // TODO: Write better help text
  process.stdout.write(
    `Usage: ${Object.keys(pkg.bin)[0]} [--launcher=claude|ollama] [--model=<model>] [--quiet] [--print] [--read=<file>] "call to action"\n`
  );
}

interface Config {
  configPreset: DynamicPreset;
  presets: Record<string, DynamicPreset>;
}

async function loadConfig(): Promise<Config> {
  // TODO: Use cosmiconfig instead?
  // TODO: Verify this handles git submodules and git worktrees correctly.
  const rootDir = (await $ `git rev-parse --show-toplevel`.text()).trim();
  const configFile = Bun.file(path.join(rootDir, 'bare-claude.yaml'));
  if (!await configFile.exists()) {
    return { configPreset: {}, presets: {} };
  }
  // TODO: This needs a data correctness guard!
  const { presets, ...configPreset } = Bun.YAML.parse(
    await configFile.text()
  ) as DynamicPreset & { presets: Config['presets'] };

  return { configPreset, presets };
}

async function loadPreset(): Promise<Preset | null> {
  const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
      use: {
        type: 'string',
        short: 'u',
      },
      launcher: {
        type: 'string',
        short: 'l',
      },
      model: {
        type: 'string',
        short: 'm',
      },
      verbose: {
        type: 'boolean',
        default: false,
      },
      read: {
        type: 'string',
        short: 'r',
        multiple: true
      },
      // TODO: support emitBash() as well?
      debug: {
        type: 'boolean',
        default: false,
      },
      quiet: {
        type: 'boolean',
        short: 'q',
        default: false,
      },
      print: {
        type: 'boolean',
        short: 'p',
        default: false,
      },
      version: {
        type: 'boolean',
        short: 'v',
        default: false,
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
      display: {
        type: 'string',
      },
    },
    strict: true,
    allowPositionals: true,
  });

  positionals.shift(); // Bun
  positionals.shift(); // Script name

  if (values.help) {
    displayHelp();
    return null;
  }

  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return null;
  }

  if (values.display) {
    const result = Bun.JSONL.parse(await Bun.file(values.display).text());
    for (const event of result) {
      process.stdout.write(displayClaudeEvent(event, values));
    }
    return null;
  }

  const { configPreset, presets } = await loadConfig();
  const preset = deepmerge(configPreset, {
    ...values, // TODO: If we're being pedantic, we should validate launcher here too.
    callToAction: positionals.length > 0 ? positionals.join(' ') : undefined
  } as DynamicPreset);
  if (values.use) {
    preset.use = values.use; // The use field is not merged.
  }

  return resolvePreset(preset, presets);
}

async function globFilenames(patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }

  const output = await $ `git ls-files --cached --others --exclude-standard --deduplicate -z -- ${patterns}`.text();

  return output.split('\0').filter(Boolean);
}

async function main() {
  const preset = await loadPreset();
  if (preset === null) {
    return 0;
  }

  const filenames = await globFilenames(preset.read ?? []);
  if (filenames.length > 0) {
    const sessionId = preset.customSessionData?.sessionId ?? Bun.randomUUIDv7();

    // TODO: Load Claude Code version and git branch from preset,
    //       make sure they are filled with defaults there.
    const builder = new SessionBuilder(
      sessionId,
      (await $ `claude --version`.text()).replace(' (Claude Code)', '').trim(),
      process.cwd(),
      (await $`git branch --show-current`.text()).trim(),
      preset.model ?? '<synthetic>'
    );

    for (const filename of filenames) {
      const file = Bun.file(filename);
      if (!await file.exists()) {
        process.stderr.write(`File "${filename}" does not exist, cannot Read`);
        return 0;
      }
      if (await isBinaryFile(filename)) {
        process.stderr.write(`File "${filename}" is binary, would not Read`);
        return 0;
      }
      builder.emitRead(filename, await file.text());
    }

    // TODO: Weirdly convoluted. Redesign?
    preset.customSessionData = {
      sessionId,
      value: (preset.customSessionData?.value ?? '\n') + builder.commit().map(e => JSON.stringify(e)).join('\n'),
    };
  }

  preset.permissionMode ??= 'acceptEdits';

  const claude = await spawnClaude(preset, { stdout: preset.print ? 'inherit' : 'pipe' });

  if (preset.verbose || preset.debug) {
    process.stdout.write(`${claude.sessionJsonlPath}\n`);
  }

  if (preset.quiet) {
    await claude.subprocess.exited;
  } else {
    const watcher = watch(claude.projectHomePath);
    const basename = path.basename(claude.sessionJsonlPath);
    // TODO: This should break if subprocess exited early without creating a file (likely due to a crash).
    for await (const event of watcher) {
      if (event.filename === basename) {
        break;
      }
    }

    let buffer = '';
    const tail = new TailFile(claude.sessionJsonlPath, { startPos: 0 });
    tail
      .on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');

        const result = Bun.JSONL.parseChunk(buffer);
        for (const event of result.values) {
          process.stdout.write(displayClaudeEvent(event, preset));
        }

        buffer = buffer.slice(result.read);
      })
      .start();

    await claude.subprocess.exited;
    await tail.quit();

    if (buffer.length > 0) {
      const final = Bun.JSONL.parseChunk(buffer);
      for (const event of final.values) {
        process.stdout.write(displayClaudeEvent(event, preset));
      }
      if (final.error) {
        process.stderr.write(`unable to parse final jsonl chunk: ${final.error.message}:\n\n${buffer}`);
      }
    }
  }

  return 0;
}

process.exitCode = await main();
