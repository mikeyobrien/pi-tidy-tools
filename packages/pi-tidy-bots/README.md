# @mobrienv/pi-tidy-bots

Fleet runtime for [Pi](https://github.com/earendil-works/pi-mono) operator bots. One command turns a directory into a fleet of named bots — each with its own **perpetual Pi session**, persona, and presence — fully driveable from a **grokbot-simple web UI** (or any HTTP client).

Part of the pi-tidy suite. Zero dependencies on sibling `pi-tidy-*` packages: bots are real Pi sessions, so installed suite packages (tools, subagents, memory, footer) light up inside them unshimmed. See [docs/north-star.md](../../docs/north-star.md).

## Install

```bash
pi install npm:@mobrienv/pi-tidy-bots
```

Requires Node.js 22.19+ and a Pi install on PATH (`pi`). For the hermetic demo fleet, `pi` just needs provider credentials you already use.

## Quick start

```bash
pi-tidy-bots init ~/demo-fleet     # scaffold Atlas (ops) + Forge (worker)
pi-tidy-bots start ~/demo-fleet    # fleet daemon + web console
```

Then open the printed URL. Message Atlas; when a reply offers a **Fix it** button, click it — Atlas routes the fix to Forge over the fleet bus, and Forge's reply lands back in Atlas's chat as a completion notification.

### Fleet manifest (`bots.toml`)

```toml
[fleet]
port = 4317

[[bot]]
name = "atlas"          # [a-z][a-z0-9-]*
title = "Infrastructure Operator"
avatar = "🛰️"
dir = "bots/atlas"      # bot cwd; AGENTS.md here is its persona
routes = ["forge"]      # optional handoff allowlist; omit for all
# model = "openai/gpt-5-mini"   # optional per-bot model pin

[[bot]]
name = "forge"
title = "Remediation Worker"
avatar = "🔨"
dir = "bots/forge"
```

Invalid rows fail startup with an error naming the bot and field (no partial fleets). Persona edits hot-apply: the runtime reloads the bot's context files in place — no restarts; the session history never forks.

## What the runtime owns

- **Session-ownership lock** — one daemon per fleet dir. A second `start` exits with a typed error naming the holder; a stale lock (dead owner) is taken over by heartbeat rules.
- **Perpetual sessions** — one `pi --mode rpc` child per bot. Restarts and crash recovery resume the same session; a reset is a compaction, never a fork.
- **`message_agent` bus** — fleet handoffs with attribution, fire-and-forget delivery, completion notifications, and typed failure codes (`unknown_target`, `route_forbidden`, `runtime_offline`). Multi-turn dialogue is a chain of these one-way messages. Delivery behavior is caller-chosen via the optional `behavior` field on `message_agent` / `/bus/send`: `followUp` (default) queues new work behind the target's current turn and never interrupts — use it unless you must change course now; `steer` redirects the target's in-flight turn (corrections, priority changes, "stop because X") and is only meaningful while the target is actively working — on an idle target any behavior degrades to a normal message. Omitted behavior is automatic: followUp when busy, normal message when idle.
- **Web console** — roster with presence, status bubbles that edit in place (progress never spawns new bubbles), markdown-rendered bubbles, routing pills for handoffs.

## Telegram

Bots are real Pi sessions, so Telegram composes without runtime code:

- **Per-bot identity**: install pi-telegram, give each bot its own token profile, and run `/telegram-connect <profile>` in that bot's session.
- **Single token**: Threaded Mode maps each fleet bot to its own topic.

The v2 fleet-native adapter (runtime-owned polling, fleet-scoped buttons, routing pills and presence on Telegram) is tracked separately; it is about UX coherence, not connectivity.

## Hermetic operation

All fleet state lives under the fleet dir: `.fleet/lock.json`, `.fleet/sessions/<bot>/`, `.fleet/logs/`. Children get `PI_TIDY_BOTS_*` env only. No telemetry, no writes outside the fleet dir.

## Security posture

**Network security is yours, not the package's.** Run the fleet on loopback or a network you trust (tailnet, LAN) — that is the deployment model, same as rho and Hermes. The console is unauthenticated by default. If you want a lightweight gate against casual visitors, opt in with `--token <secret>` (the web UI then requires it). `/bus/send` always expects a per-boot child secret, so only the daemon's own bots can inject fleet messages. These are convenience guardrails, not a security boundary.

## Development

```bash
npm test                # hermetic unit tests (config, routes, cron, lock)
npm run smoke           # gated: PI_TIDY_BOTS_REAL_SMOKE=1 boots real children
npm run check           # typecheck
```

### Flutter web client (`/app/`)

The daemon serves a Flutter web build side-by-side with the console at
`/app/` (same auth token model). Deploy a build with the sync script — the
files are committed byte-identical, so consumers never need the Flutter SDK:

```bash
node scripts/sync-flutter-web.mjs /path/to/flutter/build/web
git commit -am "chore(pi-tidy-bots): sync flutter web build"
```

Entry documents (`index.html`, `*.json`) revalidate; hashed assets cache
immutably. Phase 2 (making `/app/` the default surface) is parity-gated —
the vanilla console at `/` remains the primary UI.

### Diffing the running daemon

`--version`, `GET /api/version`, and the console footer expose the git commit
the daemon was started from (short + full; omitted when `.git` is unavailable,
e.g. packed installs). To see what a running daemon is missing relative to a
branch:

```bash
git log <commit>..bots/forge        # commits the daemon does not have yet
git log <commit>..main              # same, against main
```

## Status

v0.1.0 preflight. Frozen spec: `.scratch/pi-tidy-bots/` (PRD, use cases + BDD, UX brief, approved mock). Landed: runtime core, bus, console core loop, hermetic demo fleet. Next: completion-reason hardening, release wiring, Telegram composition spikes.
