# ADR 0002: Bots are uncoupled by default

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** fleet operator, atlas (triage), forge (implementation)

## Context

A fleet bot is a normal Pi session first. Today's manifest made `dir` implicit
(fleet-relative to the bot name) and required an in-dir `AGENTS.md`, silently
scoping every bot to a project directory it never asked for. Operators hit
this when a bot was asked to manage work across the whole user's machine —
the bot's world was artificially smaller than its job. Fleet membership
(orchestration: routing, routines, presence) kept being confused with the
bot's scope (what part of the world it may touch).

## Decision

- **Fleet membership is orchestration, not scope.**
- `bots.toml` `dir` omitted ⇒ the bot's working directory is the user home
  (`os.homedir()`), where the user's global `~/.pi` config lives. Global
  setup, global tools, global memory are all active.
- An explicit `dir` is the opt-in to scoping and keeps full validation
  (directory exists, `AGENTS.md` present as persona).
- The bridge extension provides orchestration only (routed messages, reload).
  It never sets or changes a child's working directory and injects no project
  assumptions.
- Scoping levers, by blast radius: steering (message-level) < `AGENTS.md`
  (persona/duties) < `dir` (world scope) < `routes` (who it can call) <
  `model` (cost/quality). Documented in `docs/operations.md`.

## Consequences

- **Breaking (0.1.x alpha):** manifests that relied on the implicit
  fleet-relative `dir` must add `dir = "bots/<name>"` explicitly. Our own dev
  fleet keeps explicit dirs — the opt-in working as designed; no migration
  shipped.
- Unscoped bots take persona from their `title`, the user's global config, and
  operator steering — there is no required per-bot persona file.
- Extensions must maintain the non-coupling contract; a bridge that implies
  scope violates this ADR.
