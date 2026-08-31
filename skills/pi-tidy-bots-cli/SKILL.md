---
name: pi-tidy-bots-cli
description: Drive the pi-tidy-bots fleet runtime from an agent — init, daemonized start, status, stop, hot bot onboarding, and the HTTP+WS machine API (messages, transcripts, compaction, question cards) — all non-interactive with checked exit codes and --json shapes.
argument-hint: "pi-tidy-bots-cli <init|start|status|stop|add> [fleetDir]"
---

# pi-tidy-bots CLI for agents

You are driving the `pi-tidy-bots` CLI (fleet runtime for Pi operator bots) as a
non-interactive agent: no TTY, scripted, exit codes checked. The CLI owns fleet
**lifecycle** (`init`, `start [--daemon]`, `status`, `stop`, `add`) and prints
classified errors on **stderr**. Everything else — messaging, transcripts,
routines, steering, question cards — is the daemon's **HTTP+WS API**, which is
the real machine interface.

Adapted from scout's verified 0.1.0 CLI sweep; updated for the post-issue-29
CLI (lifecycle commands, `--json`, strict flags, exit codes).

## Exit codes (contract)

| Code | Class          | Examples                                                              |
| ---- | -------------- | --------------------------------------------------------------------- |
| 0    | ok             | command succeeded; graceful stop                                      |
| 1    | usage          | unknown flag (with did-you-mean), bad args, stop with nothing running |
| 2    | state conflict | fleet lock held by another daemon; dir already a fleet                |
| 3    | port/addr      | bind address in use                                                   |
| 4    | runtime/auth   | fleet not running; child failed; manifest invalid at start            |

Errors are one clean line on **stderr**: `error: <message> [fix: <remedy>]`.
The lock-conflict message keeps the holder pid. Usage goes to stderr too.
Unknown flags are **hard errors** (`error: unknown flag --tiken for start
[did you mean --token?]`) — never copy flags from memory, use `--help`.

## `--json`

Global flag. `init --json` → `{"fleetDir":"…","created":true}`.
`start --json` (foreground) → one readiness line `{"url","port","pid","token"?}`
(daemon log chatter moves to stderr). `stop --json` → `{"stopped":true,"pid"}`.
`--version --json` → `{"name","version"}`. Human output is the default.

## Lifecycle

```bash
pi-tidy-bots init "$FLEET"                 # scaffold demo fleet; exit 2 if dir already a fleet
pi-tidy-bots start "$FLEET" --daemon --json
# -> {"url":"http://127.0.0.1:4317","port":4317,"pid":<n>}   pid also in .fleet/daemon.pid
pi-tidy-bots status "$FLEET" --json        # {"pid","port","url","bots":[{name,online,queued}]}
pi-tidy-bots stop "$FLEET" --json          # SIGTERM via pidfile, waits for lock release
```

- `start` (foreground) blocks and logs to stdout; `--daemon` runs detached with
  the log at `.fleet/daemon.log` and the pid at `.fleet/daemon.pid`.
- **Non-loopback binds (0.0.0.0 or a LAN IP) auto-enable token auth**: a token
  is minted and stored in `.fleet/token` if none exists, reused on restart, and
  printed in the ready block. `--rotate-token` mints a fresh stored token.
- `stop` is graceful (children stop, lock released). It exits 1 when nothing is
  running or the pid refuses to die.

## Hot bot onboarding (no restart)

```bash
pi-tidy-bots add scout --dir "$FLEET" --title "Research Scout"
# -> scaffolds bots/scout/AGENTS.md + appends the [[bot]] row.
```

The daemon watches `bots.toml` (300ms debounce) and reconciles live: added bots
spawn and appear in the roster; removed bots stop gracefully (their transcript
journal survives); dir/model/routes changes respawn the child resuming its
session dir. An invalid manifest edit is refused — the running fleet is kept
and a `config-error` WS event names the problem. Names must match
`[a-z][a-z0-9-]{1,31}`.

## The HTTP+WS machine API

Authenticate: `Authorization: Bearer $TOKEN` (or `?token=`; pairing URLs carry
`#token=` in the fragment — read it from `location.hash`). Feature-detect via
`GET /api/version` → `{version, capabilities[]}`.

- Roster: `GET /api/fleet` → per-bot `name/title/avatar/online/active/
lastActive/queued/latest`. Children spawn async — gate messaging on
  `online:true`, not on the ready line.
- Send: `POST /api/bots/:name/message` `{"text":"…", "images"?:[{mediaType,data}]}`.
  Delivery is async (`{"accepted":true}`); poll the transcript.
- Poll: `GET /api/bots/:name/transcript?before=<iso>&limit=<n>` → entries with
  `id, role, origin (operator|bot|routine|system), originFrom?, text, ts,
steps?, ui?, uiResolved?`. Dedupe by `id`.
- Steer mid-turn: `POST /api/bots/:name/steer` `{"text":"…"}`.
- Compaction (reset): `POST /api/bots/:name/compact` — `409 turn_in_flight`
  while streaming.
- Question cards: entries carry `ui`; answer via
  `POST /api/bots/:name/ui/<id>` with `{"value"}` / `{"confirmed"}` /
  `{"cancel":true}`. Unanswered cards auto-resolve after 120s.
- Bus (bot→bot, child-only): `POST /bus/send` needs the per-boot
  `x-fleet-child` secret — never call it from a client.
- Error shapes: `401 {"error":"unauthorized"}`, `404 {"error":"unknown bot"}`,
  `503 {"error":"runtime_offline"}`, `409 {"error":"turn_in_flight"}`.

## Pitfalls

1. `start` (foreground) blocks forever — background it yourself, or use
   `--daemon` and let the CLI own the pidfile.
2. The readiness line can precede child readiness — poll `/api/fleet`, gate on
   `online:true`.
3. `chat` is a human TUI — it hangs a non-interactive session. Don't.
4. `queued` and `latest` in the roster are advisory.
5. Transcript entries are typed (`origin`), not string-prefixed — never parse
   `source` strings.

## Security

Network security is the operator's, not the package's. Loopback is
unauthenticated by default; non-loopback binds mint a token automatically
(stored at `.fleet/token` — treat it like a credential). Prefer a tailnet or
trusted LAN; `--token` stays available as an override.

## Credits

Adapted from scout's hands-on CLI sweep (0.1.0 verification) and updated for
the post-29 CLI surface by forge.
