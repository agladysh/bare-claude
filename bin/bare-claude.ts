#!/usr/bin/env bun

import { parseArgs } from 'node:util';
import path from 'node:path';
import { watch } from 'node:fs/promises';

import TailFile from '@logdna/tail-file';

import { Launchers, spawnClaude, type Launcher } from '@agladysh/bare-claude';
import { displayClaudeEvent } from '@agladysh/bare-claude/display';

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
      `Usage: ${Object.keys(pkg.bin)[0]} [--launcher=claude|ollama] [--model=<model>] [--quiet] "call to action"\n`
    );
    return 0;
  }

  let exited = false;

  const claude = await spawnClaude({
    launcher: values.launcher as Launcher,
    model: values.model,
    callToAction: positionals.join(' '),
    permissionMode: 'acceptEdits',
  });

  if (values.verbose || values.debug) {
    process.stdout.write(`${claude.sessionJsonlPath}\n`);
  }

  if (values.quiet) {
    await claude.subprocess.exited;
  } else {
    const watcher = watch(claude.projectHomePath);
    const basename = path.basename(claude.sessionJsonlPath);
    for await (const event of watcher) {
      if (event.filename === basename || exited) {
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
