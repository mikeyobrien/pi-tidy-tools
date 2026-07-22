# Changelog

## 0.1.0

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
- Document externally receipted immutable commit pins plus upgrade, credential-rotation restart, and rollback procedures for the static `mobrienv` bank.
