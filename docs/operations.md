# Operations — pi-tidy-bots

## Scoping bots

Fleet membership is orchestration, not scope (ADR 0002). A bot is a normal Pi
session first — by default it runs from your home directory with your global
`~/.pi` config. Scoping DOWN is always explicit. The levers, ordered by blast
radius:

| Lever                    | Blast radius                                         | What it changes                                                                      | What it can't                               |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| **Steering**             | one message                                          | Redirects the current turn ("stop because X", "also do Y").                          | Nothing durable — the next turn forgets it. |
| **AGENTS.md**            | the bot's persona + duties (requires explicit `dir`) | Persistent instructions, etiquette, ownership.                                       | Can't grant or revoke filesystem scope.     |
| **`dir`** (bots.toml)    | the bot's whole world                                | Working directory: what files/projects the bot sees by default. Omitted ⇒ user home. | Can't change routing or persona by itself.  |
| **`routes`** (bots.toml) | the bot's peers                                      | Who it may hand work to (`route_forbidden` otherwise).                               | Can't touch filesystem scope or persona.    |
| **`model`** (bots.toml)  | cost/quality per turn                                | The provider model the session runs.                                                 | Can't change permissions or scope.          |

Rules of thumb: reach for steering first; write duties into `AGENTS.md` when
they should survive turns; use `dir` only when the bot genuinely needs a
project sandbox; `routes` for least-privilege delegation; `model` for cost.

## Your extensions, our tolerance (issue 46)

Users can load their own extensions into fleet bot sessions (global agent
extensions, `-e` modules). The runtime's contract is neutrality plus
tolerance: we don't judge what you add, and we don't break when it misbehaves.

The conformance suite (`test/extensions.test.ts`, fixtures in
`test/fixtures/extensions/`) pins the behaviors the daemon guarantees against
hostile children:

- **Loads that throw** — the child exits; the existing restart budget
  (3 restarts / 60s) brings it back. A child that keeps crashing exhausts the
  budget and is marked offline; siblings are unaffected.
- **Unknown event kinds** — ignored by the RPC layer, never parsed into
  runtime state.
- **Stdout floods** — the ingest buffer survives arbitrary byte volumes.
- **Garbage UI methods** — unknown `extension_ui_request` methods are defused
  (auto-cancelled) and never wedge a turn.
- **Hung children** — degrade to RPC timeouts (30s per request); the restart
  budget covers exits, hangs surface as timeouts. The operator's kill switch
  is `pi-tidy-bots stop` (cwd-keyed: sessions, transcripts, and pending
  queues live under the fleet dir, so stopping touches exactly that fleet's
  slice).

Conformance rule of thumb: if the pathology zoo in
`test/fixtures/extensions/` can take the daemon down, it's a daemon bug —
fix the daemon, not the fixture.
