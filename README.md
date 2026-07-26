# Bare Claude

A wrapper to run Claude Code in bare headless mode. Supports alternative providers / BYOLLM.

Uses the system `claude` executable.

Executes `claude` with a temporary config directory.

By default minimizes the amount of information Claude Code loads in context.

## Authentication

Because Bare Claude runs `claude` against a temporary `CLAUDE_CONFIG_DIR`, the ambient login
session is **not** inherited. Measured against Claude Code 2.1.220: a run with a temporary config
directory reports `Not logged in · Please run /login` and exits 1, even while `claude auth status`
in the same shell reports a healthy subscription.

Give the subprocess an explicit credential instead. For an Anthropic subscription:

```bash
claude setup-token                          # once; prints a long-lived OAuth token
export CLAUDE_CODE_OAUTH_TOKEN=<the token>  # inherited by the subprocess
bare-claude -- 'Explain this project'
```

Programmatically, pass it through `extraEnv` rather than relying on the ambient environment:

```typescript
await spawnClaude({
  callToAction: 'Explain this project to me',
  extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: token },
});
```

Alternate providers authenticate through their own variables (`ANTHROPIC_AUTH_TOKEN` plus
`ANTHROPIC_BASE_URL`, see the LM Studio example below) and are unaffected.

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

- `-u, --use [presetId]`: use configuration preset `presetId`
- `-l, --launcher [value]`: `claude` for native Anthropic modes (default), `ollama` for `ollama launch`
- `-m, --model [model]`: model to be used
- `--verbose`: print more events in transcript
- `--debug`: print the resolved configuration, and render only events/blocks no rule recognizes
- `-q, --quiet`: do not print transcript at all
- `-p, --print`: print Claude Code console output (what `claude --print` prints),
  use with `--quiet` when you need the last assistant message only
- `--display [file.jsonl]`: print existing transcript
- `-r, --read [file]`: preload non-gitignored file in a synthetic session, may be included several times, supports
  [Git pathspec patterns](https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-pathspec)

- `--usage`: report subscription usage as JSON and exit (see [Usage Introspection](#usage-introspection))
- `--effort [level]`: `low`, `medium`, `high` (default), `xhigh` or `max`
- `--tools [list]`: comma-separated tools to allow; the empty string allows none
- `--disallowed-tools [list]`: comma-separated tools to deny; `*` denies all
- `--add-dir [dir]`: allow reads outside the working directory, may be included several times
- `--max-budget-usd [n]`: end the run once it has spent this much
- `--max-tokens [n]`: cap model output. Note this *errors* the turn rather than truncating it
- `--max-output-length [n]`: cap tool output going into context
- `--claude-path [path]`: Claude Code executable to run (default: `claude` on `PATH`)
- `--claude-arg [arg]`: forward a flag to `claude` verbatim, may be included several times
- `-v, --version`: print the version and exit
- `-h, --help`: print this help and exit

`--verbose` and `--debug` each also print the session transcript path to stdout and keep the
ephemeral Claude home directory afterward instead of removing it, so a run worth inspecting isn't
deleted out from under you.

The call to action is read from stdin when no positional one is given, so `bare-claude` composes
in a pipeline.

#### Exit Status

`bare-claude` exits with the `claude` subprocess' own exit code, so a failed run is a failed
command. When the run fails, whatever the subprocess wrote to stdout is echoed to stderr — that is
where Claude Code reports conditions such as `Not logged in`. Not with `--print`, though: that flag
inherits the child's stdout directly, so there is nothing left to capture, and the failure is
already on your terminal.

### Configuration

Bare Claude can be configured via a `bare-claude.yaml` file located at the root of the Git working copy.
This file is optional and allows you to set default values for command-line options and define named presets.

The file is schema-validated, and **an unknown key is an error**, not a warning. This file is
hand-written and read by nothing but this program, so a silently-ignored typo is only ever a wrong
run — and a warning is exactly what a `--quiet --print` pipeline throws away. `extraArgs`,
`extraEnv` and `extraSettings` are the declared escape hatches and stay unconstrained.

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
2. Values from presets specified by the `--use` option or `use` Preset field
   (can be a single Preset or a list; Presets are merged left to right,
   with later Presets overriding earlier ones)
3. Values from `bare-claude.yaml` (top-level keys, excluding the `presets` section)
4. Command-line options

A preset's own directly-set fields win over anything it pulls in via `use` — inheritance, not a
flat override list: this also applies recursively when a named preset itself uses others.

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

## Preloading Context

`--read` preloads files. A preset can preload more than files, via typed descriptors that land as
work the model appears to have already done — in the shapes it would have produced itself, at zero
model cost:

```yaml
preload:
  - type: glob
    pattern: 'src/*.ts'
  - type: shell
    cmd: git log --oneline -20
    description: recent history
  - type: ls
    path: doc
  - type: inline
    text: Answer in one word.
    label: Style
```

- `file` and `glob` land as `Read` tool results.
- `shell` and `ls` land as real `Bash` tool results, not as narration about a command.
- `inline` lands as a framing conversation turn.

All entries, including those from `--read`, share one raw-content byte budget (2,880,000 by
default — the 1M-context floor). An entry that would exceed it is **skipped whole**, with a warning
on stderr: a truncated file is a lie about what was read. A preload command that exits nonzero
warns and preloads its output anyway, because a preload must not abort the run.

Available programmatically as `emitPreload()` and the `file`/`glob`/`shell`/`ls`/`inline`
constructors from `@agladysh/bare-claude/preload`. `emitPreload()` writes into a `SessionBuilder`
(`@agladysh/bare-claude/SessionBuilder`), the class that fabricates the session NDJSON a preload
becomes; see [`bin/bare-claude.ts`](./bin/bare-claude.ts) for how the two compose.

## Usage Introspection

How much subscription is left, and how fast it is going:

```bash
bare-claude --usage
```

```json
{
  "loggedIn": true,
  "plan": "max",
  "fetchedAt": "2026-07-26T12:15:42.814Z",
  "ageSeconds": 1,
  "windows": [
    { "name": "five_hour", "utilization": 81, "resetsAt": "2026-07-26T13:19:59Z",
      "secondsUntilReset": 3856, "elapsed": 0.786, "burningFast": false },
    { "name": "seven_day", "utilization": 62, "resetsAt": "2026-08-01T01:59:59Z",
      "secondsUntilReset": 481456, "elapsed": 0.204, "burningFast": true }
  ]
}
```

`burningFast` means consumption has outrun the clock — 62% of the week spent in its first 20% —
using Claude Code's own warning thresholds. Windows are listed most-constrained first, and
model-scoped weekly caps appear under the model's display name.

This costs no tokens. It runs `claude -p /usage`, a local slash command that refreshes Claude
Code's own usage cache, then reads the structured payload that command leaves in `~/.claude.json`.
It deliberately does not call Anthropic's usage endpoint directly.

Available programmatically as `readUsage()` from `@agladysh/bare-claude/usage`.

### What it cannot tell you

Every source Claude Code has reports a **percentage of an opaque window**. There is no way to
learn the absolute size of a limit, how many tokens remain, or how many more turns fit — the
`limit_dollars` / `remaining_dollars` fields exist in the payload and are null for subscription
accounts. Usage consumed on other machines, on claude.ai, or in other surfaces draws on the same
pool and is only visible after a refresh.

Returns `null` (and exits 1) when there is nothing trustworthy to report: an API-key session, an
unauthenticated machine, or a cached payload older than an hour.

## Programmatic Usage

### Anthropic

```typescript
import { spawnClaude, Launchers } from '@agladysh/bare-claude';

const claudeProcess = await spawnClaude({
  launcher: Launchers.claude,
  callToAction: 'Explain this project to me',
  permissionMode: 'acceptEdits',
});
```

### Ollama

```typescript
import { spawnClaude, Launchers } from '@agladysh/bare-claude';

const claudeProcess = await spawnClaude({
  launcher: Launchers.ollama,
  model: 'nemotron-3-super:cloud',
  callToAction: 'Explain this project to me',
  permissionMode: 'acceptEdits',
});
```

### LM Studio

```typescript
import { spawnClaude, Launchers } from '@agladysh/bare-claude';

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

### spawnClaude(launchOptions: LaunchOptions, spawnOptions?: Bun.Spawn.SpawnOptions)

Launches a Claude Code subprocess with the given options. Refuses a `callToAction` starting with
`-`, which `claude` would otherwise parse as a flag instead of the prompt; the check is also
exported standalone as `assertSafeCallToAction(callToAction)`, throwing the same error.

#### LaunchOptions

Required:

- `callToAction`: The initial prompt to send to Claude.

Optional:

- `launcher`: The launcher to use (`'claude'` or `'ollama'`). Defaults to `'claude'`.
- `claudePath`: Path to the Claude Code executable (`--claude-path`). Defaults to `claude` on
  `PATH`. Only affects the `claude` launcher's own argv[0] — the `ollama` launcher's argv also
  names `claude`, but that names `ollama launch`'s target, not a filesystem path, so this option
  doesn't reach it.
- `model`: The model to use. If not specified, uses Claude's default model.
- `effortLevel`: The effort level (`'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'`). Defaults to `'high'`.
- `permissionMode`: The permission mode. One of `'acceptEdits'`, `'auto'`, `'bypassPermissions'`,
  `'dontAsk'`, `'plan'`. Defaults to `'auto'`.
  This is the *intersection* of two vocabularies: the value is passed to `--permission-mode` and
  also written to `permissions.defaultMode`, and the two accept different sets. `'manual'` is valid
  for the flag only, and `'default'` and `'delegate'` for the setting only — using one of those
  would make Claude Code reject the whole settings file, silently, in `--print` mode.
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
  Defaults to `false` if `launcher` is `claude` (including when it is left unset), and `true` otherwise.
- `noProcessEnv`: Whether to disable process environment inheritance. Defaults to `false`.
  The session markers Claude Code injects into its children (`CLAUDECODE`, `CLAUDE_CODE_*`,
  `CLAUDE_PID`, `CLAUDE_EFFORT`) are always stripped, so a nested run does not adopt its parent's
  session. Authentication variables are never stripped.
- `linkAuth`: Whether to symlink the credential file from the real Claude config directory into the
  ephemeral one. Only helps where Claude Code keeps credentials in a file — on macOS they live in
  the login keychain, so use `CLAUDE_CODE_OAUTH_TOKEN` there. Defaults to `true`.
- `tools`: Tools the run may use (`--tools`). `[]` allows none. Note `--allowedTools ''` does *not*
  achieve this: it fails open. Defaults to `null`.
- `disallowedTools`: Tools the run may not use (`--disallowed-tools`). `['*']` denies all.
  Defaults to `null`.
- `addDirs`: Extra directories the run may read (`--add-dir`). A headless run cannot read outside
  its working directory without these. Defaults to `[]`.
- `maxBudgetUsd`: Spend ceiling for the run in US dollars. Defaults to `null`.
- `maxTokens`: Cap on generated tokens (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`). Distinct from
  `maxOutputLength`, which caps *tool* output going into context. Exceeding it errors the turn
  rather than truncating it. Defaults to `null`.
- `maxOutputLength`: Maximum output length for various Claude components. Defaults to `null` (default).
- `extraEnv`: Additional environment variables to set for the Claude process. Defaults to `{}`.
- `extraArgs`: Additional command-line arguments to pass to Claude. Defaults to `[]`.
- `extraSettings`: Additional settings, deep-merged into Claude's configuration last, so they
  override anything Bare Claude derived from the options above. You can override a value this way
  but not remove a key. Defaults to `{}`.

#### Returns

A promise that resolves to a `ClaudeSubprocess` object containing:

- `subprocess`: The Bun subprocess object
- `ephemeralClaudeHomePath`: Path to the Claude home directory
- `sessionId`: The session ID
- `projectHomePath`: Path to the project directory in Claude home
- `sessionJsonlPath`: Path to the session JSONL file
- `dispose()`: Removes the ephemeral Claude home directory, but only when `spawnClaude` created it.
  Idempotent. Call it in a `finally`; without it every spawn leaks a temporary directory.

```typescript
const claude = await spawnClaude({ callToAction: 'Explain this project to me' });
try {
  const exitCode = await claude.subprocess.exited;
} finally {
  await claude.dispose();
}
```

### Pure launch configuration

`spawnClaude` is assembly plus side effects. The assembly is exported separately, so the whole
flag matrix can be inspected and tested without spawning anything:

- `LaunchConfig(options)`: resolves `LaunchOptions` to a fully defaulted `LaunchConfig`.
- `buildArgv(config, sessionId)`: the full command vector, `argv[0]` included.
- `buildSettings(config)`: the `settings.json` document.
- `buildEnv(config, { ephemeralClaudeHomePath, processEnv?, spawnEnv? })`: the child environment.

All three are pure — no filesystem, no clock, no subprocess.

#### Precedence

`cwd` is `launchOptions.cwd ?? spawnOptions.cwd ?? process.cwd()`, and the winner also determines
the session transcript path, so the two can never disagree.

Environment, later wins: inherited process environment (unless `noProcessEnv`, and always minus
the parent session markers) → `spawnOptions.env` → `extraEnv` → `CLAUDE_CONFIG_DIR`. The last is
forced and not overridable: it is what makes a run bare.

### TranscriptRenderer

```typescript
import { TranscriptRenderer } from '@agladysh/bare-claude/display';

const renderer = new TranscriptRenderer({ verbose: false, debug: false });
for (const event of events) {
  process.stdout.write(renderer.display(event));
}
```

Converts Claude Code session NDJSON entries to readable strings, returning `''` for whatever is
suppressed at the current verbosity. A record or block no rule recognizes at all also renders as
`''` by default, and as serialized JSON under `--verbose`/`--debug`.

When `verbose` is `true`, more events are displayed. When `debug` is `true`, only what no rule
recognizes is displayed.

The event vocabulary each rule recognizes — one type guard in `src/events.ts` per shape, exported
along with the `SessionEvent` union from `@agladysh/bare-claude/events` — is catalogued in
[`doc/session-event-stream.md`](./doc/session-event-stream.md).

Use **one renderer per stream**. It remembers which tool each `tool_result` answers, which is how a
`Read` result collapses to `> [N lines]` outside verbose mode; a fresh renderer per event cannot
pair anything. `reset()` drops outstanding pairings.

`displayClaudeEvent(e, options)` remains as a convenience for one-off rendering. It builds a
throwaway renderer per call and therefore never collapses tool results — prefer the class.

### parseConfig(text, source?)

From `@agladysh/bare-claude/config`. Parses and validates `bare-claude.yaml`, throwing on anything
the schema rejects, and returns a `Config` (`{ configPreset, presets }`); `emptyConfig()` is the
value used when no file exists. The `effortLevel`/`permissionMode` arktype schemas — and their
inferred `EffortLevel`/`PermissionMode` types — validate those two fields specifically and are
exported too. See [Configuration](#configuration).

`@agladysh/bare-claude/preset` exports `resolvePreset(preset, presets)`, which folds a
`DynamicPreset`'s `use` chain and applies the CLI display defaults to produce a runnable `Preset`
— the function behind the [preset resolution order](#preset-resolution-order) above.

### Examples

See [`bin/bare-claude.ts`](./bin/bare-claude.ts) for more advanced usage example.

## Assumptions

The current version of the Bare Claude makes the following assumptions:

- Claude Code executable, `claude`, is installed and available in `PATH` (or pointed to via
  `claudePath`/`--claude-path`)
- `bare-claude` is run inside a Git working copy
- `git` is installed and available in `PATH`

## License

MIT
