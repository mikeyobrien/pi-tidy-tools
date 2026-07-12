# QA Event Ledger

`ledger-types.d.ts` is the event algebra. `scripts/qa-ledger.mjs` is the sole canonical writer, validator, reducer, and report renderer.

## Ownership

- The parent owns `.pi/qa-runs/<run-id>/events.jsonl`.
- Subagents write role-specific files under `.pi/qa-runs/<run-id>/fragments/` and artifact files under `artifacts/`.
- Fragment events contain `v` and `type` and omit `seq`.
- The canonical writer validates the complete history, assigns contiguous `seq` values, and atomically replaces the ledger.
- `report.md` is generated state. `events.jsonl` is authoritative.

## Commands

```bash
ledger=.pi/skills/qa-loop/scripts/qa-ledger.mjs
run=.pi/qa-runs/<run-id>

$ledger init "$run" "$run/fragments/run-started.jsonl"
$ledger append "$run" "$run/fragments/round-001-start.jsonl"
$ledger append "$run" "$run/fragments/round-001-qa.jsonl"
$ledger validate "$run"
$ledger report "$run"
```

Run `node --test .pi/skills/qa-loop/scripts/qa-ledger.test.mjs` after changing the algebra or reducer.

## Event order

Each round follows this order:

1. Parent appends `round.started`.
2. QA agent emits zero or more `finding.raised` events followed by one `scenario.checked` event for every inventoried scenario.
3. If findings exist, the parent appends `human.selected` after the human gate.
4. For authorized repairs, the fixer emits one `fix.applied` per selected finding; the parent appends one `verification.recorded` per repair after auditing it.
5. Parent appends `round.closed`. Its outcome is derived from scenario statuses: `blocked` wins over `findings`, which wins over `no-findings`.
6. Parent either starts the next round or appends `run.closed`.

A human-signoff closure includes every non-fixed finding in `acceptedOpenFindingIds`. Every closure records structured final verification checks with command, status, exit code, and evidence. A no-findings closure requires a final unblocked `no-findings` round, every historical finding verified fixed, and every final verification check passed with exit code 0.

## Stable identity

- Run IDs are filename-safe slugs chosen during chartering.
- Finding IDs are monotonically allocated as `F001`, `F002`, and so on across the run.
- Scenario IDs are stable kebab-case descriptions of user behavior, reused across rounds.
- Requirement IDs are stable kebab-case charter acceptance identifiers.
- Rediscovering a prior finding references its existing finding ID from `scenario.checked`; it does not emit another `finding.raised`.

## Evidence

Every finding, scenario, and verification carries at least one evidence reference:

```json
{"kind":"capture","ref":"artifacts/reload-fixed.txt","sha256":"<optional lowercase SHA-256>"}
```

Allowed kinds are `capture`, `command`, `file`, and `note`. Paths are relative to the run directory. Copy canonical harness captures from `$PI_TIDY_QA_ROOT/artifacts/` into the run's `artifacts/` directory before appending their events. For visual claims, reference the native `.png` emitted by agent-tty's pinned `ghostty-web` renderer and pair it with the semantic `.txt` snapshot when useful. Do not use ANSI-to-HTML/CSS conversion as canonical evidence. `run.started.tooling` records `agent-tty` 0.5.0, its Node 24-26 runtime, and matched `/tmp/pi-tidy-qa-<run-id>/agent-tty` and `/tmp/pi-tidy-qa-<run-id>/sessions` paths; the validator still reads historical tmux ledgers for compatibility.

## Fragment examples

QA fragment:

```jsonl
{"v":1,"type":"finding.raised","round":1,"findingId":"F001","severity":"high","confidence":"high","summary":"Reload resets elapsed duration","actual":"Completed bash shows <1s after reload","expected":"Completed bash retains its measured duration","reproduction":["Start Pi through the canonical harness","Complete a bash call","Reload the session"],"evidence":[{"kind":"capture","ref":"artifacts/reload.txt"}],"recommendation":"Persist settled elapsed duration","acceptance":"Reload preserves the displayed settled duration"}
{"v":1,"type":"scenario.checked","round":1,"scenarioId":"reload-completed-bash","requirementIds":["duration-persistence"],"status":"finding","findingIds":["F001"],"evidence":[{"kind":"capture","ref":"artifacts/reload.txt"}],"notes":"Reproduced twice at 120x36 and 72x24"}
```

Fixer fragment:

```jsonl
{"v":1,"type":"fix.applied","round":1,"findingId":"F001","files":["packages/pi-tidy-tools/index.ts"],"tests":["restored settled tools retain elapsed duration"],"summary":"Persisted elapsed metadata in tool-result details","residualRisk":"Sessions created before this metadata existed remain approximate"}
```
