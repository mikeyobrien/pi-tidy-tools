# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Session-scoped background execution with mixed foreground/background fan-out, one-way foreground handoff, shared scheduling, and ordered durable acknowledgements.
- A `subagent_control` tool for canonical or unambiguous-label status, inspection, native Pi RPC steering, child-scoped cancellation, delivery changes, and bounded repeatable collection.
- Active-only TUI widget, durable handoff/terminal transcript stamps, `/subagents` management overlay, and `ctrl+shift+b` shortcut.
- Automatic Pi follow-up completion delivery, manual completion inboxes, shutdown cancellation, and headless RPC/JSON lifecycle support.
- Schema version 3 ownership, delivery, collection, follow-up, and control-history artifact metadata with legacy terminal collection.
- Settled child headers now show a compact completion age that remains accurate after session reloads.

## [0.2.0] - 2026-07-12

### Added

- Optional per-child exact `provider/model-id` model selection with parent-model inheritance when omitted.
- Optional per-child Pi thinking level (`off|minimal|low|medium|high|xhigh|max`) with parent-level inheritance when omitted.
- Atomic batch preflight against Pi's live model registry, configured authentication, and canonical thinking capability APIs before any child launches.
- Explicit unsupported thinking fails the complete batch with the requested model, level, and supported alternatives.
- Inherited thinking is canonically clamped (non-reasoning → `off`) with adjustment metadata rather than rejected.
- Child RPC `get_state` observation before prompting, with startup model mismatch failing that child without a prompt and observed thinking becoming the effective rendered/persisted truth.
- Schema version 2 run manifests retaining parent runtime plus per-child requested, resolved, and observed model/thinking provenance and thinking adjustment metadata.
- Short thinking-primary schema defaults and prompt guidelines (exact IDs, omit inherits, reject aliases/profiles/fuzzy).
- Structured agent-dir routing map (`pi-tidy-subagents/routing.json`) with atomic load/save and thinking-primary task-class defaults.
- `/tidy-subagents-routing` slash command (`setup|defaults|status|clear`) to build the map from authenticated models without mutating parent session model/thinking.
- Observational non-blocking routing evaluation suite covering eight task shapes.
- Opt-in real-provider heterogeneous child smoke with observed model/thinking before prompt and actionable skip diagnostics.

### Fixed

- Child-only disablement no longer treats ambient `PI_TIDY_SUBAGENT_CHILD=1` alone as a silent full extension no-op. Registration skips only for true child RPC processes (`PI_TIDY_SUBAGENT_CHILD=1` and `--mode rpc`), emits a one-line startup diagnostic, and clears the ambient marker after an intentional skip so non-RPC descendants are not poisoned.

### Changed

- Compact rendering shows each child's effective/observed model identity and thinking level without routine adjustment noise.
- Multi-child fan-out inserts one unpainted blank line between sibling agents so parallel children scan like parallel tool cards; single-child output stays tight.
- Public docs cover inheritance, overrides, heterogeneous fan-out, clamp/error policy, startup observation, provenance, requested/resolved/observed, routing setup, and the override hierarchy (tool fields → user turn → AGENTS.md → routing map → schema defaults → inherit).

## [0.1.0] - 2026-07-11

### Added

- Synchronous, ordered Pi RPC child-agent fan-out with inherited runtime settings and session-wide resource-aware concurrency.
- All-settled execution that preserves healthy sibling results and supports cancellation of active and queued children.
- Compact adaptive rendering with live child activity, progressive disclosure, directional provider usage, and elapsed duration.
- Bounded ordered parent results plus persistent versioned manifests, responses, normalized events, and exact provider usage for every child.

[Unreleased]: https://github.com/mikeyobrien/pi-tidy-tools/compare/pi-tidy-subagents-v0.2.0...HEAD
[0.2.0]: https://github.com/mikeyobrien/pi-tidy-tools/compare/pi-tidy-subagents-v0.1.0...pi-tidy-subagents-v0.2.0
[0.1.0]: https://github.com/mikeyobrien/pi-tidy-tools/tree/pi-tidy-subagents-v0.1.0/packages/pi-tidy-subagents
