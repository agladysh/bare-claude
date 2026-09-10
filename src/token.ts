import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The subscription token, read from a file when the environment lacks it.
 *
 * A bare run authenticates with `CLAUDE_CODE_OAUTH_TOKEN` (see README,
 * Authentication). The operator's shell does not carry it and is not going
 * to: in this estate credentials live in dotenv files, which is a known way to
 * end up with a run that says `Not logged in`. So the token may instead sit,
 * bare and alone, in a file — `~/.config/bare-claude/oauth` by default — and
 * `spawnClaude` reads it into the child's environment at spawn time, and only
 * then. The value never lands in a preset, a `--debug` dump, an error message
 * or the doctor: everything here that is not `readTokenFile` reports paths and
 * modes, never content.
 */

/** The environment variable Claude Code reads the OAuth token from. */
export const tokenVariable = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Environment variable naming the token file, overriding the default path. */
export const tokenFileVariable = 'BARE_CLAUDE_TOKEN_FILE';

/**
 * Credentials Claude Code accepts instead of the subscription token. A run
 * carrying one of these does not get the token file: the token must not be
 * handed to a process that is about to talk to a non-Anthropic endpoint.
 */
export const alternateCredentialVariables = [ 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN' ];

/** Whether `name` is set to something non-empty in `env`. */
function isSet(env: Record<string, string | undefined>, name: string): boolean {
  return (env[name] ?? '') !== '';
}

/** Whether `env` carries a non-empty `CLAUDE_CODE_OAUTH_TOKEN`. */
export function hasToken(env: Record<string, string | undefined>): boolean {
  return isSet(env, tokenVariable);
}

/** The alternate credential variables set in `env`, in declaration order. */
export function alternateCredentialsIn(env: Record<string, string | undefined>): string[] {
  return alternateCredentialVariables.filter(name => isSet(env, name));
}

/**
 * Whether `env` already carries something a run can authenticate with — the
 * token or an alternate credential — so the token file is not consulted.
 */
export function hasCredential(env: Record<string, string | undefined>): boolean {
  return hasToken(env) || alternateCredentialsIn(env).length > 0;
}

/**
 * The default token file: `$XDG_CONFIG_HOME/bare-claude/oauth`, or
 * `~/.config/bare-claude/oauth` when `XDG_CONFIG_HOME` is unset or empty.
 * @param env - Environment to read `XDG_CONFIG_HOME` and `HOME` from
 */
export function defaultTokenFile(env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg !== undefined && xdg.trim() !== ''
    ? xdg
    : path.join((env.HOME ?? '').trim() !== '' ? (env.HOME ?? '') : os.homedir(), '.config');
  return path.join(configHome, 'bare-claude', 'oauth');
}

/**
 * The token file a run would read, first match wins: an explicit path (the
 * `tokenFile` option or `--token-file`), then `BARE_CLAUDE_TOKEN_FILE`, then
 * {@link defaultTokenFile}. An empty string counts as unset at every step.
 * @param explicit - The caller's path, if any
 * @param env - Environment to resolve the variable and the default in
 */
export function resolveTokenFile(
  explicit: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  if (explicit !== undefined && explicit !== null && explicit.trim() !== '') {
    return path.resolve(explicit);
  }
  const fromEnv = env[tokenFileVariable];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return path.resolve(fromEnv);
  }
  return defaultTokenFile(env);
}

/**
 * What is known about a token file without disclosing its content. `exposed`
 * is whether the mode grants any permission to group or others — a token
 * readable by anyone but its owner is a token shared with them.
 */
export type TokenFileStatus =
  | { state: 'present', path: string, mode: number, exposed: boolean }
  | { state: 'empty', path: string, mode: number, exposed: boolean }
  | { state: 'absent', path: string }
  | { state: 'unreadable', path: string, reason: string };

/** Narrows a thrown value to a Node error carrying an errno `code`. */
function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

/** The permission bits of a mode, as the three octal digits `chmod` takes. */
export function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

/**
 * Inspects a token file: presence, whether it holds anything once trimmed,
 * and whether its mode exposes it. Never returns the content.
 * @param filePath - The file to inspect, see {@link resolveTokenFile}
 */
export async function inspectTokenFile(filePath: string): Promise<TokenFileStatus> {
  let mode: number;
  let text: string;
  try {
    const entry = await fs.stat(filePath);
    mode = entry.mode;
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      return { state: 'absent', path: filePath };
    }
    return { state: 'unreadable', path: filePath, reason: code ?? 'unknown error' };
  }

  const exposed = (mode & 0o077) !== 0;
  return text.trim() === ''
    ? { state: 'empty', path: filePath, mode, exposed }
    : { state: 'present', path: filePath, mode, exposed };
}

/**
 * Reads the token: the file's content trimmed of surrounding whitespace, or
 * null when there is no file. An empty or unreadable file throws, naming the
 * path and nothing else — a run that cannot authenticate should say why
 * before `claude` says `Not logged in`.
 * @param filePath - The file to read, see {@link resolveTokenFile}
 */
export async function readTokenFile(filePath: string): Promise<string | null> {
  const status = await inspectTokenFile(filePath);
  switch (status.state) {
    case 'absent':
      return null;
    case 'empty':
      throw new Error(`token file ${filePath} is empty`);
    case 'unreadable':
      throw new Error(`cannot read token file ${filePath}: ${status.reason}`);
    case 'present':
      return (await fs.readFile(filePath, 'utf8')).trim();
  }
}
