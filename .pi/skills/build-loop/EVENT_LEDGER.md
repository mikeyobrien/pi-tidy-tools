# Build Event Ledger

`ledger-types.d.ts` is the closed build event algebra. `scripts/build-ledger.mjs` is the build adapter that validates events, reduces history, and renders reports. `../shared/run-ledger.mjs` owns generic JSONL parsing, contiguous sequencing, atomic canonical writes, and command dispatch.

## Ownership

- The parent owns `.pi/build-runs/<run-id>/events.jsonl`, issue-tracker mutations, mechanical verification, commits, ticket closure, and run closure.
- Builders, repairers, and acceptance verifiers write only role-specific fragments under `.pi/build-runs/<run-id>/fragments/` and evidence under `artifacts/`.
- Fragment events contain `v`, `type`, and `actor`, and omit `seq`.
- The canonical writer validates the complete proposed history, assigns contiguous `seq` values, and atomically replaces the ledger only after the reducer accepts it. Its owner-recorded lock recovers dead or stale abandoned owners but never expires a live owner.
- `events.jsonl` is authoritative. `report.md` is generated state.
- Evidence file and capture paths are relative to the run directory and may not escape it.

## Commands

```bash
ledger=.pi/skills/build-loop/scripts/build-ledger.mjs
run=.pi/build-runs/<run-id>

$ledger init "$run" "$run/fragments/run-started.jsonl"
$ledger append "$run" "$run/fragments/ticket-started.jsonl"
$ledger append "$run" "$run/fragments/attempt-001-builder.jsonl"
$ledger validate "$run"
$ledger report "$run"
```

Use the companion audit before agents edit and before every parent mechanical verification. After human acceptance, use the focused commit adapter with the exact accepted mechanical ticket file set:

```bash
.pi/skills/build-loop/scripts/worktree-audit.mjs snapshot <run-dir>/artifacts/worktree-baseline.json <user-owned-path ...>
.pi/skills/build-loop/scripts/worktree-audit.mjs compare <run-dir>/artifacts/worktree-baseline.json
.pi/skills/build-loop/scripts/focused-plan.mjs <run-dir>/artifacts/accepted-focused-plan.json <exact-ticket-file ...>
.pi/skills/build-loop/scripts/focused-commit.mjs <message-file> --accepted-plan <run-dir>/artifacts/accepted-focused-plan.json --audit-baseline <run-dir>/artifacts/worktree-baseline.json <exact-ticket-file ...>
# After accepted commit only:
.pi/skills/build-loop/scripts/worktree-audit.mjs compare <run-dir>/artifacts/worktree-baseline.json <exact-ticket-file ...>
```

Run these after changing shared mechanics, either event algebra, or either reducer:

```bash
node --test .pi/skills/build-loop/scripts/*.test.mjs
node --test .pi/skills/qa-loop/scripts/qa-ledger.test.mjs
```

## Stable identity

- Run IDs are filename-safe slugs.
- One run owns exactly one active ticket and its immutable parent specification.
- Acceptance criteria receive stable IDs such as `AC-001` in source order.
- Test seams have stable IDs and every criterion belongs to at least one seam.
- Attempts are contiguous positive integers.
- Build failures are allocated monotonically as `BF-001`, `BF-002`, and so on. Rediscovery reuses the existing ID.
- Every builder, repairer, and acceptance verifier invocation has a fresh agent ID.

## Event order

A run begins with parent-owned setup:

1. `run.started` records the confirmed charter, tracker references, acceptance criteria, seams, required checks, mutable scope, safety contract, starting worktree, and user-owned paths.
2. `ticket.started` proves the ticket is open, unambiguous, and on the dependency frontier with every declared blocker closed.

Each attempt then follows:

1. Parent appends `attempt.started` with kind `initial`, `repair`, `revision`, or `retest`.
2. The assigned role emits exactly one `implementation.applied`. A retest is parent-authored, unchanged, and modifies no product files.
3. A repairer also emits exactly one `repair.applied` for each authorized failure.
4. Parent appends one aggregate `mechanical.verification.recorded` containing every charter check exactly once, scope audit, exact current ticket-owned file set, worktree state, and direct evidence.
5. Only after all checks pass and scope is clean, parent appends `acceptance.started` for a fresh verifier.
6. The verifier emits exactly one `criterion.checked` for every charter criterion at an agreed seam.
7. Before acceptance closes, parent or verifier emits `failure.raised` for every non-pass mechanical or acceptance observation. Parent-authored mechanical failures use verifier identity `parent`; acceptance failures carry the active fresh verifier ID. In-scope repairable failures are distinct from decisions, scope expansion, and external blockers.
8. Before acceptance closes, parent or the fresh verifier emits one `failure.verification.recorded` for every authorized repair or resumed blocker after the matching mechanical check, scope audit, criterion, or complete agent-blocker acceptance passes. The event carries the exact parent or active verifier identity. If a repair fails the mechanical gate, acceptance does not start and no verification is fabricated for prior criterion failures.
9. The verifier emits `acceptance.closed` only after every criterion, non-pass failure, and required failure verification is accounted for. This event is terminal for verifier-authored criterion, failure, and verification events in the attempt.
10. Parent appends `attempt.closed`. The reducer derives `ready`, `failed`, or `blocked` and the exact open failure set.

A failed attempt may start a fresh automatic repair only when every unresolved product failure is classified `repairable`. Its authorized failure set must exactly match that open repairable set. A revision requires explicit human direction. A retest requires a human `retest` decision or a resumed external attempt blocker and reruns complete mechanical and acceptance evidence.

A blocked attempt is followed by `run.blocked` naming exactly its non-repairable decision, scope, or external blocker IDs. While blocked, only a human decision, matching `run.resumed`, or stopped closure is valid. A resume moves only those blocker IDs to resolved-awaiting-verification; the fresh next attempt must independently verify each before readiness. Repairable product failures still require a repair attempt. Prior evidence is preserved.

## Human gate and delivery

A human decision follows a closed attempt:

- `accept` is valid only for the latest ready attempt.
- `retest` is valid only for a ready attempt and starts a fresh unchanged attempt.
- `revise` carries non-empty direction and starts a fresh builder attempt.
- `stop` preserves current work, leaves the ticket open, and must be followed immediately by stopped run closure; it cannot resume.

The only successful delivery order is:

1. `human.decided` with `accept`
2. `commit.recorded` with the full 40- or 64-character hexadecimal commit ID and a file set exactly matching the latest accepted mechanical ticket delta
3. `tracker.recorded` carrying the immutable charter ticket and parent identities, showing the active ticket closed and parent open and unmodified
4. `ticket.closed`
5. `run.closed` with reason `ticket-closed`

A failed or blocked commit or tracker operation is followed by `run.blocked`. Resumption retries that closure stage without erasing accepted implementation evidence. The parent specification is never modified or closed.

## Reducer invariants

- Sequence numbers are contiguous from one; no event follows `run.closed`.
- `run.started` and `ticket.started` are unique and first.
- Attempts cannot overlap or skip numbers.
- Agent and verifier IDs cannot be reused.
- Builders and repairers cannot author mechanical or canonical verification.
- Acceptance cannot start before every required mechanical check passes and scope is clean.
- Acceptance uses a fresh read-only verifier and accounts for every criterion exactly once.
- The canonical acceptance order is criteria, matching failure records, required independent verification records, then terminal `acceptance.closed`.
- A pass cannot substitute for missing evidence.
- Every failed or blocked criterion, failed or blocked check, and non-clean scope audit has its own matching stable failure source.
- A repair addresses exactly the failures authorized for that attempt. Every repair that reaches acceptance receives independent verification; a mechanical-gate failure remains open without fabricated acceptance evidence.
- Every resumed blocker receives matching independent verification in the fresh next attempt before readiness.
- `ready` requires all checks passed, all criteria passed, no blocked coverage, and every historical failure fixed.
- Commit and tracker operations require human acceptance.
- Ticket closure requires successful commit and tracker evidence.
- Stopped closure requires human stop, leaves the ticket open, and never emits `ticket.closed`.

## Evidence

Every event that claims observed behavior contains at least one evidence reference:

```json
{"kind":"command","ref":"npm test exited 0"}
```

Allowed kinds are `capture`, `command`, `file`, and `note`. Use command evidence for parent mechanical checks, file/capture evidence for durable artifacts, and notes only for directly observed facts that have no stronger artifact. Hash durable evidence when useful.

Builder test output is implementation evidence, not canonical mechanical or acceptance verification. Verifier prose is not enough when the criterion requires executable or user-visible behavior.
