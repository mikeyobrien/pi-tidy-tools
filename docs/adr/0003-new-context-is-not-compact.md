# ADR 0003: new_context is not compact

- **Status:** Proposed
- **Date:** 2026-09-07
- **Deciders:** forge (implementation), atlas (triage)
- **Source:** [Daemon: Codex-style experimental context management](https://app.notion.com/p/3d40d7cd1da381649085c30275793828)

## Context

The gateway already has operator/client-driven summarize-compact:
`configuration.compact` → HTTP `compact` → `session.compact` → journal kind
`compact`. Codex 0.153 experimental context management adds a different
mechanism: a model-invoked no-summary reset (`new_context`) plus an explicit
token-budget signal. Compact and reset must not share a capability or receipt
kind. Guardian-class fencing showed that approvals evaporate if reset wipes
the safety ledger.

## Decision

1. **Capability `configuration.new_context` is optional and distinct from
   `configuration.compact`.** Same token as the reserved method
   `session.new_context` and receipt kind `new_context` (compact already uses
   one token across capability / method / kind). Absent means unsupported.
2. **Receipt kind `new_context` is a no-summary checkpoint.** It does not
   mint `bootId`, `conversationId`, or `bindingId`. Successful application
   (P2) increments conversation `contextGeneration` only.
3. **Fence: approvals and receipts MUST survive `new_context`.** Bindings,
   the permissions ledger, questions ledger, and operation receipts stay
   inspectable. The model working window and transcript projection may reset.
   Initial context (system / AGENTS / active files) is what remains for the
   model.
4. **Optional `payload.contextBudget`** on `turn.started`, `usage.updated`,
   and `turn.terminal` carries remaining tokens (`source`: `adapter` or
   `gateway`). Absence means unknown.
5. **This slice is protocol only.** No adapter mapping, no HTTP admission, no
   live smoke, no production `:4317` writes. Hermes
   `continuity_unverified` / 503 is a different cell.

## Consequences

- Clients and adapters negotiate reset separately from summarize-compact.
- Journal rows for prior operations and permission decisions are durable
  across a reset; application code must not delete them.
- P2 admits `session.new_context` without inventing success from HTTP 200.
- History notes are tidy-owned `continuityNotes` on the receipt, not an
  OpenAI schema clone.
