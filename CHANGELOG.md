# Changelog

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
