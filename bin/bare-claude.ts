#!/usr/bin/env bun

import { parseArgs } from 'node:util';
import path from 'node:path';
import { watch } from 'node:fs/promises';

import TailFile from '@logdna/tail-file';

import { Launchers, spawnClaude, type JsonObject, type Launcher } from 'bare-claude';

import pkg from '../package.json';

///////////////////////////////////////////////////////////////////////////////
// TODO: Move this to a dedicated module
// TODO: This needs nicer formatting

interface Rule {
  test: (e: JsonObject) => boolean,
  run: (e: JsonObject) => string,
}

function truncateLine(str: string, max: number = 80) {
  if (str.length <= max) {
    return str;
  }
  return str.slice(0, max - 3) + '...';
}

function truncateText(str: string, maxLines: number = 16) {
  const lines = str.split("\n");
  if (lines.length <= maxLines) {
    return lines;
  }
  const head = lines.slice(0, maxLines - 2);
  const tail = lines.slice(-1);
  return [...head, `... [${lines.length - (maxLines - 1)} lines truncated] ...`, ...tail];
}

// TODO: Fix types and guards.
const Rules: Rule[] = [{
  test: (e) => e.type === 'last-prompt',
  run: (e) => `• last-prompt: ${truncateLine(String(e.lastPrompt))}\n`,
}, {
  test: (e) => e.type === 'assistant' &&
    !Array.isArray(e.message) && typeof(e.message) === 'object' && e.message?.model === '<synthetic>',
  run: (e) => `• synthetic:\n| ${truncateText(String(e.message.content[0].text)).join('\n| ')}\n`,
}, {
  test: (e) => e.type === 'assistant' &&
    !Array.isArray(e.message) && typeof(e.message) === 'object' && e.message?.content[0].type === 'thinking',
  run: (e) => `• thinking:\n| ${truncateText(String(e.message.content[0].thinking)).join('\n| ')}\n`,
}, {
  test: (e) => e.type === 'assistant' &&
    !Array.isArray(e.message) && typeof(e.message) === 'object' && e.message?.content[0].text,
  run: (e) => `• assistant:\n| ${truncateText(String(e.message.content[0].text)).join('\n| ')}\n`,
}] as const;

function displayClaudeEvent(e: JsonObject): string {
  const r = Rules.find(r => r.test(e));
  if (!r) {
    return `${JSON.stringify(e)}\n`;
  }
  return r.run(e);
}

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
    callToAction: positionals.join('\n'),
  });

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
    const tail = new TailFile(claude.sessionJsonlPath);
    tail
      .on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');

        const result = Bun.JSONL.parseChunk(buffer);
        for (const event of result.values) {
          process.stdout.write(displayClaudeEvent(event as JsonObject));
        }

        buffer = buffer.slice(result.read);
      })
      .start();

    await claude.subprocess.exited;
    await tail.quit();

    if (buffer.length > 0) {
      const final = Bun.JSONL.parseChunk(buffer);
      for (const event of final.values) {
        process.stdout.write(displayClaudeEvent(event as JsonObject));
      }
      if (final.error) {
        process.stderr.write(`unable to parse final jsonl chunk: ${final.error.message}:\n\n${buffer}`);
      }
    }
  }

  return 0;
}

process.exitCode = await main();
