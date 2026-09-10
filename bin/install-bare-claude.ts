#!/usr/bin/env bun

import { parseArgs } from 'node:util';

import {
  defaultBinDir, install, status, uninstall, type InstallStatus
} from '@agladysh/bare-claude/install';

/**
 * Installs, inspects or removes the `bare-claude` symlink on `PATH`. The
 * `install:user`, `install:status` and `install:uninstall` package scripts
 * are this file; see `src/install.ts` for what each action guarantees.
 *
 * One line on stdout, exit 0 — except `status`, which exits 1 unless this
 * checkout is what is installed, so a script can test for it.
 */

const usageText = 'usage: bun bin/install-bare-claude.ts [install|status|uninstall] [--bin-dir DIR] [--force]\n';

function usage(message: string): number {
  process.stderr.write(`bare-claude installer: ${message}\n${usageText}`);
  return 2;
}

function describe(result: InstallStatus): string {
  switch (result.state) {
    case 'installed':
      return `installed: ${result.path} -> ${result.source}`;
    case 'absent':
      return `absent: ${result.path}`;
    case 'foreign':
      return `foreign: ${result.path} is ${result.detail}, not a symlink to ${result.source}`;
  }
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        'bin-dir': { type: 'string' },
        force: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }

  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    return usage(`expected one action, got ${positionals.join(' ')}`);
  }
  const action = positionals[0] ?? 'install';
  const binDir = values['bin-dir'] ?? defaultBinDir();

  switch (action) {
    case 'install': {
      const result = await install(binDir, { force: values.force });
      process.stdout.write(`${result.state}: ${result.path} -> ${result.source}\n`);
      return 0;
    }
    case 'status': {
      const result = await status(binDir);
      process.stdout.write(`${describe(result)}\n`);
      return result.state === 'installed' ? 0 : 1;
    }
    case 'uninstall': {
      const result = await uninstall(binDir);
      process.stdout.write(`${result.state}: ${result.path}\n`);
      return 0;
    }
    default:
      return usage(`unknown action: ${action}`);
  }
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`bare-claude installer: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
