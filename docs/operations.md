# Operations — pi-tidy-bots

## Layout probe (issue 52)

See the section below under Operations extras; the probe is the enforced check for chrome layout regressions.

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

## Layout probe (issue 52)

One command verifies the console against adversarial content at phone,
tablet, and desktop widths:

```bash
npm run probe:layout                # current tree: exits 0 when nothing squeezes
PROBE_BASELINE=1 npm run probe:layout   # serves d20af89-reverted styles; exit 1 proves the probe reproduces the squeeze
```

The probe boots a real daemon (port 0, stub children, seeded adversarial
journal: long labels, long paths, code, wide tables), serves the console
through a local reverse proxy with an injected measurement script, and drives
headless Chrome per viewport. It fails when any text-bearing element is
narrower than 40px while holding more than 20 characters. Requires Chrome
(set `PROBE_CHROME` if not autodetected); `PROBE_KEEP=1` preserves the temp
fleet for autopsy.

## Flutter web mount (issue 60)

The daemon serves the Flutter web build at `/app/` (token-gated like the
console). Sync a build with `node scripts/sync-flutter-web.mjs <build/web>`
and commit `packages/pi-tidy-bots/public/app/`. Entry documents revalidate;
hashed assets are immutable. Phase 2 default flip is parity-gated.
