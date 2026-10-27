# Text stdin prompt transport

`spawnClaudeWithStdinPrompt` is an additive SDK route for the native Claude
launcher. It sends the exact call-to-action UTF-8 bytes as a Blob on stdin and
supplies EOF. The prompt is absent from argv; `--input-format text --print`
selects the CLI's text-input print mode. Installed CLI help advertises that mode.
No live native prompt, model request or account behavior was tested.

The existing `spawnClaude` route remains intact. Automatically taking over stdin
there would change callers that supply their own input and would assume alternate
launchers forward it. The new function therefore owns stdin explicitly, refuses
competing stdin/stdio/terminal and input-format options, and shares the existing
spawn, authentication, settings, session, output and cleanup implementation.
A leading hyphen in stdin is data rather than an argv option. Neither route
retries a failed spawn or truncates the prompt.

On Bun 1.3.13/macOS, the controlled child in `src/stdin-prompt.test.ts` received
2,400,021 bytes with an exact SHA-256 match, including Unicode, CRLF and NUL.
It read EOF, and its argv contained no prompt payload. A second controlled child
exited 7 before consuming input without a feed hang. The timeout case retained
stdout/stderr and caller-owned home data. These are actual SDK/process tests,
not mocks of the SDK or evidence of a native model response.

Typecheck and 105 affected SDK/CLI tests passed with 382 assertions. Other
argument strings still have their ordinary operating-system limits. Alternate
launchers and caller-managed input retain the existing argument route; this
increment does not qualify stdin forwarding by those launchers.
