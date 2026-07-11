# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional per-child exact `provider/model-id` model selection with parent-model inheritance when omitted.
- Optional per-child Pi thinking level (`off|minimal|low|medium|high|xhigh|max`) with parent-level inheritance when omitted.
- Atomic batch preflight against Pi's live model registry, configured authentication, and canonical thinking capability APIs before any child launches.
- Explicit unsupported thinking fails the complete batch with the requested model, level, and supported alternatives.
- Inherited thinking is canonically clamped (non-reasoning → `off`) with adjustment metadata rather than rejected.
- Child RPC `get_state` observation before prompting, with startup model mismatch failing that child without a prompt and observed thinking becoming the effective rendered/persisted truth.
- Schema version 2 run manifests retaining parent runtime plus per-child requested, resolved, and observed model/thinking provenance and thinking adjustment metadata.
- Direct dependency on `@earendil-works/pi-ai` for `getSupportedThinkingLevels` and `clampThinkingLevel`.
- Short thinking-primary schema defaults and prompt guidelines (exact IDs, omit inherits, reject aliases/profiles/fuzzy).
- Structured agent-dir routing map (`pi-tidy-subagents/routing.json`) with atomic load/save and thinking-primary task-class defaults.
- `/tidy-subagents-routing` slash command (`setup|defaults|status|clear`) to build the map from authenticated models without mutating parent session model/thinking.
- Observational non-blocking routing evaluation suite covering eight task shapes (`test/routing-eval.test.ts`, `docs/routing-eval.md`).
- Opt-in real-provider heterogeneous child smoke with observed model/thinking before prompt and actionable skip diagnostics.

### Fixed

- Child-only disablement no longer treats ambient `PI_TIDY_SUBAGENT_CHILD=1` alone as a silent full extension no-op. Registration skips only for true child RPC processes (`PI_TIDY_SUBAGENT_CHILD=1` and `--mode rpc`), emits a one-line startup diagnostic, and clears the ambient marker after an intentional skip so non-RPC descendants are not poisoned.

### Changed

- Compact rendering continues to show each child's model identity and thinking level, now using the observed runtime after startup without routine adjustment noise.
- Public docs cover inheritance, overrides, heterogeneous fan-out, clamp/error policy, startup observation, provenance, requested/resolved/observed, and routing setup.
- Document optional model/thinking as an idiomatic **override hierarchy** (most specific wins): explicit tool-call fields → user turn instructions → AGENTS.md / project agent instructions → optional `/tidy-subagents-routing` map → schema defaults / promptGuidelines → parent inheritance when omitted (no AGENTS.md auto-read or injection).
- Internal prefactor retained: every child owns an independent runtime plan used for launch.

## [0.1.0] - 2026-07-11

### Added

- Synchronous, ordered Pi RPC child-agent fan-out with inherited runtime settings and session-wide resource-aware concurrency.
- All-settled execution that preserves healthy sibling results and supports cancellation of active and queued children.
- Compact adaptive rendering with live child activity, progressive disclosure, directional provider usage, and elapsed duration.
- Bounded ordered parent results plus persistent versioned manifests, responses, normalized events, and exact provider usage for every child.

[Unreleased]: https://github.com/mikeyobrien/pi-tidy-tools/compare/pi-tidy-subagents-v0.1.0...HEAD
[0.1.0]: https://github.com/mikeyobrien/pi-tidy-tools/tree/pi-tidy-subagents-v0.1.0/packages/pi-tidy-subagents
