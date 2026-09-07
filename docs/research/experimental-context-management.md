# Experimental context management protocol

**Status:** P1 protocol (capability + receipt schema). No adapter or HTTP
admission in this slice.

**Source:** [Daemon: Codex-style experimental context management](https://app.notion.com/p/3d40d7cd1da381649085c30275793828)
(Hayes RE 2026-09-07 · Codex 0.153 `features.context_management.experimental_mode`).

**Mechanism shape only.** Not a product copy of OpenAI internals. External
refs: [rust-v0.153.0](https://github.com/openai/codex/releases/tag/rust-v0.153.0),
[PR #42385](https://github.com/openai/codex/pull/42385),
[issue #27488](https://github.com/openai/codex/issues/27488).

Schemas live in `packages/pi-tidy-bots/src/gateway/schema/`:
`capabilities.schema.json`, `event.schema.json`, `receipt.schema.json`.

## 1. Capability: `configuration.new_context`

Existing configuration flags are required booleans: `model`, `thinking`,
`compact`. `new_context` is **optional**. Absent or `false` means the backend
does not advertise a no-summary reset. `true` means it will (P2) accept
`session.new_context`.

The name follows the compact trio: one token for capability, reserved method,
and journal kind.

| Surface         | Compact (existing)                      | new_context (this spec)                     |
| --------------- | --------------------------------------- | ------------------------------------------- |
| Capability      | `configuration.compact` (required bool) | `configuration.new_context` (optional bool) |
| Plugin method   | `session.compact`                       | `session.new_context` (reserved; not wired) |
| HTTP action     | `POST /api/bots/:name/compact`          | reserved; not wired                         |
| Journal kind    | `compact`                               | `new_context`                               |
| Checkpoint      | summarize-and-continue                  | no-summary wipe of the working window       |
| Typical trigger | operator / client                       | model or client (self-directed)             |

Do not overload `configuration.compact` or kind `compact` for a no-summary
reset. Do not copy Codex eligibility gates (ChatGPT Plus/Pro, Codex backend
only); negotiate with this flag.

Do not confuse with Codex tier 1 (`tui.auto_recap` / `/recap`) or Hermes
`sessions.continuity` / `continuity_unverified` (recovery cell; out of scope).

## 2. Receipt kind `new_context` vs `compact`

Both are control operations: no user transcript entry, same durable
reservation rules as `model` / `thinking` / `compact`. Settlement still
requires an explicit `result.status` in
`applied | expired | cancelled | failed`.

### No-summary checkpoint

A settled `new_context` receipt with `result.status = "applied"` MUST include
`result.checkpoint = "no-summary"`. It MUST NOT claim a summary, first-kept
entry, or native compaction witness. Those belong on `compact` (see Pi
`native_compaction_history_verified`).

Optional `result.contextGeneration` is a monotonic integer starting at 1,
incremented by each applied reset on that conversation.

Optional `result.continuityNotes` are gateway-owned annotations
(`id`, `kind` in `decision | constraint | handoff | other`, `text`). They
are not OpenAI history notes and MUST NOT be parsed as such.

### Journal `bootId` / scope

| Identity                         | `new_context`             | Gateway restart | `session_open`                         |
| -------------------------------- | ------------------------- | --------------- | -------------------------------------- |
| Hello `bootId`                   | unchanged                 | new             | unchanged unless the process restarted |
| `conversationId`                 | unchanged                 | unchanged       | new or loaded                          |
| `bindingId` / `bindingRevision`  | unchanged                 | unchanged       | may change on reopen                   |
| Conversation `contextGeneration` | increment on applied      | unchanged       | unchanged                              |
| Journal key                      | `{botId, conversationId}` | same            | new or loaded conversation             |

Scope of inspectability stays the conversation key. Prior `operationId`s
remain valid. A reset is not a new session and not a continuity-recovery
handshake.

### Survives vs wiped

**MUST survive** (Guardian fence):

- Conversation binding and policy revision
- Permissions ledger and permission receipts
- Questions ledger and question receipts
- All operation receipts (including prior `compact`, `new_context`,
  `session_open`, messages, cancels)
- Identity used for native dedupe / replay cursors

**MAY be wiped** (working window only):

- Model working window / native transcript projection
- Streaming chat projection for turns before the checkpoint
- In-flight text snapshots that have not become receipts

**Re-injected after reset:** initial context only (system prompt, AGENTS.md,
active files). Not a reconstructed summary of discarded turns.

Journal storage MUST NOT delete surviving rows when admitting or settling
`new_context`. Application (P2) MUST NOT invent a wipe of the fence to make
the native window look clean.

## 3. Optional `contextBudget`

Card name `context_budget`; wire name `contextBudget` (camelCase, same as
`leaseGeneration`).

MAY appear on `turn.started`, `usage.updated`, and `turn.terminal` payloads:

```json
{
  "remainingTokens": 12000,
  "usedTokens": 4000,
  "windowTokens": 16000,
  "source": "adapter"
}
```

`remainingTokens` and `source` (`adapter` | `gateway`) are required when the
object is present. `source: "adapter"` is native-reported;
`source: "gateway"` is a gateway estimate. Absence of `contextBudget` means
unknown — not zero, not "unlimited".

This is not `output.usage` and not client-only `auto_compact_token_limit`.
It is a remaining-capacity signal for the model turn.

## 4. Fence rule (Guardian lesson)

Approvals and receipts MUST survive `new_context`. A reset that drops the
permissions ledger, a prior deny, or a terminal operation receipt is a
protocol violation, even if the native window is empty.

Codex v0.153 Guardian fencing is the lesson: compaction / restart / fork
must not evict reviewer memory. Tidy's equivalent is the journal permission

- operation receipt ledger. Subagent isolation and rollback-boundary rules
  stay with their own cells.

## 5. Out of scope (this PR)

- Adapter mapping (Pi native compact vs hard reopen; Hermes tool identity)
- Live smokes; production daemon `:4317` writes
- HTTP / `session.new_context` admission (P2)
- Hermes `continuity_unverified` 503 / `session_open:native_startup_history`
- Cloning OpenAI history-note schema
- Client UI, SwiftPM, App Store claims
