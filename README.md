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

Releases are cut as Git tags. To install this release, 0.14.0, from its tag:

```bash
bun add github:agladysh/bare-claude#v0.14.0
```

A tag is a name. A consumer that depends on what it installed should record the commit that name
resolved to, as well as the tag.

The npm registry is a separate route. `@agladysh/bare-claude` there resolves to whatever version
was last published, which a Git tag does not establish:

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
- `--config [file]`: read this configuration file instead of `bare-claude.yaml` at the Git root;
  may be included several times, later files over earlier ones (see
  [Choosing the configuration](#choosing-the-configuration))
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
- `--outcome [file]`, `--journal [file]`: read a finished run's result and session journal as JSON
  and exit (see [Reading a finished run](#reading-a-finished-run))
- `--outcome-custody [dir]`: read a run's custody directory as JSON and exit (see
  [Reading a custody directory](#reading-a-custody-directory))
- `--outcome-batch [file|-]`: read many result/journal or custody requests in one process, one JSON
  line each
- `--brief`: with `--outcome-custody` or `--outcome-batch`, print a compact brief of each custody
  directory instead of its reading; refused with any other mode (see
  [Briefing a custody directory](#briefing-a-custody-directory))
- `--doctor`: report what a run needs and exit 1 when something required is missing
  (see [Doctor](#doctor))
- `--effort [level]`: `low`, `medium`, `high` (default), `xhigh` or `max`
- `--tools [list]`: comma-separated tools to allow; the empty string allows none
- `--disallowed-tools [list]`: comma-separated tools to deny; `*` denies all
- `--add-dir [dir]`: allow reads outside the working directory, may be included several times
- `--max-budget-usd [n]`: passed to `claude` as its own `--max-budget-usd` (see
  [Limits Claude Code applies](#limits-claude-code-applies))
- `--max-tokens [n]`: sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS` for the run
- `--max-output-length [n]`: sets `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH` and
  `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` for the run
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
- `--custody [dir]`: keep the run in this new directory, and make stdout one JSON custody event per
  line and nothing else (see [Run custody](#run-custody))
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

### Waiting, stopping and cleaning up

A supervisor deals with four different things, and Bare Claude keeps them apart:

- **Waiting** is the caller's: blocking on `bare-claude`'s exit, on `subprocess.exited`, or on the
  promise `runInCustody` returns. A caller can stop waiting without touching the run (see
  [Ending a wait without stopping the run](#ending-a-wait-without-stopping-the-run)).
- **Execution** goes on until the run ends or is stopped. It is supervised while the process that
  holds its supervisor is alive: under the CLI that is the `bare-claude` process, not whatever
  started it; in the library, the caller's own process. Bare Claude starts no timer and counts no
  turns, tokens, spend or output, so nothing in it ends a run on elapsed time or on a count. It
  stops a run itself only when its own supervision fails: custody that cannot record a run's start
  stops it (`custody-error`), and cleanup reached after an error stops a run still going. Its
  bounded waits — `--stop-grace-ms`, the waits after SIGKILL, the EPERM recheck, the wait for the
  child's last output — all begin only once a stop has begun or the run has ended. Limits Claude
  Code itself applies, when a caller passes them, are [described below](#limits-claude-code-applies).
- **A stop** is an intervention, carried out as [Stopping a run](#stopping-a-run) describes. What
  records it depends on the route:
  - SIGTERM, SIGINT or SIGHUP to the CLI: a `Claude stop:` line, and exit 128+n; under custody also
    a completion `stopped` whose cause is the signal.
  - In the library, the same signals to a process holding a supervisor with the default `signals`
    and `source`, or `finish()` while the run is going: the `StopReport` `finish()` resolves with,
    and `stoppedBy`, which names a signal and is `null` for a `finish()` stop. What is kept of
    either is the caller's to record.
  - An abort of `runInCustody`'s `signal`: a completion `stopped`, cause `cancelled`.
  - Custody's own `custody-error` stop: a completion saying so.

  A stop's reason belongs to whoever started it. Except for `custody-error`, where it is custody's
  own, no record here holds the reason: custody records the signal or `cancelled`, not why.
- **Cleanup** comes after the run has been seen to end: `finish()` with nothing left to stop, then
  `dispose()`, which removes a temporary home; under custody, the completion and observation
  written. Cleanup reached while the run is still going is a stop. The CLI and the library examples
  do that on purpose, so that a failure in the supervisor never leaves a detached run with nobody to
  stop it. The CLI then exits 1 with the error, not 128+n.

Reading a run's records while it goes on — `--outcome-custody`, its journal, the figures a brief
reports — is observation. It changes nothing, and a figure there is not by itself a reason to stop.

A stop because a chosen duration has passed makes that duration the reason: `timeout D bare-claude
…` does that, and so does a wait with a timeout followed by a stop. How long a model's task needs is
not known before it is done, so a duration picked as a forecast of it ends a run that may have been
about to finish. What the turn in flight had not yet written is lost; the record says the run was
stopped, and nothing in it says how near the work was to done. A deadline someone actually has, or
a constraint outside the run, is a different reason, and the caller's to weigh.

#### Ending a wait without stopping the run

There is no detach: no daemon takes a run over, and a supervised run cannot be handed to another
process (`release()` is refused once a run is attached). What can end without the run is the wait.
A caller that needs its attention back keeps the process holding the supervisor alive and returns a
handle to the run. While that process lives, custody records the run's end when it sees it, unless
that write fails. A living holder is not evidence that the run is alive or making progress.

In the library, the holder is the process that called `runInCustody`. The example below returns a
handle only once custody has admitted the run, so the handle never reads a directory left by an
earlier run: `runInCustody` refuses an existing directory, and a reading taken before that refusal
would show the earlier run's records.

```typescript
import { readCustody, runInCustody, type CustodyCompletion } from '@agladysh/bare-claude/custody';

interface HeldRun {
  directory: string,
  /**
   * Settles once custody has recorded the run's end, or failed to and says so in `custodyError`,
   * and has written its observation. A run that never started settles it as `not-started`.
   */
  completion: Promise<CustodyCompletion>,
  /** An intervention: stops the run, recorded as `cancelled`. Record why yourself. */
  stop(): void,
}

/** Resolves once the run is admitted; rejects, with no handle, when it is refused. */
async function hold(directory: string, callToAction: string): Promise<HeldRun> {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const completion = runInCustody({ callToAction }, {
    directory,
    graceMs: 10_000,
    signal: controller.signal,
    onEvent: event => {
      if (event.kind === 'started') {
        started.resolve();
      }
    },
  });
  // A refusal, an existing directory among them, rejects here. A run that never started, or whose
  // start custody could not record, settles `completion` instead of emitting `started`.
  await Promise.race([ started.promise, completion ]);
  return { directory, completion, stop: () => controller.abort() };
}

const run = await hold('/work/runs/0042', 'Review the change described in NOTES.md');
// The holder goes on with other work, and the run goes on with it.
const reading = await readCustody(run.directory); // `start-only` until the completion is written
// …
const completion = await run.completion;          // waiting again, when the holder chooses to
```

Read in order, a custody directory goes from `unreadable` (not made yet) to `unknown` (made, no
records), `invocation-only`, `start-only` and then its end state. Only a reading taken before
admission sees the first three.

What holding asks of the holder:

- **It stays alive until `completion` settles.** It exits first through `process.exit()`, an
  uncaught error, a crash or SIGKILL. Then nothing records the run's end: the directory reads
  `start-only`, or `invocation-only` or `unknown` if it went earlier, and the run, in a process group
  of its own, may go on with nobody supervising it. Bare Claude does nothing to keep a holder alive
  against these, or to say what becomes of the run after it.
- **Signals to it are stops.** With the default `signals` and `source`, each run in custody installs
  a supervisor's SIGTERM, SIGINT and SIGHUP handlers in the holder, so one such signal stops every
  run it holds. While a run is held, those signals do not end the holder; it must end itself.
  SIGKILL ends the holder at once, with the consequences [listed below](#stopping-a-run) for
  `bare-claude` itself.
- **`stop()` is the intervention.** An abort while custody is still preparing still spawns the run,
  and then stops it at once, recorded as `cancelled`. `AbortSignal.timeout(ms)` passed as `signal`
  is a stop on elapsed time, as above.

`spawnClaude` under `superviseSignals` works the same way: the handle is the returned run with its
supervisor, and `subprocess.exited` is the wait. The example under [API](#api) calls `finish()` in a
`finally`, so leaving that scope while the run goes on stops it. A caller that has to stop waiting
keeps both in the holding process, and calls `finish()` and `dispose()` once `exited` has settled,
or to stop the run.

From a program driving the CLI, supervision lives in the `bare-claude --custody DIR` process the
program spawned, not in the program. The program's handle is that child as it spawned it: the
runtime's process object, not a PID written down for later.

- **The run stays supervised for as long as `bare-claude` lives**, whether or not the program waits
  on it. Ending the wait means not waiting on the child, and not signalling it.
- **The program keeps the child object for as long as it wants the exit status, or to stop the run
  through it.** A program that goes loses both. The run's end is then known only from
  `completion.json`. `start.json` names the spawned `claude`'s PID and group, not `bare-claude`'s,
  so a later stop is a signal to that group, recorded as `exited` by someone else's signal, not as
  `stopped`.
- **Its departure must not signal `bare-claude`.** SIGHUP, SIGINT or SIGTERM reaching it stop the
  run, and `bare-claude` is in the program's process group unless spawned otherwise: a hangup or a
  signal to that group, such as a terminal closing or a Ctrl-C, reaches it. A command merely put in
  a shell's background is no different; whether a hangup reaches it is the shell's business.
- **Its output.** When stdout's reader goes away, closing the pipe, the event stream ends and the
  run goes on. That case is tested; an open pipe nobody reads, and SIGPIPE at its default
  disposition, are not. stderr has no such handling, so give it a file.
- **Observation.** `bare-claude --outcome-custody DIR --brief` shows what the records say at any
  time: `start-only` while no completion is written. That is a reading of the records, not of a
  live process.
- **To stop the run**, signal that child as [Stopping a run](#stopping-a-run) describes. When it
  ends, `completion.json` records how, unless custody says it could not write it.

#### Limits Claude Code applies

Bare Claude passes these to Claude Code when a caller sets them, and sets none by default. They are
Claude Code's own controls, and legitimate options for a general wrapper to carry: a spending limit
someone actually has, a constraint a person directed, or a protocol check specified as one turn is
what they serve. They are not completion conditions. How much of each quantity the work needs is
not known before it is done, and reaching a limit does not mean the work is finished.

What Bare Claude does with each is below. What Claude Code does when a run reaches one has not been
measured here.

- `maxBudgetUsd` (`--max-budget-usd`) is passed to `claude` as its own `--max-budget-usd`, a limit
  in US dollars by Claude Code's own cost figures.
- `maxTokens` (`--max-tokens`) sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS` in the run's settings `env`, the
  variable Claude Code reads for the tokens the model may generate in one response.
- `maxOutputLength` (`--max-output-length`) sets `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH`
  and `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` there, all to the same number. As their names say,
  they concern command output, task output and file reads going into context: what the model
  reads, not what it writes. Their units, what Claude Code does with the excess, and what the model
  is told of it have not been examined here. Nothing here ensures that a model treats a shortened
  read as incomplete.
- `--max-turns N`, forwarded with `--claude-arg` or `extraArgs`, is Claude Code's own option for a
  limit on turns. Bare Claude does not interpret it.

A limit chosen as a forecast of how much the work needs fails as a chosen duration does: the run
ends however Claude Code ends it at the limit, or works from less than there was to read, and
nothing about the work said it was done. Custody records the first three in `invocation.json`, and
`extraArgs` as given, so whoever receives the run can see which were in place.

### Stopping a run

What follows is how a stop is carried out once someone has decided on one.

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

**What this asks of a supervisor that stops a run.** Because `claude` is no longer in
`bare-claude`'s own process group, a kill aimed at that group — `timeout -k`'s final SIGKILL, a
job-control kill of a shell job — ends `bare-claude` alone, and the run goes on unreported. A
supervisor that has decided to stop a run must do one of:

- signal `bare-claude` itself, and allow it at least `--stop-grace-ms` plus 6 seconds — the two
  bounded 2-second waits after SIGKILL, up to a second reading again a group that answers EPERM,
  and a second for the last of the child's output — before
  any kill of its own, plus whatever removing a temporary home takes. With the default grace that
  is at least 16 seconds:

  ```bash
  kill -TERM "$child"  # the supervisor's own bare-claude child; why it stops is the supervisor's
  # Any SIGKILL of the supervisor's own comes no sooner than --stop-grace-ms + 6 s after this:
  # 16 s with the default grace, more while a temporary home is being removed.
  ```

  A kill-after such as `timeout -k K` is the same allowance: with the default grace, `-k 20`
  leaves room and `-k 5` does not.
- or signal the reported `Claude process group` directly.

`Claude stop:` says whether SIGKILL was needed and what was left in the group: `empty`,
`still occupied after SIGKILL`, `occupied; it was not sent SIGKILL` (it had not read occupied
when SIGKILL was decided against), or `not shown empty: signal 0 failed with EPERM for 1000 ms, …`.
EPERM means `bare-claude` could signal none of the group's members; it does not show that anything
there is still running, or whose it is. A run
that ends without being asked is not signalled. If its group still has processes then, they are
left alone — they may be work the run meant to leave running — and reported as such, the home is
kept rather than removed under them, and `bare-claude` stops reading the child's stdout and exits
with `claude`'s own code even if one of them still holds that pipe open:

```
Claude process ended: exit code 0
bare-claude: claude exited, but process group 41321 still has processes; they were not signalled and may still be running
Claude home kept at /var/folders/…/bare-claude-home-…
```

A group that answers EPERM then is read again for up to a second, as a stopped run's is. If it
answers EPERM throughout, it is not taken for empty: nothing in it is signalled, the home is kept
as for a group with processes, and the line says so:

```
bare-claude: claude exited, but process group 41321 was not shown empty: signal 0 failed with EPERM for 1000 ms, which shows neither what is left nor whose it is; nothing in it was signalled
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
  directory, Claude home, tools and read scope, auth mode, session seed and output in one
  validated file, with nothing copied from a launcher script and no flag left to remember. Given
  several times, it reads each file, in order, and composes them (see
  [Composing several files](#composing-several-files)).
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
callToAction: Continue
# What `claude --print` prints, and no transcript beside it, on stdout.
quiet: true
print: true
```

```bash
env -i PATH="$PATH" HOME="$HOME" USER="$USER" TMPDIR="${TMPDIR:-/tmp}" \
  bare-claude --config invocation.yaml
```

`env -i` is the command line's way to scrub the environment the run inherits; `noProcessEnv`
with `spawnOptions.env` is the library's. Which variables to pass back is the caller's to know,
not this example's: `PATH` finds `bun` and the executable, `HOME` is where Claude Code and the
default token file are looked for, and `USER` and `TMPDIR` are among what programs commonly
expect of a login environment. A launcher's own requirements, documented by whoever maintains it,
come first; a list copied from here is not a substitute for them.

The doctor reads the same configuration the same way: `bare-claude --doctor --config
invocation.yaml`, with the same `--use` and flags, checks the executable, working directory,
auth mode and child environment that run would have. It reads one named file: `--doctor` with
several `--config` files is refused rather than checked as something else. For a composed run,
`bare-claude --doctor --config profile.yaml --use worker` checks the profile's launcher, auth
and environment; fields only the run's own file sets, such as its `cwd`, are not checked.

#### Composing several files

A shared profile and one run's own declaration need not be copied into one file. Name both, the
profile first:

```yaml
# profile.yaml, maintained once
presets:
  worker:
    auth: caller
    claudePath: /opt/launchers/claude
    extraArgs: [--output-format, json]
```

```yaml
# run-0042.yaml, written for one run
use: worker
cwd: /work/checkout
model: opus
tools: [Read, Grep, Glob]
callToAction: '# Review the change described in NOTES.md'
custody:
  directory: /work/runs/0042
```

```bash
bare-claude --config profile.yaml --config run-0042.yaml
```

The files compose as though they were one, each validated on its own first:

- named presets are pooled, and a name two files define is refused;
- root presets merge in order, as presets do: a later file's values win, records merge key by key,
  arrays concatenate;
- at most one file's root may name a `use`; two are refused, and `--use` still replaces it;
- naming one file twice is refused, by the same name or another: a symbolic link to it, or a path
  through a linked directory.

Each file is read once: its bytes are read whole through one open handle, and both the digest a
custody run records and the configuration parsed come from those bytes (see
[Run custody](#run-custody)). The handle is opened without blocking, so a FIFO or anything else
that is not a regular file is refused at once rather than waited on.

The command line then goes on top, exactly as over one file. What the profile says reaches every
run that names it; a credential in its `extraEnv` included.

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
3. Values from `bare-claude.yaml` (top-level keys, excluding the `presets` section), or from the
   `--config` files, composed in order
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

## Run custody

`--custody DIR` (`custody: { directory, keepCallToAction? }` in a configuration file) keeps one run
in a directory of its own, from before the spawn until the spawned process has been seen to end.
The directory must not exist, and its parent must: custody begins fresh, mode 0700, and nothing it
writes there is ever rewritten or removed. Relative, it resolves against the directory
`bare-claude` runs in.

| File | Written | Holds |
| --- | --- | --- |
| `invocation.json` | before the spawn | the custody directory, launcher, executable, model, effort, permission mode, tools, `addDirs`, budget and token caps, auth mode, `linkAuth`, `noProcessEnv`, `extraArgs` as given, the physical cwd, the Claude home, the session (`fresh`, `memory` with its id, or `file` with its source path and digest), the call to action's length and SHA-256, and the configuration that declared the run (below) |
| `call-to-action.txt` | before the spawn, only with `keepCallToAction: true` | the call to action, exactly |
| `stdout`, `stderr` | by the spawned process, as it runs | its own standard output and error, byte for byte: its descriptors, not pipes. Empty when it never started |
| `start.json` | after the spawn returned | PID, process group, session id, journal path, Claude home, when the record was written, the caller's identity reading (`identify`), if any, and `seededJournal`: the size and SHA-256 of the bytes put in the journal before the spawn, or `null` when nothing was |
| `completion.json` | once it was seen to end, or it never started, or a custody-error stop ran its bounded course | outcome, exit code and signal, the stop and its cause, the group's reading, and the size and SHA-256 of each output and of the journal |
| `observation.json` | after the completion is written, or has failed to be | the directory as [`--outcome-custody`](#reading-a-custody-directory) reads it at that moment |
| `home/` | by `spawnClaude` and the child | the Claude home, unless `ephemeralClaudeHomePath` names another |

**Configuration.** Under the CLI, `invocation.json`'s `configuration` names the route that chose
the configuration (`files` for `--config`, `located` for the working copy's `bare-claude.yaml`,
`none` for `--no-config`) and every file read, in the order composed. Each file is given by its path
as named, made absolute, by the physical path that name led to, and by the size and SHA-256 of
exactly the bytes that were parsed. The physical path is resolved just after the read, and it is
`null` when by then it no longer led to the file read, by device and inode. The record also names
the presets selected at the root (`use`),
and whether `--use` or the configuration selected them (`useFrom`). No file's contents are
recorded, but a file can hold a credential. A digest does not reveal it, yet anyone holding a
candidate file can confirm it against the digest.

Custody itself reads no configuration: the record holds what `runInCustody`'s caller stated, and
its `scope` says no more than that, whoever wrote it. When that caller is the CLI, what it states
is what its configuration reader read before the run. A library caller passes `configuration`
itself, and the record cannot tell the two apart. Nothing reads those files again or compares them
later, so a profile replaced after the run leaves the record as it was. Without a stated
configuration the field is `null`. In records written by 0.12.0 it is absent.

Custody's own records hold no environment value — not `extraEnv`, not `extraSettings`, not a token
it read — and nothing in `invocation.json`, `start.json` or `completion.json` is read from the
output. `observation.json` is a reading of the output: it holds what the outcome reader reports,
an error result's text and the journal's API-error texts among it, each cut to 200 characters.
Beyond those it holds identifiers, verbatim reason codes, counts, paths and digests: no message,
prompt or tool output. `invocation.json`, and so `observation.json`, hold `extraArgs` as given,
as `--debug` prints them: a secret passed there is recorded with them. The directory as a whole is
not free of sensitive material, and custody does not make it so: `home/` holds what a kept Claude
home holds — `settings.json`, mode 0600, with `extraSettings` merged in, its `env` block included;
the session journal, which holds the call to action and whatever tools read, whatever
`keepCallToAction` says; under `auth: fallback` with `linkAuth`, a symbolic link to the real
credential file where one was found; and Claude Code's own state. `stdout` and `stderr` hold
whatever the spawned process wrote. Keeping the directory is keeping all of that.

Under custody the CLI's stdout is the custody event stream, one JSON object per line: `started`
(with the start record), `supervisor` (each step of a stop), `completed` (with the completion
record, as written), and `observed` last. `observed` carries the file the observation was written
to, or the error that kept it from being written, and the observation's `format`, `version`,
`state`, `basis` and `problems`, not the whole of it. The whole reading holds the invocation,
`extraArgs` verbatim among it, and stays in `observation.json`, mode 0600, inside the 0700
directory, rather than reaching whatever reads or logs the stream. Nothing else goes there: the
transcript is not
rendered, `--debug` prints to stderr, and `print` is refused, so a declaration needs no `--quiet`
or `--print`. The usual lines still go to stderr, then `Claude run observed: STATE, in FILE`, and
`Claude run custody at DIR` last. Writing a line passes an event on; it is not its receipt, and
whether anyone read it is not known here. A reader that goes away ends the stream, with one line on
stderr, not the run: the completion and the observation are still written to the directory.

A run refused before custody began — an invalid configuration, a used directory, a missing parent —
writes no event and leaves no directory. An event stream that ends with no `started` or `completed`
line therefore says nothing about the exit status or the cause; both are on the CLI's own exit
status and stderr, which only whoever ran it holds.

The exit status is the child's own, or 128+n after a stop signal, as for any run; 1 when the run
never started, and 1 rather than 0 when custody failed to record something. The observation
changes none of that: one that could not be written is reported on stderr, and the status stands.

**The observation is a reading, not a receipt.** Every run in custody is read at its end. Opting
into custody already opts into keeping the run's records, and the observation reads only those
records. It reports what they say, including a context limit, an error result, a stop reason and
outputs that changed after the completion, and it decides nothing. It does not attribute the
output to native Claude Code, and it does not say the task was done or delivered. Whoever receives
the run still has to read the observation and act on it.

What a completion says is how the spawned process ended, and nothing more:

- `exited`: it was seen to end without custody stopping it — its own exit, or a signal someone
  else sent (`exitCode`, `signalCode`);
- `stopped`: custody started a stop through the supervisor (`stop.cause`: the signal, `cancelled`
  for a library caller's abort, or `custody-error` when custody could not record the start).
  After a `custody-error` stop, both `exitCode` and `signalCode` null mean it had not been seen to
  end when the stop's bounded waits ran out; after any other stop, custody waits for its exit
  without a bound, as an ordinary run does;
- `not-started`: it never started, and `notStarted` says why.

That process is whatever `--claude-path` names, a launcher perhaps, not native Claude Code. Its
exit is not native's, and not the task done, delivered or accepted; `stdout` is what it wrote —
native's result only when it is native, or as far as a launcher passed it on. `ended` is when
custody wrote the completion, not when anything the run started last acted.

A directory with `invocation.json` and no `start.json` may hold a run spawned just before its
runner died, since the start is recorded after the spawn; one with `start.json` and no
`completion.json` is a run whose end custody did not record: its runner died before or after
the spawned process ended, and nothing here says which. Either outcome is unknown, not failed
and not done. `start.json` names the PID and group as they were; its `recorded` time is when custody wrote
it, not when the process began. A PID names whatever holds it when it is read, so acting on one
later needs an identity — `identity`, when a library caller gave `identify` — established by
whoever acts.

Custody offers no continuation. `journal` records the session's path, id, size and SHA-256 as read,
and `processGroupAfter` the group's reading; neither shows that nothing is still writing the
session. `empty` covers that one process group: a process that started a session of its own — a
launcher's native child, say — is outside it and may outlive it. Whether to continue is the
caller's to establish, with whatever knows the native process. A caller that decides to passes
`{ sessionId, sourcePath: journal.path, sourceSha256: journal.sha256 }` as `customSessionData`, and
the digest makes the next spawn refuse a journal that changed since it was read.

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

## Reading a finished run

What a run's files say, without spawning anything.

The offline readers ignore launch configuration and launch flags, including `--custody`;
they create no run directory.

```bash
bare-claude --outcome run/result.json --journal run/home/projects/<key>/<session>.jsonl
```

This prints one JSON object: `reader` (this package's name and version), `result`, `journal` and
`join`. Either flag may be given alone. Exit status 1 means only that a named file could not be
read; it never says how the run ended.

For many files, read them in one process:

```bash
bare-claude --outcome-batch requests.jsonl     # or `-` for stdin
```

- **Input.** Each non-empty line is `{"id"?: string, "result"?: path, "journal"?: path}`, or
  `{"id"?: string, "custody": dir}`, read as [`--outcome-custody`](#reading-a-custody-directory)
  reads it. A custody line that also names a result or journal is refused: the directory names its
  own. Relative paths resolve against the current directory.
- **Output.** One JSON line per input line, in order, with `line`, `id`, `reading` and `error`.
  A bad line, or a file that cannot be read, is that line's `error`; the others are still read.
- **Each file is read once.** Each distinct path is read once per batch, so every line naming a
  file refers to the same bytes; each distinct custody directory likewise. Exit 1 only when the
  requests themselves cannot be read.

**What a reading says, and what it does not.** Nothing here decides whether a process has ended,
whether the work was done, or whether anything was delivered. `status: "no-error"` means only that
Claude Code's result reported no error: a run can end that way having done part of its task.
Results, observed on Claude Code 2.1.292, carry three scopes under similar names, kept apart here:

- **`result.lastCall`** is the last entry of `usage.iterations`, the last API call of that
  process. Its `prompt` is the input plus both cache counts that call sent.
- **`result.process`** is the rest of `usage` and `duration_ms`, summed over that process's
  calls. It has no `prompt`. A sum of cache reads over many calls is not a context size.
- **`result.session`** is `total_cost_usd`, `duration_api_ms` and `modelUsage`. They are
  cumulative over the whole session, earlier processes of a resumed session included.
  Its costs are Claude Code's own figures: not a bill, and not subscription usage, which
  `--usage` reports.

**Other result fields:**

- `subtype` was `"success"` on every error result observed. It is reported verbatim and never
  read as an outcome; `status` comes from `is_error` alone.
- `terminalReason`, `stopReason` and `safetyStops` are reported verbatim. `stopReason` and
  `safetyStops` are not interpreted.
- `contextLimit` is set only on an error result. It says whether `terminal_reason` was
  `blocking_limit`, whether the error text was exactly "Prompt is too long", or both. A result
  without error that quotes those words is not a context limit.
- A token count that was not recorded is `null`, never `0`. A `prompt` is `null` unless all three
  input counts were recorded.
- `file` is `result`, `empty`, `unreadable` (possibly cut short) or `not-a-result`, with the SHA-256 of the bytes read (null for an empty result file).

**The journal is read by cost-state segment.** Claude Code writes a `cost-state` record carrying
the session's cumulative totals. Not every process end writes one, and a process that spent
nothing can write one repeating the previous totals. A journal copy seeded from an earlier
copy holds none of the processes on other branches of the session.

- **Segments are not processes.** A segment is the records up to and including one `cost-state`
  record. A process that writes none, for example one that crashed or was killed, is merged with
  the next. `openTail` means records follow the last `cost-state` record: still running, stopped
  or crashed, which the journal cannot tell.
- **Per segment:** its closing record (line, session, totals), record count, sessions, native
  `versions` from the records' envelopes, first and last timestamps, API-error records and
  `compact_boundary` records.
- **Its last measured call.** Skipped: synthetic records, and usage that is incomplete or has a
  zero prompt, as Claude Code itself skips them when it reads usage back on resume. The skipped
  calls are counted in `unmeasuredCalls`.
- **Compaction records.** The fields of a `compact_boundary` record are not established: only its
  keys are listed, and `compactMetadata.preTokens` is read when present.
- **Versions come from the journal.** The result and `cost-state` records carry no version.

**`join` correlates a result with a cost-state segment.** It requires the session, exact totals
and a measured last call on both sides. These records carry no invocation identifier, so a
join is a correlation on those fields, not proof of process identity. Its `kind` is one of:

- `joined`: exactly one `cost-state` record names the result's session and states its
  `total_cost_usd` and `duration_api_ms`, and both measured last-call prompt token totals agree.
- `ambiguous`: several such records state the same totals. Every candidate is listed and none is
  chosen.
- `disagrees`: the cumulative totals match, but the measured last-call prompt token totals differ.
- `no-match`: the journal never names the result's session, or no `cost-state` record of that
  session states its totals.
- `not-comparable`: the result holds no session or totals, or either side has no measured last call.

`lastCallPromptTokensAgree` is `true` on a join, `false` on `disagrees`, and `null` when no
comparison was made. It compares token counts, not prompt contents or call identity.
On a join, `contextLimitRecord` is the uuid of that segment's "Prompt is too long" record, and
`versions` are the segment's native versions. A segment can span processes: that error record
alone cannot attribute a context-limit ending to the result's process.

**Programmatically**, from `@agladysh/bare-claude/outcome`:

- `readResult(bytes)`, `readJournal(bytes)` and `joinResult(result, journal)`: pure, and they
  never throw.
- `readOutcome(result, journal)`: puts two readings together.
- `readOutcomeFiles(requests, readFile)`: the batch reader, with your own file reader.
- `parseOutcomeRequest(line)`: reads one batch line, as an `OutcomeRequest`, a `CustodyRequest`
  or why it is neither.
- `callTokens(usage)` and `isMeasuredPrompt(tokens)`.
- Constants: `contextLimitText`, `contextLimitTerminalReason`, `processScope` and `sessionScope`.
- Types: `TokenSums`, `ResultReading`, `JournalReading`, `JournalSegment`, `ResultJournalJoin`, `JoinKind`,
  `OutcomeRequest`, `CustodyRequest` and `OutcomeEntry`, with their parts.

### Reading a custody directory

```bash
bare-claude --outcome-custody /work/runs/0042
```

This prints one JSON object (`format: "bare-claude/custody-reading"`, `version` 1): what the
directory's files held when they were read. Every run in custody gets the same reading written as
its `observation.json` once its completion is written. Nothing is spawned, signalled or written,
and no PID is looked up. Exit 1 means only that the directory could not be listed.

**`state`** says what the records say, never what a process is doing:

| State | The records |
| --- | --- |
| `invocation-only` | an invocation and nothing after it. The run may have been spawned just before its runner died. Unknown, not failed and not done |
| `start-only` | a start and no completion. Custody did not record an end, and its runner may have died before or after the process ended. Unknown, not failed and not done, however old the start |
| `not-started` | a completion saying the run never started |
| `exited` | a completion saying the spawned process was seen to end without custody stopping it |
| `stopped` | a completion saying custody stopped it, by a signal or the caller's abort |
| `custody-error` | a completion saying custody failed at something of its own. Its `outcome` and exit fields are still as recorded |
| `unknown` | records custody never writes together, or that disagree with each other, or no custody record at all |
| `unreadable` | the directory could not be listed, or the record the state rests on could not be read as one this reader knows |

`basis` says why, and `problems` lists everything that could not be read or did not agree.

Records that disagree make the state `unknown`. That covers a start and a completion naming
different sessions or journals, and an invocation continuing another session or naming another
home. A completion of a process seen to end with no invocation or no start is `unknown` too:
custody writes both before it waits for an end. Two further checks bind the outputs to the start's
session. A stdout result naming another session, and journal records appended under other
sessions, are each one line in `problems`, and leave the state alone. The state rests on custody's
records, and neither output is one.

**What else it holds:**

- **The records**, `invocation`, `start` and `completion`. Each is `absent`; `read`, typed as
  written, with the file's size, SHA-256 and the time it was read; or `unreadable`, with why. A
  record is read only when its `format`, its `version` and every field are as custody writes them.
  A signal name is read if any platform names it, whichever host reads it.
- **`entries`**: the directory's names, anyone else's files included, which are not read.
- **`writtenIn`**: the directory custody wrote the records in. It comes from
  `invocation.directory`, or, in a record written before that field existed, from the outputs the
  completion names. `sameAsRead` is false when the directory has been moved or copied since. Then
  one line in `problems` says so, and a journal under the original directory is not read: read
  there, it would be the original's journal, or nothing, not this directory's. Mapping such paths
  into the copy is not attempted. When no record says where they were written, the journal is read
  where the records name it, and `problems` says that too.
- **`stdout`**: the bytes read, and what the completion recorded of them, with
  `changedSinceCompletion`. `writtenBy` is the invocation's `launcher` and `executable`, and
  `provenance` says what that is: what that executable wrote. It is native Claude Code's result
  only where the executable is native Claude Code. Nothing here establishes that, whatever the
  path is called or the output looks like. `outputFormat` is the last `--output-format` the
  invocation's `extraArgs` asked for. `result` is `read`, by `readResult`, either because the
  invocation asked for `json` (`json-requested`, and an empty or cut-short result is then itself
  the finding), or because the bytes are a result though it did not ask (`parsed-as-result`, as a
  launcher that adds the flag itself would make them). Otherwise it is `not-read`, with why.
  `claude --print` writes text by default, and text is not misread as a broken result. A run that
  never started has its stdout read as nothing at all.
- **`stderr`**: the same digest facts, unread.
- **`journal`**: the journal the completion names, or else the start (`namedBy`), read by
  `readJournal`. Like `stdout`, it carries `atCompletion` and `changedSinceCompletion`: whether it
  was written, created or removed since. That is a fact about bytes. It does not say who wrote
  them, or whether anything still writes, and it offers no continuation. `reading` is the whole
  journal. A continued session's journal begins with its whole earlier history, and an earlier
  process's context-limit or API-error record is there. `appended` reads only the bytes after
  those `spawnClaude` seeded before the spawn, which `start.seededJournal` records by size and
  SHA-256. Its `boundary` says where they end and how that is known, and `lineOffset` how many
  lines they held, since its line numbers count from there. It is `not-read` when the journal no
  longer begins with the seeded bytes, or when a start written before 0.13 continued a session.
  Count this run's records from `appended`, not `reading`.
- **`join`**: `joinResult` over the result and one reading of the journal, when both were read.
  `over` says which reading, and so which `segments` list `segment` and `candidates` index.
  - **`appended`** whenever the boundary is verified, a fresh session's included. An inherited
    segment, or an inherited context-limit record, is then never joined to this run's result.
  - **`whole`** only without a verified boundary: a continued session whose start predates 0.13,
    or a journal whose seeded prefix changed. There an earlier process that wrote no `cost-state`
    record shares a segment with this run's records, and `contextLimitRecord` may be that
    process's. Count a context limit as this run's only from an `appended` join or from
    `journal.appended`.

  Either way the join correlates the result with a journal segment's recorded figures. It is not
  process identity. `stdout.result.reading.process` stays the figures of the process that wrote
  the result, joined or not.

A context limit, an error result, a stop reason, API-error records and compactions are reported
where the outcome reader puts them, verbatim and in their own scope. No threshold is applied, and
nothing is inferred about purpose or about why the run ended.

The configuration files an invocation names are not read again. What the record says is what was
stated when it was written.

**Programmatically**, from `@agladysh/bare-claude/custody`: `readCustody(directory)`, which never
throws, resolving with a `CustodyReading`: `CustodyState`, `CustodyRecordReading`,
`CustodyFileRead`, `CustodyWrittenIn`, `CustodyOutputReading`, `CustodyStdoutReading`,
`CustodyStdoutResult`, `CustodyJournalReading`, `CustodyAppendedJournal`, `CustodyJournalBoundary`,
`CustodyJoin` and `RecordedDigest`, with the constants `custodyReadingVersion`, `custodyReadingScope` and
`stdoutProvenance`.

### Briefing a custody directory

```bash
bare-claude --outcome-custody /work/runs/0042 --brief
```

`--brief` prints a brief on one line in place of the reading
(`format: "bare-claude/custody-brief"`, `version` 1). A brief is a projection of the reading
[`--outcome-custody`](#reading-a-custody-directory) makes, and of nothing else. The directory is
read exactly as it is without `--brief`, and nothing is spawned, signalled or written. The brief
keeps what a supervisor or a log needs to say what became of a run: its state, how custody ended
it, how its session began, its measured figures each in its own scope, and the size and digest of
its stdout, stderr and journal. It leaves out the call to action; the result's text, error text
and API-error text; stderr; the reading's `basis` and `problems` text (`problems` becomes a count);
`extraArgs`; and anything from the environment. Every field is copied by name, so nothing else
attached to a reading passes through. The exit status is the same as for `--outcome-custody`: 1
only when the directory cannot be listed, and even then a brief with `state: "unreadable"` is
printed.

A continued session is best read as a chain of runs, with the runs in one batch:

```bash
printf '%s\n' '{"id":"0041","custody":"/work/runs/0041"}' '{"id":"0042","custody":"/work/runs/0042"}' \
  | bare-claude --outcome-batch - --brief
```

- **Output.** Each non-empty input line gets one output line, in order:
  `{"reader", "line", "id", "brief", "error"}`.
- **Reading.** Every distinct directory is read once, at its physical path. All of them are read
  before any brief is made, because the batch's own custody lines are where each run's lineage is
  sought.
- **Other lines.** A `result` or `journal` line is that line's `error`
  (`--brief reads custody lines only`), because those readings carry error text that a brief
  leaves out. A malformed line keeps its own error.
- **Exit status.** 0, unless the requests themselves cannot be read.
- **Other modes.** `--brief` without `--outcome-custody` or `--outcome-batch` is refused with
  exit 1 rather than ignored. That covers `--brief` on its own, beside `--outcome`, `--version`,
  `--usage` or `--display`, and on a run. Only `--help` takes precedence.

An illustrative example: run 0042 continued the session of run 0041, seeded from 0041's journal by
path, and 0042's line from that batch carries this `brief`. The paths, ids and figures are
invented, though consistent with one another. It is pretty-printed here, though the CLI prints it
on one line. Digests, the session id and the two constant sentences, `scope` and `costBasis`, are
shortened with `…`.

```json
{
  "format": "bare-claude/custody-brief",
  "version": 1,
  "scope": "one custody reading without its named payload fields (…); not redaction. …",
  "reader": { "name": "@agladysh/bare-claude", "version": "0.14.0" },
  "directory": "/work/runs/0042",
  "read": "2026-10-16T12:00:00.000Z",
  "state": "exited",
  "problems": 0,
  "inPlace": true,
  "run": {
    "packageVersion": "0.14.0", "launcher": "claude", "model": "opus", "effortLevel": "high",
    "callToAction": { "bytes": 41, "sha256": "9c1e…" }
  },
  "end": { "outcome": "exited", "exitCode": 0, "signalCode": null, "stopCause": null, "custodyError": false },
  "session": {
    "kind": "file",
    "sessionId": "0199e7a0-…",
    "sourcePath": "/work/runs/0041/home/projects/-work-checkout/0199e7a0-….jsonl",
    "requiredSha256": "b07d…",
    "seeded": { "bytes": 1843310, "sha256": "b07d…" }
  },
  "lineage": {
    "links": [
      {
        "directory": "/work/runs/0041", "matchedBy": [ "completion.journal", "journal as read" ],
        "state": "exited", "inheritedCall": { "status": "read", "prompt": 212000, "output": 3100 },
        "contextLimit": false, "compactions": 0
      }
    ],
    "end": { "status": "fresh", "candidates": [], "sameSession": [] }
  },
  "result": {
    "status": "read", "basis": "json-requested", "file": "result", "resultStatus": "no-error",
    "terminalReason": "completed", "stopReason": "end_turn", "numTurns": 23, "apiErrorStatus": null,
    "contextLimit": null, "sessionId": "0199e7a0-…"
  },
  "join": { "kind": "joined", "over": "appended" },
  "measured": {
    "lastCall": { "prompt": 387000, "output": 2400, "from": "result" },
    "contextWindow": null,
    "process": { "tokens": { "input": 41, "cacheCreation": 9120, "cacheRead": 3650000, "output": 18300 }, "durationMs": 412000 },
    "session": { "costUsd": 31.8, "apiDurationMs": 690000, "models": [ "claude-opus-5-5", "claude-haiku-4-5-20251001" ] },
    "inheritedTotals": { "status": "read", "costUsd": 14.2, "apiDurationMs": 301000 },
    "costBasis": "Claude Code's own reported dollar figure: …",
    "appended": {
      "segments": 1, "openTail": false, "versions": [ "2.1.292" ], "unmeasuredCalls": 0,
      "apiErrors": 0, "contextLimitErrors": 0, "compactions": 0, "preTokens": []
    }
  },
  "stdout": { "path": "/work/runs/0042/stdout", "bytes": 5210, "sha256": "41aa…", "changedSinceCompletion": false },
  "stderr": { "path": "/work/runs/0042/stderr", "bytes": 0, "sha256": "e3b0…", "changedSinceCompletion": false },
  "journal": {
    "path": "/work/runs/0042/home/projects/-work-checkout/0199e7a0-….jsonl",
    "sessionId": "0199e7a0-…",
    "atCompletion": { "exists": true, "bytes": 2390114, "sha256": "77c2…" },
    "changedSinceCompletion": false,
    "boundary": "seeded"
  }
}
```

**The figures, each in its own scope:**

- **`measured.lastCall`** is one API call. It is the result's last `usage.iterations` entry
  (`from: "result"`), or else the last measured call this run appended to its journal
  (`from: "appended journal"`). Its `prompt` is what that one call sent.
- **`measured.contextWindow`** is the context window the result reports when every model that
  reports one reports the same, and `null` when no model reports one or models report different
  windows. Results have been observed naming an Opus and a Haiku model with different windows, so
  `null` is the ordinary value for such runs. The brief then relates `lastCall.prompt` to no window. In neither
  case does it apply a threshold, compute a ratio, or say why a run ended near a limit.
- **`measured.process`** is the result's sums over this process's calls. It has no prompt: the
  cache reads above, summed over many calls, are not a context size.
- **`measured.session`** is cumulative over the whole session, including earlier processes of a
  resumed session. `models` leaves out any name that is not one word.
- **`measured.inheritedTotals`** is where the session's totals stood in the seeded bytes, from the
  last `cost-state` record those bytes hold (`status: "read"`); otherwise `nothing-seeded`,
  `no-cost-state`, or `unknown` when the journal was not read or its seeded bytes cannot be told
  apart. The
  brief does not subtract it from `session`.
  Whether Claude Code resumes its totals from that record is not established, so the two are
  figures side by side, not a difference.
- **Costs.** Every `costUsd` is what `costBasis` says it is: Claude Code's own reported dollar
  figure. It is not a bill, and it is not subscription usage, which `--usage` reports.
- **`measured.appended`** counts only what this run appended after its seeded bytes: segments,
  API errors, context-limit errors, and compactions with their `preTokens`. It never counts an
  inherited record. It is `null` when this run's records cannot be told from inherited ones, as in
  a session continued under 0.12.0, or when the journal was not read.
- **`result` and `join`.** `result` carries classifications and counts only. `join` carries the
  reading's `kind` and `over`.

**Lineage.** `lineage.links` lists a run's predecessors, nearest first. A predecessor is a run
whose journal has the digest of the bytes this run seeded, either as its completion recorded it or
as read (`matchedBy`). Each link is followed the same way. The digest used is `session.seeded`,
which the spawn measured. For a start written by 0.12.0, which recorded no seed, it is
`requiredSha256`, the digest without which the spawn refused to seed.

Each link says what the run after it inherited. `inheritedCall` is the predecessor's last measured
call, whose prompt Claude Code reads back as the context size on resume. It is known
(`status: "read"`) only while the predecessor's journal, as read, is exactly the seeded bytes;
otherwise it is `journal-differs`, `journal-not-read` or `no-measured-call`. A link also gives the
predecessor's `state`, whether it showed a context limit, and how many compactions it appended.

`lineage.end.status` says where the chain stops:

| Status | Meaning |
| --- | --- |
| `fresh` | the last run in the chain started a fresh session. The chain is whole |
| `not-sought` | no predecessors were given to look among. A single `--outcome-custody --brief` of a continued run whose records agree on a digest always reads so |
| `unknown` | the records do not say what was seeded: there is no readable start, or there is a 0.12.0 start with no readable invocation. A digest the invocation required is not bytes seeded, since a run that never started has one too |
| `no-digest` | it continued a session, but no record holds a digest of what it seeded: records written by 0.12.0, with a memory seed or a file seed that required no digest. A start written since 0.13.0 records the seeded digest |
| `conflict` | its records disagree about what was seeded |
| `ambiguous` | several journals given have the digest, and `candidates` lists them; none is chosen. A directory and its copy do this, for example, and so do identical journals from distinct runs that appended nothing |
| `source-differs` | no journal given has the digest, and `candidates` are the runs whose recorded journal path is the source the invocation named. Their completion digest differs from the bytes seeded, and so does their digest as read, where the journal was read |
| `unresolved` | no journal given has the digest. The predecessor may not be among those given. Bytes preloaded into a seed also change the digest |
| `cycle` | the next predecessor is already in the chain, which runs that appended nothing can cause |

`fresh`, `unknown`, `no-digest` and `conflict` come from the run's own records, so they read the
same with or without predecessors.

- **A session id never makes a link.** A session can be continued from any of its journals, or from
  bytes no custody kept. Under `no-digest` and `unresolved`, `sameSession` lists the runs given
  that share the session id, as a hint only: a run's own successors share it too.
- **The search covers the readings given and nothing else.** Nothing on disk is searched. A
  predecessor missing from the batch leaves the chain `unresolved`.
- **`fresh` describes the invocation.** One that started a fresh session reads `fresh` even with no
  start record. That is no evidence that anything ran; `state` says whether it did.

**Directory names.**

- **Batch briefs** name each directory by its physical path. A directory named twice, through a
  symbolic link for example, is one reading.
- **A copy is another directory.** It reads `inPlace: false`. Its journal path still names the
  original's journal, so that journal is not read. Given beside its original, the copy makes a
  successor's lineage `ambiguous`.
- **A single `--outcome-custody --brief`** names the directory as given, made absolute. The two
  modes can therefore spell one directory differently.
- **`briefCustody` called directly** compares directories as strings. A caller should read at
  physical paths, as the CLI does; otherwise an alias reads as `ambiguous`.
- **`source-differs`** compares source paths as recorded.

**Continuing from a brief.** `journal.path`, `journal.sessionId` and `journal.atCompletion.sha256`
describe the journal a continuation would seed from, but only while `journal.changedSinceCompletion`
is `false`. The brief does not offer a continuation any more than the reading does. Establishing
that nothing still writes the session is the caller's responsibility.

**Not redaction.** A brief leaves out the named fields above, and nothing more. It carries, as
recorded:

- absolute paths and directory names, journal paths included, whose project key spells out the
  run's working directory;
- session ids, and the model and effort level from the invocation;
- native one-word values, whatever they say: terminal and stop reasons, versions, model names;
- the call to action's size and SHA-256, which can confirm a guessed prompt.

A native string is `null`, or left out of a list, in two cases: when it was not recorded, and when
it is not one word of at most 128 printable characters. A `null` `terminalReason` does not say
which. That rule keeps native sentences out of a brief. It does not make a brief safe to publish.

**Not reception.** Printing, logging or showing a brief is not reception of the run's return. The
return is the stdout file the brief names: a receiver reads those bytes from `stdout.path` and
checks them against `stdout.sha256`. A brief shows what the records say. It does not show whether
the task was done, delivered, received or accepted.

**Programmatically**, from `@agladysh/bare-claude/custody`, `briefCustody(reading, predecessors?)`
makes a brief. It is pure, and works over readings `readCustody` made. Without `predecessors`,
lineage is not sought. With them, `reading` itself is skipped by directory, and a directory given
twice counts once.

```typescript
import { briefCustody, readCustody } from '@agladysh/bare-claude/custody';

// Physical paths, as the CLI's batch uses.
const directories = [ '/work/runs/0041', '/work/runs/0042' ];
const readings = await Promise.all(directories.map(directory => readCustody(directory)));
const briefs = readings.map(reading => briefCustody(reading, readings));
```

The brief is a `CustodyBrief`, made of `BriefRun`, `BriefEnd`, `BriefSession` (with `BriefSeeded`),
`BriefLineage` (`LineageLink`, `LineageEnd`, `LineageEndStatus`, `LineageMatch`,
`LineageInheritedCall`), `BriefResult`, `BriefMeasured` (`BriefInheritedTotals`, `BriefAppended`),
`BriefOutput` and `BriefJournal`. Its constants are `custodyBriefVersion`, `custodyBriefScope`
and `briefCostBasis`.

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
`bare-claude` is on `PATH`, and whether it is this checkout's symlink: any `bare-claude` on `PATH`
satisfies it, so an entry in the bin directory that is not this checkout's is a warning naming
what `PATH` resolves instead, and a failure only when nothing does. It says whether the command
can be run from this environment, nothing about whether a given invocation is ready — a scrubbed
environment with no `bare-claude` on its `PATH` fails it however ready its invocation is. A
consumer judging an invocation reads the `claude`, `auth` and `preset` items from `runDoctor()`
rather than the overall exit status. `preset` is the
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
- `cwd`: Working directory for the Claude process, made absolute and physical — every symbolic link
  resolved — by `physicalCwd(cwd)` (exported), because Claude Code keys its journal on the
  directory it actually runs in. It must exist; one that does not is refused before anything is
  created. Defaults to `process.cwd()`.
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
- `maxBudgetUsd`: passed to `claude` as `--max-budget-usd`, Claude Code's own limit in US dollars.
  Defaults to `null`, which passes nothing. What Claude Code does when a run reaches a limit is not
  measured here: see [Limits Claude Code applies](#limits-claude-code-applies) for this and the next
  two.
- `maxTokens`: sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS` in the settings `env`, the variable Claude Code
  reads for the tokens generated in one response. Distinct from `maxOutputLength`, which concerns
  *tool* output going into context. Defaults to `null`, which sets nothing.
- `maxOutputLength`: one number for `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH` and
  `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` in the settings `env`. Defaults to `null`, which sets
  none of them.
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
- `seededJournal`: The size and SHA-256 of exactly the bytes put in the session journal before the
  spawn — the `customSessionData` seed, with anything the CLI preloaded into it — or `null` when
  nothing was seeded. Everything after them was appended once the spawn had happened
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

Here `finish()` is cleanup when `exited` has settled, and a stop when it has not: an exception
before then stops the run rather than leaving it unsupervised. A caller that must be able to stop
waiting without stopping the run keeps `claude` and `supervisor` in an owner that outlives the wait
(see [Ending a wait without stopping the run](#ending-a-wait-without-stopping-the-run)).

`superviseSignals(options)` takes `graceMs`, and optionally `signals` (default all three),
`onEvent` — told of each `SupervisorEvent`: `held`, `stopping` (with its `cause`, a signal or
`'finish'`), `escalating`, `after-exit` — and `source`, where signals come from (default this
process). `onEvent` is called synchronously just before each effect and is best-effort: an
exception it throws is ignored, so a failing reporter never keeps a run from being stopped or a
stop from escalating, and a call is not proof that the report reached anyone. What it does
asynchronously, such as a stream write that fails later, is its own to handle.
`superviseSignals` throws, before installing any handler, when `graceMs` is not a finite number from 0
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
and `signalCode` (a signal name or number, as Bun reports it), `processGroup`, `groupState` and
`groupObservations`. `groupState` is `empty`, `occupied` (something could still be signalled:
after SIGKILL and a two-second wait when `escalated`; otherwise the group had not read occupied
when SIGKILL was decided against), `not-permitted`, or `null` without a group. It is read by
`readProcessGroup`, and `groupObservations` keeps every reading it was decided from.

It signals only the process Bun spawned, through Bun's handle, and only a group whose id is that
process's PID; any other `processGroup` is refused, as are ids 0 and 1 and the caller's own PID.
`processGroupState(pgid)` reads a group once with signal 0: `occupied` when that succeeds, `empty`
on ESRCH, `not-permitted` on EPERM. EPERM means this process may signal none of the members the
kernel found. It does not show that any of them is still running, whose it is, or that it will go,
so it is never read as `empty`. On macOS a stopped run's group has been seen to answer EPERM
briefly after its processes exited, and ESRCH soon after. `readProcessGroup(pgid)` therefore reads
a `not-permitted` group again every 50 ms for up to `notPermittedRecheckMs` (1 s), and resolves
with `{ state, observations }`: the last state, and every reading with its time. A
`not-permitted` that lasts the whole second is reported as it is. A stop ends processes; it does
not undo what they wrote or sent.

### runInCustody(launchOptions, options)

From `@agladysh/bare-claude/custody`: the library behind `--custody`. Spawns as `spawnClaude`
does, detached on macOS and Linux, under `superviseSignals`, and keeps the run as
[Run custody](#run-custody) describes. `options`, a `CustodyOptions`:

- `directory` and `keepCallToAction`, a `CustodyDeclaration`, what a preset's `custody` holds;
- `graceMs`, and optionally `signals` and `source`, passed to `superviseSignals`;
- `env`, the spawn's environment layer (`spawnOptions.env`), never recorded;
- `signal`, an `AbortSignal` that stops the run with SIGTERM, recorded as `cancelled`;
- `onEvent`, called with each `CustodyEvent` synchronously, best-effort as `superviseSignals`'
  reporter is: an exception it throws is ignored, and a call hands an event to the caller's code,
  which is not evidence anyone received it;
- `identify`, a synchronous reader of the spawned PID's identity by the caller's own means, called
  once as soon as the spawn returns and before custody awaits anything. Its `ProcessIdentity` —
  `method`, `start`, `boot` — is recorded in `start.json` as given, three fields only, or the
  error it threw. Custody reads no process table itself, and whether the PID still named the
  spawned process when it was read is the reader's to establish;
- `configuration`, a `CustodyConfiguration`: the files that declared the run and the presets
  selected, as `readConfig` or `readConfigFiles` from `@agladysh/bare-claude/config` give their
  provenance. It is recorded field by field in `invocation.json` as stated, with
  `configurationScope`; custody reads none of it.

```typescript
import { runInCustody } from '@agladysh/bare-claude/custody';

const completion = await runInCustody(
  { callToAction: 'Explain this project to me', extraArgs: [ '--output-format', 'json' ] },
  { directory: '/work/runs/0042', graceMs: 10_000, onEvent: event => console.error(event.kind) },
);
```

Throws, writing nothing, when the launch options or call to action are refused, the cwd does not
exist, `graceMs` or `signals` are invalid, the signal is already aborted, or the directory exists
or has no parent. Once the directory is made it resolves with a `CustodyCompletion`: a failure to
spawn is `outcome: 'not-started'`; when custody cannot write `start.json` it stops the run
(`stop.cause: 'custody-error'`), since a run nobody could later find is not one it keeps. When
`completion.json` itself cannot be written, the resolved completion's `custodyError` says so.
Then, on every route that writes a completion, it reads the directory with `readCustody`, writes
the reading as `observation.json` and calls `onEvent` with `observed`. Whatever fails there is
that event's `error`, and changes neither the completion nor what `runInCustody` resolves with.

The records are `CustodyInvocation`, `CustodyStart` and `CustodyCompletion`, each with `format` and
`version` (`custodyVersion`, still 1: `configuration`, `directory` and `seededJournal` were added,
and nothing else changed meaning);
a completion's `scope` is `completionScope`. Within them: `CustodySession`, `CustodyOutput`,
`CustodyJournal`, `CustodyOutcome`, `CustodyStopCause`, `ProcessIdentity`, `CustodyIdentity` and
`RecordedConfiguration`; `processGroupAfter` is a `ProcessGroupReading` from
`@agladysh/bare-claude/lifecycle`. `custodyFiles` names every file. The observation is a
`CustodyReading` (see [Reading a custody directory](#reading-a-custody-directory)).

### Pure launch configuration

`spawnClaude` is assembly plus side effects. The assembly is exported separately, so the whole
flag matrix can be inspected and tested without spawning anything:

- `LaunchConfig(options)`: resolves `LaunchOptions` to a fully defaulted `LaunchConfig`.
- `buildArgv(config, sessionId)`: the full command vector, `argv[0]` included.
- `buildSettings(config)`: the `settings.json` document.
- `buildEnv(config, { ephemeralClaudeHomePath, processEnv?, spawnEnv? })`: the child environment.

All three are pure — no filesystem, no clock, no subprocess.

#### Precedence

`cwd` is `launchOptions.cwd ?? spawnOptions.cwd ?? process.cwd()`, made absolute and physical, and
the winner also determines the session transcript path, so the two can never disagree. A relative
one is resolved against the calling process's cwd first. Observed in a native run on macOS: given
`/tmp/x`, an alias of `/private/tmp/x`, Claude Code wrote its journal under the project key of
`/private/tmp/x`, so a path keyed on the alias would name a journal that never exists. The CLI
resolves `--read` and `preload` against the same physical directory.

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
[Choosing the configuration](#choosing-the-configuration). `loadConfigFiles(paths)` reads several
named files, each of which must exist, validates each, and composes them in order with
`composeConfigs`. One file named twice is refused, by whatever names. `authMode` is the schema for
the `auth` field, as `effortLevel` is for its own.

`readConfig(source, cwd?)` and `readConfigFiles(paths)` do the same and also return where the
configuration came from: a `ConfigReading`, `{ config, provenance }`. A `ConfigProvenance` is the
route (`source`) and every file read (`files`, each a `ConfigFileRecord`: `path`, `realPath`,
`bytes` and `sha256`). Each file is read once, and its digest is of exactly the bytes parsed. The
CLI reads through these two and passes the provenance to custody.

`@agladysh/bare-claude/preset` exports `resolvePreset(preset, presets)`, which folds a
`DynamicPreset`'s `use` chain and applies the CLI display defaults to produce a runnable `Preset`
— the function behind the [preset resolution order](#preset-resolution-order) above.
`mergeInvocation(config, overrides, use?)` merges a whole invocation the way the CLI does — the
configuration's root preset, the command line's fields over it, `--use` replacing the root's
`use` — into a `MergedPreset` that need not be runnable; `resolveInvocation` does the same and
then requires a `callToAction`. The CLI runs through the second and `--doctor` through the first,
so both read an invocation identically. A `Preset` also carries the CLI-only `stopGraceMs` and
`custody`. `composeConfigs(layers)` composes `Config`s, each a `ConfigLayer` `{ source, config }`
named by `source` in its refusals, as [Composing several files](#composing-several-files)
describes.

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
