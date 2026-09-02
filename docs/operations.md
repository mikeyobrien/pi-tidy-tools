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

## Manual context overrides (issue 43 item 7)

`/new` (console) and `POST /api/bots/:name/compact` are thin force-overrides
of the same auto-compaction machinery: they bypass the 60% threshold and
hysteresis but keep the boundary discipline (no mid-turn compaction; 409
`turn_in_flight` while streaming). The fleet-state preamble is injected on
every compaction, forced or automatic.

## Flutter web mount (issue 60)

The daemon serves the Flutter web build at `/app/` (token-gated like the
console). Sync a build with `node scripts/sync-flutter-web.mjs <build/web>`
and commit `packages/pi-tidy-bots/public/app/`. Entry documents revalidate;
hashed assets are immutable. Phase 2 default flip is parity-gated.

## Fleet refresh discipline (issue 119)

The daemon serves only the code it was started from. Post-merge restarts are the
skipped step that leaves a live fleet running stale behavior, so the landing
procedure below is mandatory and the drift guard is the safety net that makes
drift loud. Guard is **read-only: it never restarts anything.** Restarting
mid-turn yanks bots out of active work; restarts belong at the settle boundary
the landing procedure controls, executed by the operator via the sanctioned
`pi-tidy-bots restart --fleet <name>` (release never touches the live daemon).

### Landing procedure (atomic, every merge/release)

1. Merge the changeset; run the repo gate: `npm test` and `npm run check` — both must exit 0.
2. Run the drift guard: `node scripts/fleet-drift-check.mjs`.
3. **DRIFT** (exit 1) → the operator runs exactly one sanctioned restart:
   `pi-tidy-bots restart --fleet pi-tidy-fleet`.
4. **Verify**: `GET /api/version` reports `commit` equal to `git rev-parse main`
   (short form), the roster shows every bot online after children respawn, and
   the drift guard exits 0 on the next run. Only then is the landing complete.

The restart step is never skipped silently: if the operator is unavailable when
the merge lands, the drift guard keeps alerting hourly until it happens.

### Drift guard

`scripts/fleet-drift-check.mjs` compares the running daemon's reported commit
(`GET /api/version` → `commit`, truth from `revision.ts` at boot) against the
checkout's `main` tip. Options: `--fleet <name>` (default `pi-tidy-fleet`),
`--repo <path>` (default: this repo), `--port <n>` (default 4317), `--json`.

Exit codes: `0` synced · `1` DRIFT · `2` daemon down/unreachable · `3` daemon
reporting no commit (packed install — unanswerable) · `4` no main/HEAD tip.
Every run prints one `[fleet-drift]`-tagged row; `--json` emits machine-readable
single-line JSON for ingestion.

Schedule hourly (launchd agent, ~/Library/LaunchAgents/
com.mobrienv.pi-tidy-fleet-drift.plist; equivalent cron line):

```cron
0 * * * * /usr/bin/env node /Users/rook/pi-tidy-tools/scripts/fleet-drift-check.mjs --json >> /Users/rook/pi-tidy-fleet/.fleet/logs/drift-check.log 2>&1
```

`/api/version` carries `commit`/`commitFull` only when the daemon ran from a git
checkout; packed installs omit them and the guard reports `no-commit` rather
than guessing. Alerting: exit 1 from the scheduled job (mail, monitor, or the
operator's dashboard) is the signal; nothing is restarted automatically.
