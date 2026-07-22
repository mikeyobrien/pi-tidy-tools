# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-22

### Added

- Backend-neutral `recall`, `retain`, and `reflect` tools with a native
  Hindsight REST adapter.
- Optional automatic recall and settled-turn retention lifecycle hooks, both
  disabled by default.
- Strict versioned configuration, static and dynamic bank routing, provenance
  metadata, bounded output, cancellation, and runtime cleanup.
- `/tidy-memory status` and authenticated read-only `/tidy-memory check`
  diagnostics.
- Embedded immutable source-revision reporting for packed artifacts, plus an
  offline installed-package smoke test.
- Package architecture, backend, and operations guides covering compatibility,
  controlled installation, receipts, two-phase activation, upgrades, and
  rollback.

### Changed

- Use synchronous Hindsight retention by default so successful retains mean the
  backend completed the request; deferred execution remains an explicit opt-in.
- Preserve backend-ranked recall order, include bounded provenance in tool and
  automatic-recall output, and label recalled content as untrusted historical
  data.
- Derive automatic-retain document identity from Pi's persisted assistant entry
  and original user-message time for stable replay behavior.
- Align memory tools with the pi-tidy reason-first contract: required single-line,
  12-word/64-character display-only rationale, left-edge two-line why/result cards, a live-only state
  dot, no decorative rail, no duplicate settled check/cross glyphs,
  outcome-preserving narrow-width truncation, and correct memory-count grammar in
  cards and diagnostics.
- Make public documentation deployment-neutral and npm-first while preserving
  exact-version source and local-artifact procedures.

### Security

- Reject inline credentials and custom authorization headers; resolve named
  environment variables without logging values.
- Apply a shared secret-pattern guard to manual and automatic writes.
- Strip tool traffic from automatic retention, fail closed on malformed settled
  entries, and skip assistant outcomes marked errored or aborted.
- Escape recalled/reflected text as inert historical data and sanitize terminal
  control sequences before rendering.
- Redact common credential-shaped values from model-facing recall/reflection and
  from collapsed, expanded, error, and background-painted terminal cards.
- Harden npm publication with commit-pinned GitHub Actions, disabled dependency
  caching, tokenless OIDC, provenance, and a regression-tested workflow policy.

[Unreleased]: https://github.com/mikeyobrien/pi-tidy-tools/compare/pi-tidy-memory-v1.0.0...HEAD
[1.0.0]: https://github.com/mikeyobrien/pi-tidy-tools/tree/pi-tidy-memory-v1.0.0
