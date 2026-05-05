# Bare Claude

A wrapper to run Claude Code in bare headless mode. Supports alternative providers / BYOLLM.

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

## Installation

```bash
bun add @agladysh/bare-claude
```

Or globally:

```bash
bun add -g @agladysh/bare-claude
```

## Command Line Usage

```shell
# Run without installing
bunx @agladysh/bare-claude --launcher ollama --model nemotron-3-super:cloud -- 'Explain this project to me'

# Pre-read files
bare-claude --read README.md --read src/index.ts -- 'Review the API documentation in the README.md'

# Use the configuration file's defaults
bare-claude -- 'Explain this project'

# Override the model from the command line
bare-claude --model claude-4.7-opus -- 'Explain this project'

# Use a named preset
bare-claude --use claude -- 'Explain this project'
```

Options:

- `--use [presetId]`: use configuration preset `presetId`
- `--launcher [value]`: `claude` for native Anthropic modes (default), `ollama` for `ollama launch`
- `--model [model]`: model to be used
- `--verbose`: print more events in transcript
- `--quiet`: do not print transcript at all
- `--print`: print Claude Code console output (what `claude --print` prints),
  use with `--quiet` when you need the last assistant message only
- `--display [file.jsonl]`: print existing transcript
- `--read [file]`: preload non-gitignored file in a synthetic session, may be included several times, supports
  [Git pathspec patterns](https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-pathspec)

### Configuration

Bare Claude can be configured via a `bare-claude.yaml` file located at the root of the Git working copy.
This file is optional and allows you to set default values for command-line options and define named presets.

Elaborate example: see [`bare-claude.yaml`](./bare-claude.yaml) in this repository.

A configuration file data is a Preset (see below) with an optional extra `presets` field,
containing record of named presets.

#### Preset

A Preset is a record with any of the fields from the `LaunchOptions` (below) and command line options (above).

Minimal practical configuration file consists of a root configuration file Preset.

Example:

```yaml
quiet: true
print: true
callToAction: Run `git diff` and explain it to me
```

Since presets are technically allowed to be empty, degeneratively minimal valid configuration file is empty.

Root configuration file Preset fields are merged with the command line arguments, arguments taking precedence.
Exception is the `use` root field and `--use` argument: if argument is specified, field is ignored.

##### Array Fields

Array fields `use` and `read` may be specified as strings, not arrays, when you need only one value:

This is the same...

```yaml
use: foo
read: bar
```

...as this:

```yaml
use:
  - foo
read:
  - bar
```

### Presets

You can define named Presets:

```yaml
presets:
  ollama:
    launcher: ollama
    model: nemotron-3-super:cloud
  claude:
    launcher: claude
```

### Inheritance

Presets may inherit values from other presets via the `use` field.
One or several preset IDs may be specified.

```yaml
presets:
  withCode:
    read:
      - '*.ts'
  withDocs:
    read:
      - '*.md'
  withAll:
    use:
      - withCode
      - withDocs
```

#### Preset Resolution Order

Presets are merged in the following order (later sources override earlier ones):

1. Default values (hardcoded in the application)
2. Values from `bare-claude.yaml` (top-level keys, excluding the `presets` section)
3. Values from presets specified by the `--use` option or `use` Preset field
   (can be a single Preset or a list; Presets are merged left to right,
   with later Presets overriding earlier ones)
4. Command-line options

Arrays are merged by concatenation. The `use` field is not merged.

Example:

This `bare-claude.yaml` file...

```yaml
use: claude
read: '*.ts'

presets:
  claude:
    launcher: claude
  ollama:
    launcher: ollama
    model: nemotron-3-super:cloud
```

Invoked with these command line arguments:

```bash
bare-claude --use ollama --read '*.md' --verbose -- 'Explain this project to me'
```

Will result in the following configuration:

```yaml
verbose: true
launcher: ollama
model: nemotron-3-super:cloud
read:
  - '*.ts'
  - '*.md'
callToAction: Explain this project to me
```

Note command-line `--use` overrode `use` field from the configuration file root Preset.

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
  noMothership: true,
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
  Defaults to `false` if `launcher` is `claude`, and `false` otherwise.
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

See [`bin/bare-claude.ts`](./bin/bare-claude.ts) for more advanced usage example.

## Assumptions

The current version of the Bare Claude makes the following assumptions:

- Claude Code executable, `claude`, is installed and available in `PATH`
- `bare-claude` is run inside a Git working copy
- `git` is installed and available in `PATH`

## License

MIT
