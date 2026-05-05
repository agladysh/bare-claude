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

///////////////////////////////////////////////////////////////////////////////

const { values, positionals } = parseArgs({
  args: Bun.argv,
  options: {
    launcher: {
      type: 'string',
      default: 'claude',
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

async function globFilenames(patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }

  const output = await $ `git ls-files --cached --others --exclude-standard --deduplicate -z -- ${patterns}`.text();

  return output.split('\0').filter(Boolean);
}

async function main() {
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  if (values.display) {
    const result = Bun.JSONL.parse(await Bun.file(values.display).text());
    for (const event of result) {
      process.stdout.write(displayClaudeEvent(event, values));
    }
    return 0;
  }

  if (values.help || positionals.length === 0 || !(values.launcher in Launchers)) {
    // TODO: Write better help text
    process.stdout.write(
      `Usage: ${Object.keys(pkg.bin)[0]} [--launcher=claude|ollama] [--model=<model>] [--quiet] [--read=<file>] "call to action"\n`
    );
    return 0;
  }

  let customSessionData: LaunchOptions['customSessionData'] = null;
  const filenames = await globFilenames(values.read ?? []);

  if (filenames.length > 0) {
    const sessionId = Bun.randomUUIDv7();

    const builder = new SessionBuilder(
      sessionId,
      (await $ `claude --version`.text()).replace(' (Claude Code)', '').trim(),
      process.cwd(),
      (await $`git branch --show-current`.text()).trim(),
      values.model ?? '<synthetic>'
    );

    for (const filename of filenames) {
      const file = Bun.file(filename);
      if (!file.exists()) {
        process.stderr.write(`File "${filename}" does not exist, cannot Read`);
        return 0;
      }
      if (await isBinaryFile(filename)) {
        process.stderr.write(`File "${filename}" is binary, would not Read`);
        return 0;
      }
      builder.emitRead(filename, await file.text());
    }

    customSessionData = {
      sessionId,
      value: builder.commit().map(e => JSON.stringify(e)).join('\n'),
    }
  }

  const claude = await spawnClaude({
    launcher: values.launcher as Launcher,
    model: values.model,
    callToAction: positionals.join(' '),
    permissionMode: 'acceptEdits',
    customSessionData,
  });

  if (values.verbose || values.debug) {
    process.stdout.write(`${claude.sessionJsonlPath}\n`);
  }

  if (values.quiet) {
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

    let buffer = "";
    const tail = new TailFile(claude.sessionJsonlPath, { startPos: 0 });
    tail
      .on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');

        const result = Bun.JSONL.parseChunk(buffer);
        for (const event of result.values) {
          process.stdout.write(displayClaudeEvent(event, values));
        }

        buffer = buffer.slice(result.read);
      })
      .start();

    await claude.subprocess.exited;
    await tail.quit();

    if (buffer.length > 0) {
      const final = Bun.JSONL.parseChunk(buffer);
      for (const event of final.values) {
        process.stdout.write(displayClaudeEvent(event, values));
      }
      if (final.error) {
        process.stderr.write(`unable to parse final jsonl chunk: ${final.error.message}:\n\n${buffer}`);
      }
    }
  }

  return 0;
}

process.exitCode = await main();
