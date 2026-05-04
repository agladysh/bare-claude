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

type Rule = (e: unknown) => string | null;

function Rule<T>(guard: (e: unknown) => e is T, run: (e: T) => string): Rule {
  return (e: unknown) => {
    if (!guard(e)) {
      return null;
    }
    return run(e);
  }
}

interface LastPrompt {
  type: 'last-prompt';
  lastPrompt: string;
}

function isLastPrompt(e: unknown): e is LastPrompt {
  return e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'last-prompt'
    && 'lastPrompt' in e && typeof e.lastPrompt === 'string'
    ;
}

interface AssistantSynthetic {
  type: 'assistant';
  message: {
    model: '<synthetic>';
    content: {
      text: string;
    }[];
  }
}

function isAssistantSynthetic(e: unknown): e is AssistantSynthetic {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && 'model' in e.message && e.message.model === '<synthetic>'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
    )
    ;
}

interface AssistantThinking {
  type: 'assistant';
  message: {
    type: 'message';
    content: {
      type: 'thinking';
      thinking: string;
    }[];
  }
}

function isAssistantThinking(e: unknown): e is AssistantThinking {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type === 'message'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object'
        && 'type' in c && c.type === 'thinking'
        && 'thinking' in c && typeof c.thinking === 'string'
    )
    ;
}

interface Assistant {
  type: 'assistant';
  message: {
    content: {
      text: string;
    }[];
  }
}

function isAssistant(e: unknown): e is Assistant {
  return  e !== null && typeof e === 'object'
    && 'type' in e && e.type === 'assistant'
    && 'message' in e && e.message !== null && typeof e.message === 'object'
    && (!('model' in e.message) || e.message.model !== '<synthetic>')
    && 'type' in e.message && e.message.type !== 'thinking'
    && 'content' in e.message && Array.isArray(e.message.content)
    && e.message.content.every(
      c => c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
    )
    ;
}
// TODO: Improve layout, add some colors, wrap lines etc.
const Rules: Rule[] = [
  Rule(isLastPrompt, (e) =>
    `• last-prompt: ${truncateLine(e.lastPrompt)}\n`
  ),
  Rule(isAssistantSynthetic, (e) =>
    `• synthetic\n| ${e.message.content.map(t => truncateText(t.text)).join('\n| ')}\n`
  ),
  Rule(isAssistantThinking, (e) =>
    `• thinking\n| ${e.message.content.map(t => truncateText(t.thinking)).join('\n| ')}\n`
  ),
  Rule(isAssistant, (e) =>
    `• assistant\n| ${e.message.content.map(t => truncateText(t.text)).join('\n| ')}\n`
  ),
] as const;

function displayClaudeEvent(e: unknown): string {
  for (const r of Rules) {
    const result = r(e);
    if (result !== null) {
      return result;
    }
  }
  return `${JSON.stringify(e)}\n`;
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
          process.stdout.write(displayClaudeEvent(event));
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
