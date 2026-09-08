# tidy.codex capability gaps

Honest descriptor until a named cell is proven. Chat Completions is not a
control plane. This adapter speaks Codex app-server JSON-RPC (`initialize`,
`thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`).

| Surface | Advertised | Status |
|---|---|---|
| Text open/submit/stream/close | yes | Fixture conformance |
| Cancel | cooperative `turn/interrupt` | Fixture only |
| Session load | `sessions.load=true` | Fail-closed on miss; never `thread/start` on load |
| Continuity | `verified` | Protocol requires this when load is advertised. Fixture reload proved same thread id. Native Codex `thread/resume` across a real app-server restart PASSed (`test/codex-native-smoke.test.ts`, log `/tmp/tidy-codex-197-native-smoke.log`). |
| Steer | false | Native `turn/steer` exists; unmapped |
| Questions | false | No generic question cards |
| Compact | false | Native `thread/compact` exists; unmapped |
| Permissions | none | Approval requests fail closed; never auto-approve |
| Fleet tools | false | Dual-backend Codex↔Pi fixture smoke is text-only |
| Auth | native profile | `CODEX_HOME` / `auth.json` or named env keys. No secrets in manifest |

Mikey invariant: fleet seats are perpetual. Restart must `thread/resume` the
same native thread or fail closed. Empty never-prompted threads have no
rollout and stay fail-closed (no silent `thread/start`).
