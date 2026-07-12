# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Settled tool headers now show a compact completion age that remains accurate after session reloads.
- Optional, explicit pi-fff orchestration for separately installed legacy `pi-fff` 0.1.12+ and scoped `@ff-labs/pi-fff` 0.6.0+ on Pi 0.80.6+, with profile-specific tool ownership, journaled setup/status/teardown, project-over-user selection, capability-gated forward compatibility, and fail-closed ownership.
- Installed-package baseline coverage for both package identities (including scoped tools, commands, flags, lifecycle, renderers, and autocomplete), packed-artifact assertions, a dual-line baseline/newest release matrix, and a real-Pi TUI smoke gate.

### Changed

- Pi coding-agent and TUI peer ranges now have no upper bound; structurally compatible newer tuples are reported as forward-compatible/unverified until release smoke passes.

### Security

- pi-fff settings transitions preserve exact prior entries in linked sidecars and recover interrupted writes without touching unrelated settings. Teardown is required before package removal; drift requires manual restoration from every recorded `priorEntry` before deleting sidecars and reloading.

### Known limitations

- pi-fff 0.1.12 autocomplete is last-writer-wins with other custom editors, and disabling it live requires `/reload` to restore the prior/default editor.

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

[Unreleased]: https://github.com/mikeyobrien/pi-tidy-tools/compare/pi-tidy-tools-v0.2.0...HEAD
[0.2.0]: https://github.com/mikeyobrien/pi-tidy-tools/compare/v0.1.2...pi-tidy-tools-v0.2.0
[0.1.2]: https://github.com/mikeyobrien/pi-tidy-tools/compare/v0.1.1...v0.1.2
