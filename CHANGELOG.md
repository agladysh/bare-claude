# Changelog

## [v0.8.5] - 2026-05-05

### Added

- Сonfiguration file and presets
- `--print` flag to print Claude Code console output
- `--read` flag now supports Git pathspec patterns
- Documentation: mention the BYOLLM (Bring Your Own LLM) keyword
- Documentation: use `--print` with `--quiet` to get only the last message
- Documentation: documented some of the assumptions Bare Claude makes
- Documentation: corrected project name to "Bare Claude" (not "bare-claude")

### Fixed

- Assistant messages are no longer truncated in the transcript

## [v0.8.4] - 2026-05-05

### Added

- `--read` flag to pre-read files
- Rudimentary SessionBuilder to create synthetic Claude Code NDJSON session data
- Permission-mode event
- SessionEvent union type
- Documentation for global installation in README.md
- Documentation for displayClaudeEvent in README.md

### Changed

- Removed inconsistent Assistant prefix from tool call events
- Graduated src/{display,events}.ts from bin/bare-claude.ts

## [v0.8.3] - 2026-05-05

- Official first release
