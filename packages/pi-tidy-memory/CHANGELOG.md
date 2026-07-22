# Changelog

## Unreleased

- Make distributable documentation deployment-neutral instead of hard-coding an operator bank.
- Document supported Node, Pi, and Hindsight versions plus explicit local-path installations.
- Add the two-phase activation sequence, external installation-receipt schema, rollback evidence, and troubleshooting guidance.
- Clarify that one static bank may intentionally preserve continuity for one user across agents and subjects, while different users and trust boundaries require separate banks.

## 0.1.0 - 2026-07-22

- Add a backend-neutral memory contract and registry.
- Add the first backend adapter for authenticated Hindsight 0.8.x servers.
- Add compact `recall`, `retain`, and `reflect` tools.
- Add optional automatic recall and retain lifecycle hooks, disabled by default.
- Add `/tidy-memory status` and `/tidy-memory check` diagnostics.
- Add Hindsight-compatible dynamic bank IDs with project, agent, session, channel, and user granularity, stable Git worktree resolution, prefixes, and directory overrides.
- Skip automatic retention for errored or aborted assistant outcomes and block obvious credentials at the shared runtime boundary.
- Reject malformed booleans and unknown built-in configuration keys.
- Verify authenticated bank access with a zero-item read instead of relying on the global health endpoint.
- Default Hindsight retains to synchronous completion for the supported single-user profile; no outbox, receipt polling, restart replay, or retry subsystem is added.
- Report sanitized package and embedded source revision metadata in `/tidy-memory status` without executing Git for revision reporting.
- Ship an `npm run smoke` check that loads the packed compiled extension and verifies its embedded full source revision while retaining the native Pi adapter entry.
- Document externally receipted immutable commit pins plus upgrade, credential-rotation restart, and rollback procedures for a selected static bank.
- Add configurable user, agent, canonical-repository, and source provenance to new writes, with mode, session, and meaningful timestamps.
- Preserve bounded context, occurrence time, tags, and metadata in model-visible recall while keeping the entire JSONL block explicitly untrusted.
- Derive automatic retain document IDs from persisted Pi message identities so retries remain idempotent when serialized text changes.
