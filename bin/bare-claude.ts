#!/usr/bin/env bun

import { Launchers, spawnClaude, type Launcher } from 'bare-claude';
import { parseArgs } from 'util';
import pkg from '../package.json';

// TODO: Provide --help
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
    version: {
      type: 'string',
      short: 'v',
    },
    help: {
      type: 'string',
      short: 'h',
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
    process.stdout.write(`Usage: ${pkg.name} [--launcher=claude|ollama] [--model=<model>] "call to action"\n`);
    return 0;
  }

  await spawnClaude({
    launcher: values.launcher as Launcher,
    model: values.model,
    callToAction: positionals.join('\n'),
  });

  return 0;
}

process.exitCode = await main();
