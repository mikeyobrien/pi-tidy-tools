# tidy.codex capability gaps

Honest descriptor until a named cell is proven. Chat Completions is not a
control plane. This adapter speaks Codex app-server JSON-RPC (`initialize`,
`thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`).

| Surface | Advertised | Status |
|---|---|---|
| Text open/submit/stream/close | yes | Fixture conformance |
| Cancel | cooperative `turn/interrupt` | Fixture only |
| Session load | `sessions.load=true` | Fail-closed on miss; never `thread/start` on load |
| Continuity | `verified` | Means the advertised **identity-only** proof succeeded. Not Pi/Hermes retained-history verification. |
| Proof | `identity-only` | Expected isolated `CODEX_HOME` plus the exact returned thread id. No history digest, message-count, or checkpoint comparison. |
| Empty seat | `non-restorable` | Never-prompted / unprompted threads may lack a resumable rollout. They stay fail-closed; restart-availability is not claimed. |
| Steer | false | Native `turn/steer` exists; unmapped |
| Questions | false | No generic question cards |
| Compact | false | Native `thread/compact` exists; unmapped |
| Permissions | none | Approval requests fail closed; never auto-approve |
| Fleet tools | false | Dual-backend Codex↔Pi fixture smoke is text-only |
| Auth | native profile | `CODEX_HOME` / `auth.json` or named env keys. No secrets in manifest |

Mikey invariant: fleet seats are perpetual. Identity/fail-closed is the
consistent rule for every new seat — not restart-availability. Restart must
`thread/resume` the same native thread or fail closed. Empty never-prompted
threads have no rollout and stay explicitly `non-restorable` (no silent
`thread/start`).
