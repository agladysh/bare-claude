# bare-claude

A convenience wrapper to run Claude Code in bare headless mode. Supports alternative providers.

Uses the system `claude` executable, and, by default, its auth session.

Executes `claude` with a temporary config directory.

By default minimizes the amount of information Claude Code loads in context.

## Disclaimer

This open-source software uses officially documented features
of the official Claude Code command line interface.

At the time of writing, the de-facto Anthropic stance on such use seems to be in flux.
While we do not foresee issues with normal usage scenarios,
your use of the software with the Anthropic subscription is at your own risk.

The Anthropic API key use and alternate model provider use should be okay.

## Command Line Usage

```shell
bunx @agladysh/bare-claude --launcher ollama --model nemotron-3-super:cloud 'Explain this project to me'
```

Options:

- `--launcher [value]`: `claude` for native Anthropic modes (default), `ollama` for `ollama launch`
- `--model [model]`: model to be used
- `--quiet`: do not print transcript
- `--verbose`: print more events in transcript
- `--display [file.jsonl]`: print existing transcript

## Installation

```bash
bun add @agladysh/bare-claude
```

## Programmatic Usage

### Anthropic

```typescript
import { spawnClaude, Launchers } from 'bare-claude';

const claudeProcess = await spawnClaude({
  launcher: Launchers.claude,
  callToAction: 'Explain this project to me',
  permissionMode: 'acceptEdits',
});
```

### Ollama

```typescript
import { spawnClaude, Launchers } from 'bare-claude';

const claudeProcess = await spawnClaude({
  launcher: Launchers.ollama,
  model: 'nemotron-3-super:cloud',
  callToAction: 'Explain this project to me',
  permissionMode: 'acceptEdits',
});
```

### LM Studio

```typescript
import { spawnClaude, Launchers } from 'bare-claude';

const claudeProcess = await spawnClaude({
  launcher: Launchers.claude,
  model: 'openai/gpt-oss-20b',
  callToAction: 'Explain this project to me',
  permissionMode: 'acceptEdits',
  noMonthership: true,
  extraEnv: {
    ANTHROPIC_AUTH_TOKEN: 'lmstudio',
    ANTHROPIC_BASE_URL: 'http://localhost:1234',
  }
});
```

## API

### spawnClaude(options: LaunchOptions, spawnOptions: Bun.Spawn.SpawnOptions)

Launches a Claude Code subprocess with the given options.

#### LaunchOptions

Required:

- `launcher`: The launcher to use (`'claude'` or `'ollama'`). Defaults to `'claude'`.
- `callToAction`: The initial prompt to send to Claude.

Optional:

- `model`: The model to use. If not specified, uses Claude's default model.
- `effortLevel`: The effort level (`'low'`, `'medium'`, `'high'`, `'xhigh'`). Defaults to `'high'`.
- `permissionMode`: The permission mode (`'auto'`, `'acceptEdits'`, etc.). Defaults to `'auto'`.
- `cwd`: Working directory for the Claude process. Defaults to `process.cwd()`.
- `ephemeralClaudeHomePath`: Path to existing ephemeral Claude Code home directory.
  If not provided, a temporary directory will be created.
- `customSessionData`: Data to resume a previous session, optional.
  Contains `{ sessionId: string, value: string }`.
  The `value` is to be in Claude JSONL format.
- `changeSystemPrompt`: Configuration for modifying the system prompt.
  Contains `{ type: 'appendString' | 'setString' | 'appendFile' | 'setFile', value: string }`.
- `noInstructionFiles`: Whether to disable instruction files. Defaults to `true`.
- `noMemory`: Whether to disable memory. Defaults to `true`.
- `noSkills`: Whether to disable skills. Defaults to `true`.
- `noHooks`: Whether to disable hooks. Defaults to `true`.
- `noPlugins`: Whether to disable plugins. Defaults to `true`.
- `noMcp`: Whether to disable MCP. Defaults to `true`.
- `noAgents`: Whether to disable agents. Defaults to `true`.
- `noTasks`: Whether to disable tasks. Defaults to `false`.
- `noCompact`: Whether to disable compact. Defaults to `true`.
- `noIntegrations`: Whether to disable integrations. Defaults to `true`.
- `noHousekeeping`: Whether to disable housekeeping. Defaults to `true`.
- `noMothership`: Whether to disable calling the mothership.
  Defaults to `false` if `launcher` is `clause`, and `false` otherwise.
- `noProcessEnv`: Whether to disable process environment inheritance. Defaults to `false`.
- `maxOutputLength`: Maximum output length for various Claude components. Defaults to `null` (default).
- `extraEnv`: Additional environment variables to set for the Claude process.
- `extraArgs`: Additional command-line arguments to pass to Claude.
- `extraSettings`: Additional settings to merge into Claude's configuration.

#### Returns

A promise that resolves to a `ClaudeSubprocess` object containing:

- `subprocess`: The Bun subprocess object
- `ephemeralClaudeHomePath`: Path to the Claude home directory
- `sessionId`: The session ID
- `projectHomePath`: Path to the project directory in Claude home
- `sessionJsonlPath`: Path to the session JSONL file

### displayClaudeEvent(e: event, options: { verbose: boolean, debug: boolean }): string

Converts Claude Code session NDJSON event entry to readable string.
Returns empty string for suppressed events. Returns serialized JSON for unsupported events.

When `verbose` is `true`, displays more events, suppresses them otherwise.

When `debug` is `true`, displays only unsupported events, supported events are suppressed.

### Examples

See `bin/bare-claude.ts` for more advanced usage example.

## License

MIT
