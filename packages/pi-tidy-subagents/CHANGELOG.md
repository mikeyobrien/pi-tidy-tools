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

### Changed

- Compact rendering continues to show each child's model identity and thinking level, now using the observed runtime after startup without routine adjustment noise.
- Internal prefactor retained: every child owns an independent runtime plan used for launch.

## [0.1.0] - 2026-07-11

### Added

- Synchronous, ordered Pi RPC child-agent fan-out with inherited runtime settings and session-wide resource-aware concurrency.
- All-settled execution that preserves healthy sibling results and supports cancellation of active and queued children.
- Compact adaptive rendering with live child activity, progressive disclosure, directional provider usage, and elapsed duration.
- Bounded ordered parent results plus persistent versioned manifests, responses, normalized events, and exact provider usage for every child.

[Unreleased]: https://github.com/mikeyobrien/pi-tidy-tools/compare/pi-tidy-subagents-v0.1.0...HEAD
[0.1.0]: https://github.com/mikeyobrien/pi-tidy-tools/tree/pi-tidy-subagents-v0.1.0/packages/pi-tidy-subagents
