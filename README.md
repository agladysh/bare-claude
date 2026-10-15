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

The shell is not the only place the token can live. When the environment carries neither
`CLAUDE_CODE_OAUTH_TOKEN` nor an alternate credential, `bare-claude` reads the token from a file —
the bare token, nothing else, surrounding whitespace ignored — and puts it in the subprocess's
environment at spawn time:

```bash
mkdir -p ~/.config/bare-claude
chmod 700 ~/.config/bare-claude
# put the token from `claude setup-token`, and nothing else, in this file:
chmod 600 ~/.config/bare-claude/oauth
bare-claude -- 'Explain this project'
```

The default is `$XDG_CONFIG_HOME/bare-claude/oauth` when `XDG_CONFIG_HOME` is set, else
`~/.config/bare-claude/oauth`; `--token-file PATH`, the `tokenFile` launch option, or
`BARE_CLAUDE_TOKEN_FILE` name another file, in that order of precedence. An explicit
`CLAUDE_CODE_OAUTH_TOKEN` always wins. `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in the
environment disables the lookup — the token is never handed to a run pointed at another endpoint
— and the `ollama` launcher never reads it. A missing file is fine; an empty or unreadable one is
an error naming the path. The value is read at spawn time and goes nowhere else: not into
`--debug` output, not into the doctor, not into an error message.

Programmatically, pass it through `extraEnv` rather than relying on the ambient environment:

```typescript
await spawnClaude({
  callToAction: 'Explain this project to me',
  extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: token },
});
```

Alternate providers authenticate through their own variables (`ANTHROPIC_AUTH_TOKEN` plus
`ANTHROPIC_BASE_URL`, see the LM Studio example below) and are unaffected.

### Caller-managed authentication

Everything above is the default, `auth: fallback`: the run uses the credential its environment
carries, and when there is none Bare Claude falls back to sources of its own — the token file, and
the credential file `linkAuth` links. That fallback triggers on an *absence*, so it also fires
where the absence is deliberate: a launcher named by `--claude-path` that brings its own
credential, or an environment scrubbed with `noProcessEnv`, where the default token file is still
found under `os.homedir()`.

`--auth caller` (the `auth: 'caller'` launch option, `auth: caller` in a preset) hands
authentication to the caller. No token file is read or even inspected, and no credential file is
linked; the child gets exactly the environment the layers below produce, and the executable
authenticates however it does. Combining it with `--token-file` or `linkAuth: true` is an error,
not a precedence question. Nothing about the environment is inferred or stripped either way:
whatever credential variables the caller passes reach the child as given, and a preset's
`extraEnv` is one of the layers that can pass them — see `--no-config` below for keeping a
repository's preset out of it.

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

Or from a checkout, as a symlink on `PATH` that tracks the source:

```bash
bun install
bun run install:user        # ~/.local/bin/bare-claude -> bin/bare-claude.ts
bun run install:status      # installed / absent / foreign; exits 1 unless installed
bun run install:uninstall   # removes the symlink, and only a symlink into this checkout
```

`--bin-dir DIR` puts the link somewhere other than `~/.local/bin`. Whatever else is at that path
is never overwritten: `bun run install:user --force` replaces a foreign symlink or file, and a
directory never. `bare-claude --doctor` then reports whether the result is actually on `PATH`.

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
- `--config [file]`: read this configuration file instead of `bare-claude.yaml` at the Git root
  (see [Choosing the configuration](#choosing-the-configuration))
- `--no-config`: read no configuration file
- `-l, --launcher [value]`: `claude` for native Anthropic modes (default), `ollama` for `ollama launch`
- `-m, --model [model]`: model to be used
- `--verbose`: print more events in transcript
- `--debug`: print the resolved configuration, and render only events/blocks no rule recognizes.
  In the configuration, every value of `extraEnv` and `extraSettings.env` is replaced by its
  length, names kept; an in-memory session journal (`customSessionData.value`) likewise; and the
  values of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` by
  `<redacted>` wherever else they appear. Nothing else is withheld: `extraArgs`, the rest of
  `extraSettings`, the system prompt, the call to action and paths are printed as given, and
  anything secret in them with them. `--debug` is for someone allowed to see the invocation; it is
  not a sanitizer
- `-q, --quiet`: do not print transcript at all
- `-p, --print`: print Claude Code console output (what `claude --print` prints),
  use with `--quiet` when you need the last assistant message only
- `--display [file.jsonl]`: print existing transcript
- `-r, --read [file]`: preload non-gitignored file in a synthetic session, may be included several times, supports
  [Git pathspec patterns](https://git-scm.com/docs/gitglossary#Documentation/gitglossary.txt-pathspec)

- `--usage`: report subscription usage as JSON and exit (see [Usage Introspection](#usage-introspection))
- `--doctor`: report what a run needs and exit 1 when something required is missing
  (see [Doctor](#doctor))
- `--effort [level]`: `low`, `medium`, `high` (default), `xhigh` or `max`
- `--tools [list]`: comma-separated tools to allow; the empty string allows none
- `--disallowed-tools [list]`: comma-separated tools to deny; `*` denies all
- `--add-dir [dir]`: allow reads outside the working directory, may be included several times
- `--max-budget-usd [n]`: end the run once it has spent this much
- `--max-tokens [n]`: cap model output. Note this *errors* the turn rather than truncating it
- `--max-output-length [n]`: cap tool output going into context
- `--claude-path [path]`: Claude Code executable to run (default: `claude` on `PATH`)
- `--token-file [path]`: file holding the OAuth token, read when the environment has none
  (default: `$BARE_CLAUDE_TOKEN_FILE`, then `~/.config/bare-claude/oauth`; see
  [Authentication](#authentication))
- `--auth [mode]`: `fallback` (default) or `caller` (see
  [Caller-managed authentication](#caller-managed-authentication))
- `--claude-home [dir]`: Claude home for the run, created if missing and kept whatever the outcome
  (see [Keeping and continuing a run](#keeping-and-continuing-a-run))
- `--stop-grace-ms [n]`: after `bare-claude` receives SIGTERM, SIGINT or SIGHUP, how long the run
  gets before its process group is sent SIGKILL; default 10000 (see
  [Stopping a run](#stopping-a-run))
- `--claude-arg [arg]`: forward a flag to `claude` verbatim, may be included several times
- `-v, --version`: print the version and exit
- `-h, --help`: print this help and exit

`--verbose` and `--debug` each also print the session transcript path to stdout and keep the
ephemeral Claude home directory afterward instead of removing it, so a run worth inspecting isn't
deleted out from under you. That home is still a temporary directory nobody owns; to keep a run's
home where you decide, name it with `--claude-home`.

The call to action is read from stdin when no positional one is given, so `bare-claude` composes
in a pipeline.

#### Exit Status

`bare-claude` exits with the `claude` subprocess' own exit code, so a failed run is a failed
command. When the run fails, whatever the subprocess wrote to stdout is echoed to stderr — that is
where Claude Code reports conditions such as `Not logged in`. Not with `--print`, though: that flag
inherits the child's stdout directly, so there is nothing left to capture, and the failure is
already on your terminal.

The exit code reports how the process ended, and nothing more. Exit 0 does not mean the task was
done, and neither the exit code nor a kept session journal means anyone has read the result.

A run stopped by SIGTERM, SIGINT or SIGHUP to `bare-claude` exits with 128 plus that signal's
number — 143, 130, 129 — whatever `claude` itself exited with, so a stopped run is never read as
a completed one. See [Stopping a run](#stopping-a-run).

A refusal made before `claude` is spawned — an invalid configuration, a contradictory option, a
session seed that cannot be published — exits 1 with a one-line `bare-claude:` message on stderr.

### Stopping a run

`bare-claude` spawns `claude` (or what `--claude-path` names) in a process group of its own, on
macOS and Linux: Bun calls `setsid()` in the child. Whatever that process starts — the native
Claude Code process under a managed launcher, the shells Claude Code runs — is in the group too,
unless it starts a session of its own. Every run reports that group on stderr as soon as it is
spawned, whatever its home:

```
Claude process group 41321
```

On the first SIGTERM, SIGINT or SIGHUP, `bare-claude`:

1. sends that signal to the spawned process alone, so a launcher that supervises the native
   process can shut it down in its own order, and says so on stderr;
2. once that process has exited, sends the same signal once to anything left in its group;
3. when `--stop-grace-ms` (10000 by default, chosen rather than measured) has passed with
   anything still running, sends SIGKILL to the whole group. A second signal sends it at once.

A signal that arrives while `claude` is still being spawned is held and acted on as soon as it
exists; one that arrives after `claude` has exited on its own stops nothing and does not change
the exit status. It then reports and exits as usual, with the 128+n status above:

```
bare-claude: received SIGTERM; sent it to claude (pid 41321), SIGKILL to process group 41321 after 10000 ms
Claude process ended: exit code 143
Claude stop: SIGTERM; process group 41321 empty
Claude home kept at /work/runs/0042/claude-home
```

**What this asks of a supervisor.** Because `claude` is no longer in `bare-claude`'s own process
group, a kill aimed at that group — `timeout -k`'s final SIGKILL, a job-control kill of a shell
job — ends `bare-claude` alone, and the run goes on unreported. A supervisor must do one of:

- signal `bare-claude` itself, and allow it at least `--stop-grace-ms` plus 5 seconds — the two
  bounded 2-second waits after SIGKILL, and a second for the last of the child's output — before
  any kill of its own, plus whatever removing a temporary home takes. With the default grace,
  `timeout -k 20 60 bare-claude …` leaves room; `timeout -k 5` does not.
- or signal the reported `Claude process group` directly.

`Claude stop:` says whether SIGKILL was needed and what was left in the group: `empty`,
`still occupied after SIGKILL`, or `holds processes this user may not signal; left alone`. A run
that ends without being asked is not signalled. If its group still has processes then, they are
left alone — they may be work the run meant to leave running — and reported as such, the home is
kept rather than removed under them, and `bare-claude` stops reading the child's stdout and exits
with `claude`'s own code even if one of them still holds that pipe open:

```
Claude process ended: exit code 0
bare-claude: claude exited, but process group 41321 still has processes; they were not signalled and may still be running
Claude home kept at /var/folders/…/bare-claude-home-…
```

That exit code says how the spawned process ended, not that everything the run started has.

What a stop cannot do:

- **SIGKILL to `bare-claude` itself** cannot be caught, so nothing is forwarded or reported, and
  the run carries on. A runner that may have to do that must record the process group from the
  `Claude process group` line printed at spawn and signal the group itself. Until it reads the
  kept home back, the outcome of such a run is unknown, not failed and not done.
- **A descendant that started a session of its own** is outside the group and is not reached.
- **Work already done stays done**: edits in the working directory, records in the session
  journal, requests already sent to a model provider, and anything another service was asked to
  do. The stop ends processes; it does not roll anything back.

On Windows there is no process group: the spawned process alone is signalled, and the stop line
says so.

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

#### Choosing the configuration

By default the file is `bare-claude.yaml` at the root of the Git working copy the command runs in,
so a run picks up whatever that repository's file says — its root preset's endpoint and
credentials included. (This repository's own file has no root preset for that reason; its
`lmstudio` preset applies only when named with `--use`.) A caller that drives `bare-claude` from
someone else's working copy, or from none, chooses instead:

- `--config FILE` reads that file, which must exist, and no other. No Git working copy is needed.
  Its named presets serve `--use`. This is how one invocation is declared whole: working
  directory, Claude home, tools and read scope, auth mode and session seed in one validated file,
  with nothing copied from a launcher script.
- `--no-config` reads none: only the command line and the library defaults apply.

The file is validated the same way whichever route selected it, before anything is spawned. The
command line still wins over it, as below. Relative paths in it resolve against the directory
`bare-claude` runs in — except `read` and `preload`, which resolve against the run's `cwd` — so
a generated per-invocation file is clearest with absolute ones.

```yaml
# invocation.yaml, written for one run
cwd: /work/checkout
ephemeralClaudeHomePath: /work/runs/0042/claude-home
auth: caller
claudePath: /opt/launchers/claude
tools: [Read, Grep, Glob]
addDirs: [/work/reference]
customSessionData:
  sessionId: 0199e7a0-5b1c-7c2e-9d4f-3a6b8c0d1e2f
  sourcePath: /work/runs/0041/claude-home/projects/-work-checkout/0199e7a0-5b1c-7c2e-9d4f-3a6b8c0d1e2f.jsonl
  # sourceSha256: the 64 lowercase hex digits recorded when run 0041 ended
```

```bash
env -i PATH="$PATH" HOME="$HOME" USER="$USER" TMPDIR="${TMPDIR:-/tmp}" \
  bare-claude --config invocation.yaml --quiet --print -- 'Continue'
```

`env -i` is the command line's way to scrub the environment the run inherits; `noProcessEnv`
with `spawnOptions.env` is the library's. Which variables to pass back is the caller's to know,
not this example's: `PATH` finds `bun` and the executable, `HOME` is where Claude Code and the
default token file are looked for, and `USER` and `TMPDIR` are among what programs commonly
expect of a login environment. A launcher's own requirements, documented by whoever maintains it,
come first; a list copied from here is not a substitute for them.

The doctor reads the same configuration the same way: `bare-claude --doctor --config
invocation.yaml`, with the same `--use` and flags, checks the executable, working directory,
auth mode and child environment that run would have.

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

## Keeping and continuing a run

`--claude-home DIR` (`ephemeralClaudeHomePath`) gives a run a Claude home that belongs to the
caller. It is created when missing and never removed by Bare Claude — not after success, not after
failure, not after a stop. As soon as the child is spawned, and before it has done anything, the
command reports on stderr where its journal will be and which process group it runs in; when it
ends, how the process ended and where the home is:

```
Claude session journal at /work/runs/0042/claude-home/projects/-work-checkout/0199….jsonl
Claude process group 41321
…
Claude process ended: exit code 0
Claude home kept at /work/runs/0042/claude-home
```

The journal line names a path, not a file: the child creates the file, and one that failed early
may never have. The first two lines are all a runner has if it has to kill `bare-claude` outright
(see [Stopping a run](#stopping-a-run)).

What a kept home holds is whatever Claude Code and Bare Claude wrote there, which this project does
not inventory: the session journal, which records the conversation and what tools read, so it can
hold anything the prompt or a file contained; `settings.json`, mode 0600, which carries any
`extraSettings.env` given; under `auth: fallback`, a symlink to the real credential file where
`linkAuth` found one; and Claude Code's own state. Keeping it is keeping all of that. What the task
produced, and whether anyone has received it, are not in it.

One live run per home. Nothing in Bare Claude stops two runs, or a run and a leftover process
from a stopped one, from sharing a home: they would append to each other's history, and each
spawn replaces `settings.json` under the other. `settings.json` is replaced atomically, so a
reader never sees half of one, but which one it sees is not decided. Giving each run its own home,
and starting the next only once the last has been seen to end, is the runner's.

To continue that session in a new run, seed the new run from the journal by path
(`customSessionData` with `sessionId` and `sourcePath`, optionally `sourceSha256`) and give the new
run a home of its own. The new journal is a copy-on-write clone of the old one, on the same
filesystem, so the continuation initially shares its existing file data; the source is never
written, and each side appends independently afterwards. Nothing locks the source: seeding one
journal into several homes makes several independent continuations under the same session id,
each its own fork from then on — a session is a home and an id together, not an id. Record the
digest only once the run that wrote the journal has been seen to end: `sourceSha256` catches a
change made after it was taken, not one made before.

The session id names the journal file, so it must be a letter or digit followed by letters,
digits, `.`, `_` or `-`, 128 characters at most; anything else, a path separator included, is
refused. Claude Code's own ids are UUIDs.

The seed is refused before `claude` is spawned, with no journal and no history line published,
when any of the following holds. What `spawnClaude` did before reaching the seed stays done in a
caller's home: the home and its project directory created, the credential file linked under
`linkAuth`. A temporary home is removed whole.

- the platform is neither macOS nor Linux: a forced clone was source-read in Bun 1.3.13's
  `copyFileSync` for those two (`clonefile()`, `ioctl_ficlone`, neither with a byte-copy
  fallback), while its Windows branch copies bytes whatever the flag says. `engines` allows any
  Bun from 1.3; later versions have not been read;
- the filesystem cannot clone, or the source and the new home are on different filesystems — there
  is no byte-copy fallback;
- the source is a symbolic link, or has a second hard link;
- `sourceSha256` is given and the source no longer has that digest, or the source changes while it
  is being read or cloned;
- a journal for that session already exists in the new home;
- `--read` or `preload` would have to extend it, which needs its bytes in memory.

The in-memory route, `customSessionData` with `value`, remains for callers who mean to hold the
journal as a string, and is what `--read` uses. It, too, refuses to replace an existing journal.

If anything fails after the journal is published but before `claude` is spawned — a
`--claude-path` that does not exist, say — the journal and the `history.jsonl` line that run added
are taken back, so the same invocation can simply be retried. Each is taken back only while it is
provably still what this run wrote: the journal while the path names the same file, the history
line while nothing has been appended after it. Anything else is left, and the error says so.

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

## Doctor

What a run needs, and which of it is missing:

```bash
bare-claude --doctor
```

```
ok   bun: 1.3.13 at /opt/homebrew/bin/bun
ok   claude: 2.1.268 at /Users/you/.local/bin/claude
ok   git: 2.55.0 at /opt/homebrew/bin/git
fail auth: CLAUDE_CODE_OAUTH_TOKEN absent, no token file at /Users/you/.config/bare-claude/oauth
       A bare run does not inherit the ambient login session:
         claude setup-token                          # once; prints a long-lived OAuth token
         export CLAUDE_CODE_OAUTH_TOKEN=<the token>  # inherited by the subprocess
       or write the bare token, nothing else, to /Users/you/.config/bare-claude/oauth (chmod 600)
ok   install: /Users/you/.local/bin/bare-claude -> /Users/you/projects/bare-claude/bin/bare-claude.ts
ok   preset: /Users/you/projects/bare-claude/bare-claude.yaml (presets: default, changelog)
```

One line per item, a hint beneath any that needs fixing. The doctor takes the same options a run
does — `--config`/`--no-config`, `--use` and every other flag — and resolves them the same way, so
it checks the invocation that run would make rather than the shell around it.

`bun` is the running runtime, checked against `engines.bun`. `claude` is the executable that
invocation would spawn — its `claudePath`, searched for on the `PATH` of the environment its child
would get, from its `cwd` — and its version. `git` is what locates the preset file and resolves
`--read`. `auth` looks at the environment that child would get — this one unless `noProcessEnv`
drops it, plus `extraEnv` — and says whether `CLAUDE_CODE_OAUTH_TOKEN` is present there; failing
that, whether the token file is (`tokenFile`/`--token-file` applies) — by path, with a warning
when its mode lets anyone but its owner read it and a failure when it is empty; failing both, what
to do. It is a warning rather than a failure when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`
stands in. Never a value, from either source. Under `auth: caller` it inspects nothing and is a
warning saying so: the caller's route is not this program's to check. `install` is whether
`bare-claude` is on `PATH`, and whether it is this checkout's symlink. `preset` is the
`bare-claude.yaml` a run from the current directory would load, validated — or the file `--config`
names, which must exist; under `--no-config` there is nothing to load and it is `ok`. When the
invocation would be refused — an unknown `--use`, `auth: caller` beside a `tokenFile`, a session
id that cannot name a file, a named configuration that is missing or invalid — `preset` fails with
the refusal as its hint, `claude` is checked from the command line alone and says so, and `auth`
is a warning that checked nothing: the configuration that failed may be the one that says
`auth: caller`, so no token file is opened. Outside a Git working copy, where there is no
configuration to read, the command line is checked as it always was.

Exits 1 when any item is `fail`. Nothing is repaired, and no model is spawned: the only
subprocesses are `--version` probes and `git rev-parse`. The `--version` probe does run the
executable the invocation names, a managed launcher included.

Available programmatically as `runDoctor()` and `formatDoctorReport()` from
`@agladysh/bare-claude/doctor`.

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
- `cwd`: Working directory for the Claude process, made absolute. Defaults to `process.cwd()`.
- `ephemeralClaudeHomePath`: Claude home directory (`CLAUDE_CONFIG_DIR`) owned by the caller: made
  absolute, created when missing, never removed by this library whatever the outcome. Its
  `settings.json` is replaced atomically on every spawn; one live run per home is the caller's to
  keep. If not provided, a temporary directory is created, and `dispose()` removes it. See
  [Keeping and continuing a run](#keeping-and-continuing-a-run).
- `customSessionData`: A prior session to resume, optional. Its `sessionId` must match
  `sessionIdPattern` (exported): it names the journal file. A `SessionSeed`, one of:
  - `{ sessionId, value }` (`InMemorySessionSeed`): `value`, in Claude JSONL format, is written
    whole as the new journal.
  - `{ sessionId, sourcePath, sourceSha256? }` (`FileSessionSeed`): the new journal is a
    copy-on-write clone of the file at `sourcePath`, which is never written. No byte-copy
    fallback; see [Keeping and continuing a run](#keeping-and-continuing-a-run) for every
    refusal.

  Either way an existing journal for that session in the home is never replaced: the spawn
  rejects instead.
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
- `noBashEditDiff`: Whether to disable the Bash tool's diff of the files each command changed, by
  writing `CLAUDE_CODE_BASH_EDIT_DIFF=0` into the settings `env`. Defaults to `true`.
  - **What the diff costs.** When enabled, each Claude process keeps one private Git store per
    repository under its temporary directory (`bash-edit-diff/`) and updates it on every Bash
    command. A store whose baseline cannot be created re-hashes the whole tree and is abandoned.
    Abandoned stores stay until Claude's two-day sweep, and headless runs on one large repository
    accumulated tens of gigabytes that way.
  - **Composition.** Claude reads the variable before any `bashEditDiffEnabled` setting, so while
    this option is on, `extraSettings: { bashEditDiffEnabled: true }` does not re-enable the diff.
    Setting `noBashEditDiff: false` only omits the variable: a caller's
    `extraSettings: { bashEditDiffEnabled: false }` still keeps the diff off, and without one
    Claude's own default applies (on only in `auto`/`bypassPermissions` mode, for enabled
    cohorts). `extraSettings.env.CLAUDE_CODE_BASH_EDIT_DIFF` is merged last and wins either way.
- `noMothership`: Whether to disable calling the mothership.
  Defaults to `false` if `launcher` is `claude` (including when it is left unset), and `true` otherwise.
- `noProcessEnv`: Whether to drop the inherited process environment. Defaults to `false`.
  When `false`, everything is inherited except the session markers Claude Code injects into its
  children (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`), which are always
  stripped so a nested run does not adopt its parent's session; credential variables are
  inherited like everything else. When `true`, nothing is inherited, credentials included: only
  `spawnOptions.env` and `extraEnv` reach the child. Neither value turns off the token file — only
  `auth: 'caller'` does.
- `auth`: Who supplies the child's credential, an `AuthMode`: `'fallback'` or `'caller'`; any
  other value, from an untyped caller, is refused. Defaults to
  `'fallback'`: the environment's credential, else the token file and `linkAuth`. `'caller'`
  reads no token file and links nothing; it cannot be combined with `linkAuth: true` or a
  `tokenFile`. See [Caller-managed authentication](#caller-managed-authentication).
- `linkAuth`: Whether to symlink the credential file from the real Claude config directory (this
  process's `CLAUDE_CONFIG_DIR`, else `~/.claude`) into the ephemeral one. Only helps where Claude
  Code keeps credentials in a file — on macOS they live in the login keychain, so use
  `CLAUDE_CODE_OAUTH_TOKEN` there. Defaults to `true` under `auth: 'fallback'`, `false` under
  `auth: 'caller'`.
- `tokenFile`: File holding the subscription token, read into the child's `CLAUDE_CODE_OAUTH_TOKEN`
  at spawn time when the child's environment carries neither that variable nor an alternate
  credential, for the `claude` launcher under `auth: 'fallback'` only. `null`, the default, means
  "resolve it", not "none": `BARE_CLAUDE_TOKEN_FILE` from the child's environment, then
  `$XDG_CONFIG_HOME/bare-claude/oauth`, then `~/.config/bare-claude/oauth`. See
  [Authentication](#authentication).
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
- `processGroup`: The process group the spawned process leads — its PID — when spawned with
  `spawnOptions.detached: true` on macOS or Linux; `null` otherwise
- `dispose()`: Removes the ephemeral Claude home directory, but only when `spawnClaude` created it.
  Idempotent. Call it in a `finally`; without it every spawn leaks a temporary directory.

`spawnClaude` rejects when anything fails before the child is spawned — a token file, a session
seed, `settings.json`, the spawn itself — and takes back what it published: the journal while the
path still names the file it wrote, the `history.jsonl` line while nothing was appended after it,
and the whole home if it created it. Whatever had to be left is named in the error. Once spawned,
`subprocess.exited` is the spawned process's exit code, nothing more: it does not say whether the
task was done, nor that anyone has read the result.

`spawnClaude` does not supervise what it spawned. The CLI does, with `superviseSignals` from
`@agladysh/bare-claude/lifecycle` (see [Stopping a run](#stopping-a-run)); a library caller that
spawns detached should use the same supervisor rather than its own signal handlers:

```typescript
import { spawnClaude } from '@agladysh/bare-claude';
import { signalExitStatus, superviseSignals } from '@agladysh/bare-claude/lifecycle';

// Before the spawn: SIGTERM, SIGINT or SIGHUP from now on stops the run instead of ending this
// process, and one that arrives during the spawn is held until there is a run to stop.
const supervisor = superviseSignals({ graceMs: 10_000 });
const claude = await spawnClaude({ callToAction: 'Explain this project to me' }, { detached: true })
  .catch((error: unknown) => {
    supervisor.release();
    throw error;
  });
// Attached at once, before anything else that could throw, and everything after it inside the
// try whose finally finishes supervision: a detached run is never left with nobody to stop it.
supervisor.attach(claude);
try {
  const exitCode = await claude.subprocess.exited;
  await supervisor.finish();
  process.exitCode = supervisor.stoppedBy === null ? exitCode : signalExitStatus(supervisor.stoppedBy);
} finally {
  // Stops the run if it is still going, and waits for the stop, a further signal still escalating
  // meanwhile; only then is the home removed.
  await supervisor.finish();
  await claude.dispose();
}
```

`superviseSignals(options)` takes `graceMs`, and optionally `signals` (default all three),
`onEvent` — told of each `SupervisorEvent`: `held`, `stopping` (with its `cause`, a signal or
`'finish'`), `escalating`, `after-exit` — and `source`, where signals come from (default this
process). It throws, before installing any handler, when `graceMs` is not a finite number from 0
up or `signals` is not a list of SIGHUP, SIGINT and SIGTERM; a signal named twice is listened for
once. `stopClaude` refuses such a `graceMs` too, before signalling anything. The `Supervisor` it
returns has:

- `attach(run)`: hands over the run; a held signal starts its stop now. One run per supervisor.
- `finish()`: if the run is still going and nothing stopped it, stops it with SIGTERM; waits for
  any stop; then removes the handlers. Resolves with the `StopReport`, or `null` when there was no
  stop. Idempotent. Call it before `dispose()`. A signal during any stop, this one included,
  sends SIGKILL to that same stop at once; it never starts a second one.
- `release()`: removes the handlers without stopping anything, for a spawn that failed. Refused
  once a run is attached: the next signal would then end the caller and orphan the detached run,
  or cut its stop short. `finish()` is the way out from there.
- `stoppedBy`: the signal that started the stop of a running run, or `null`. A signal after the
  run had already ended on its own is not one, and neither is one that only hurried a stop
  `finish()` started. `signalExitStatus(signal)` is the matching 128+n.

Until `finish()` or `release()`, those signals do not end the calling process; it must end
itself. Without `detached`, the child shares the caller's process group: a terminal's Ctrl-C
reaches it directly, and a stop reaches only the spawned process, not what it started.

### stopClaude(run, options)

From `@agladysh/bare-claude/lifecycle`. Ends a run in three bounded steps: `options.signal` to
the spawned process alone; once it has exited, the same signal once to what it left in its process
group; SIGKILL to the whole group when `options.graceMs` runs out or `options.escalate` (an
`AbortSignal`) is aborted. Without a process group, the spawned process alone is signalled at
each step. Resolves with a `StopReport`: `signal`, `escalated`, the spawned process's `exitCode`
and `signalCode`, `processGroup`, and `groupState` — `empty`, `occupied` (something outlived
SIGKILL within two seconds), `not-permitted`, or `null` without a group.

It signals only the process Bun spawned, through Bun's handle, and only a group whose id is that
process's PID; any other `processGroup` is refused, as are ids 0 and 1 and the caller's own PID.
`processGroupState(pgid)` probes a group with signal 0. A stop ends processes; it does not undo what
they wrote or sent.

### Pure launch configuration

`spawnClaude` is assembly plus side effects. The assembly is exported separately, so the whole
flag matrix can be inspected and tested without spawning anything:

- `LaunchConfig(options)`: resolves `LaunchOptions` to a fully defaulted `LaunchConfig`.
- `buildArgv(config, sessionId)`: the full command vector, `argv[0]` included.
- `buildSettings(config)`: the `settings.json` document.
- `buildEnv(config, { ephemeralClaudeHomePath, processEnv?, spawnEnv? })`: the child environment.

All three are pure — no filesystem, no clock, no subprocess.

#### Precedence

`cwd` is `launchOptions.cwd ?? spawnOptions.cwd ?? process.cwd()`, made absolute, and the winner
also determines the session transcript path, so the two can never disagree.

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

`locateConfig(cwd?)` names the `bare-claude.yaml` a run from `cwd` would load — at the root of
the enclosing Git working copy, whether or not the file exists — or `null` outside one;
`configFileName` is the name it appends. The CLI and `--doctor` both resolve through it.

`loadConfig(source, cwd?)` reads the configuration a `ConfigSource` selects —
`{ kind: 'located' }`, `{ kind: 'file', path }` or `{ kind: 'none' }`, the library side of the
default, `--config` and `--no-config` — and validates it; see
[Choosing the configuration](#choosing-the-configuration). `authMode` is the schema for the
`auth` field, as `effortLevel` is for its own.

`@agladysh/bare-claude/preset` exports `resolvePreset(preset, presets)`, which folds a
`DynamicPreset`'s `use` chain and applies the CLI display defaults to produce a runnable `Preset`
— the function behind the [preset resolution order](#preset-resolution-order) above.
`mergeInvocation(config, overrides, use?)` merges a whole invocation the way the CLI does — the
configuration's root preset, the command line's fields over it, `--use` replacing the root's
`use` — into a `MergedPreset` that need not be runnable; `resolveInvocation` does the same and
then requires a `callToAction`. The CLI runs through the second and `--doctor` through the first,
so both read an invocation identically. A `Preset` also carries the CLI-only `stopGraceMs`.

### Token file

From `@agladysh/bare-claude/token`, what `spawnClaude` and the doctor share. `resolveTokenFile(explicit?, env?)`
applies the precedence above and `defaultTokenFile(env?)` is its last step; `tokenVariable`,
`tokenFileVariable` and `alternateCredentialVariables` name the variables involved. `hasToken(env)`,
`alternateCredentialsIn(env)` and `hasCredential(env)` say what an environment already carries.
`inspectTokenFile(path)` reports `present`, `empty`, `absent` or `unreadable` with the mode and whether
it is `exposed` beyond its owner — never the content; `formatMode(mode)` prints the `chmod` digits.
`readTokenFile(path)` is the one function that returns the value: trimmed, `null` when there is no
file, throwing on an empty or unreadable one.

### runDoctor(options?) and formatDoctorReport(report)

From `@agladysh/bare-claude/doctor`. `runDoctor` returns a `DoctorReport`: `items`, each
`{ name, status: 'ok' | 'warn' | 'fail', detail, hint }` in print order, and `ok`, false when any
item failed. Every input is an option — `env`, `cwd`, `binDir` — so it can be run against a
machine assembled in a test. The invocation to check is `config` (a `ConfigSource`), `use` and
`overrides` (a `DynamicPreset`), merged by `mergeInvocation` exactly as a run merges them;
`claudePath`, `tokenFile` and `auth` are shorthands that win over both. `--doctor` passes its
`--config`/`--no-config`, `--use` and every other flag through these. `formatDoctorReport`
renders what `--doctor` prints. See [Doctor](#doctor).

### install(binDir, options?), status(binDir), uninstall(binDir)

From `@agladysh/bare-claude/install`, the library behind `bun run install:user`. `status` reports
`installed`, `absent` or `foreign` (with a `detail` naming what is there instead). `install`
symlinks `commandSource` — this package's `bin/bare-claude.ts` — into `binDir` as `commandName`,
replacing a foreign entry only with `{ force: true }` and a directory never; `uninstall` removes
only that symlink. `defaultBinDir(env?)` is `~/.local/bin`. See [Installation](#installation).

### Examples

See [`bin/bare-claude.ts`](./bin/bare-claude.ts) for more advanced usage example.

## Assumptions

The current version of the Bare Claude makes the following assumptions:

- Claude Code executable, `claude`, is installed and available in `PATH` (or pointed to via
  `claudePath`/`--claude-path`)
- `bare-claude` is run inside a Git working copy, unless `--config` or `--no-config` says which
  configuration to read and nothing is preloaded
- `git` is installed and available in `PATH`

`bare-claude --doctor` checks each of these.

## License

MIT
