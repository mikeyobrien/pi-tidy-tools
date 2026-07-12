# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-12

### Added

- Optional, explicit orchestration for separately installed legacy `pi-fff` 0.1.12+ and scoped `@ff-labs/pi-fff` 0.6.0+, including confirmed setup/status/teardown, project-over-user selection, lifecycle and autocomplete preservation, compatibility validation, and fail-closed recovery. Legacy custom autocomplete remains last-writer-wins with other editors and requires `/reload` after disabling it.

### Changed

- Managed scoped `@ff-labs/pi-fff` now executes behind tidy-presented `grep` and `find`; native tidy `read` remains unchanged and raw `ffgrep`/`fffind` names are not model-facing.
- Pi coding-agent and TUI peer ranges no longer have an upper bound; structurally compatible newer tuples are reported as forward-compatible/unverified until release smoke passes.

### Security

- pi-fff settings transitions preserve exact prior entries in linked sidecars, recover interrupted writes without touching unrelated settings, and refuse teardown when managed state has drifted.

## [0.2.0] - 2026-07-11

### Changed

- Failed Bash summaries now keep the command visible and report elapsed duration.

### Fixed

- Expanded write and edit output now renders tabs at code-relative tab stops without discarding trailing whitespace.
- Elapsed tool durations now remain accurate after session reloads.
- Tool failures now display errors supplied through structured error fields instead of falling back to a generic message.

## [0.1.2] - 2026-07-11

### Changed

- Bash tool summaries now show completion status and elapsed time instead of output line counts.

### Fixed

- `/diff` now shows line-by-line changes for new files and whole-file overwrites.
- Elapsed time now advances while large tool arguments are still streaming.
- Reasoning headlines now appear before large paths, commands, or file contents finish streaming.

[Unreleased]: https://github.com/mikeyobrien/pi-tidy-tools/compare/pi-tidy-tools-v0.3.0...HEAD
[0.3.0]: https://github.com/mikeyobrien/pi-tidy-tools/compare/pi-tidy-tools-v0.2.0...pi-tidy-tools-v0.3.0
[0.2.0]: https://github.com/mikeyobrien/pi-tidy-tools/compare/v0.1.2...pi-tidy-tools-v0.2.0
[0.1.2]: https://github.com/mikeyobrien/pi-tidy-tools/compare/v0.1.1...v0.1.2
