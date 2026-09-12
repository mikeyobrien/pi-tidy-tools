# Repro pack — compact abort leaves fleet undeliverable

P0 (Mikey via Hayes / Foreman). Distinct from issue 79 "Already compacted"
refusal loop: this is abort mid-summarization, then compacting / idle re-arm
that looks like silent death.

## Live match (prod `:4317`, READ-ONLY)

Captured 2026-09-12 from `/Users/rook/pi-tidy-fleet/.fleet` without mutating
the daemon (pid 46856, `pi-tidy-tools-deploy` @ `753eb11`). Dogfood `:4320`
was up (`pi-tidy-tools-dogfood` @ `2c45a90`) and unused for land.

Atlas: contextWindow 272000, inputTokens 130865, fill 0.481 — not overBudget.

### Chain

1. Idle scheduler (15s) sees fill ≥ 0.45 soft floor and `lastCompactAt` unset
   after a failed compact, so `maybeCompact({ idle: true })` fires again.
2. Child emits `compaction_start` `reason=manual` (daemon-issued compact).
3. Compact RPC `success:false`
   `error="Turn prefix summarization failed: This operation was aborted"`.
4. `compaction_end` `aborted:false` `willRetry:false`
   `errorMessage="Compaction failed: Turn prefix summarization failed: This operation was aborted"`.
5. Daemon logs `[atlas] compact request failed [reason: delivery_failed]`
   and journals `success:false error=delivery_failed trigger=idle`.
6. System text says "retrying at the next settled boundary" but idle tick
   does not set `lastCompactAt`, so step 1 repeats forever.
7. Prompts / `message_agent` during that window fail:
   `Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.`
   → classified `delivery_failed` (not retryable). Bot looks dead.

### Journal (prod, redacted)

`compactions.jsonl` tail: consecutive atlas idle `delivery_failed` every ~15s
at tokensBefore=130865 fill=0.481. Last-200 also shows verifier idle
`delivery_failed` spam (same machine).

### Daemon log lines (prod `.fleet/logs/daemon.log`)

```
[atlas] {"type":"compaction_start","reason":"manual"}
[atlas] {"type":"response","command":"compact","success":false,"error":"Turn prefix summarization failed: This operation was aborted"}
[atlas] {"type":"compaction_end","reason":"manual","aborted":false,"willRetry":false,"errorMessage":"Compaction failed: Turn prefix summarization failed: This operation was aborted"}
[atlas] compact request failed [reason: delivery_failed]
```

Mason also hit `compaction_start reason=threshold` in the same window
(successful on mason; atlas stayed in the abort loop).

## Deterministic repro (this PR)

`packages/pi-tidy-bots/test/compaction-abort.test.ts` + fixture knobs:

- `PTB_STUB_COMPACT_ABORT=1` — live abort error + `compaction_start/end`
- `PTB_STUB_COMPACT_ABORT_STICKY=1` — leave `isCompacting` set until `abort`
- `PTB_STUB_COMPACT_ABORT_MS` — in-flight window so prompts race compact

HEAD (`753eb11`) classifies the abort as `delivery_failed`, retries idle /
threshold compact, and 503s prompts. After the fix: one
`summarization_aborted` journal+system entry, latch cleared, prompts 200,
no compact loop.

## `:4317` handling

Untouched. No restart, no compact POST, no token use beyond the already-
running process list. Dogfood `:4320` not redeployed; evidence is the unit /
integration tests above.
