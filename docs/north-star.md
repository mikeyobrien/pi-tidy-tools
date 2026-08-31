# North Star

pi-tidy makes Pi agents **easier to follow** — and, increasingly, easier to **operate**.

## Thesis

Focused, independently installable packages. Each solves one problem well. Nothing in
the suite depends on another package in the suite; when packages compound, it is
because the joins are **designed deliberately and documented per package** — never
because of shared dependencies.

## The suite, one rung at a time

| Rung                  | Package             | Problem it owns                                                       |
| --------------------- | ------------------- | --------------------------------------------------------------------- |
| Follow one turn       | `pi-tidy-tools`     | Truthful, reason-first transcript rendering                           |
| Follow the delegation | `pi-tidy-subagents` | Fan-out child agents with live truth and durable runs                 |
| Remember across turns | `pi-tidy-memory`    | Durable, backend-neutral memory with per-context banks                |
| Follow the session    | `pi-tidy-footer`    | Live per-session status strip                                         |
| Operate a fleet       | `pi-tidy-bots`      | Perpetual bot sessions, roster, handoffs, driveable from web UI / TUI |

Each rung assumes the ones below it only in the user's head and hands — a bot fleet is
still "Pi sessions you can follow", a memory bank is still "state you can follow".

## Synergy thesis

Installed together, the suite compounds:

- Bot sessions (pi-tidy-bots) inherit the operator's entire Pi setup — suite packages
  load inside them unshimmed; the runtime never gets between a session and its
  extensions (**non-interference contract**).
- Memory's cwd-derived dynamic banks give every bot its own bank (`bots::<name>`)
  without bots knowing memory exists.
- Tidy rendering and the footer follow the operator into fleet sessions untouched.
- Doctrine over mechanism: where two packages could overlap (subagents vs peer bots),
  the suite ships _templates and documentation_ for choosing, not coupling.

Deliberate joins are specified as scenarios in the owning package's design docs and
land only after that package's core contract is stable — synergy is a roadmap, never a
dependency.

## North Star joins (tracked)

1. Per-bot memory banks (`bots::<name>`) — config-level when it lands.
2. Subagents-vs-peer-bots doctrine shipped as bot persona/skill templates.
3. Fleet observability: roster-level views across memory banks and subagent runs.

## Where things stand

- **Stable (npm):** pi-tidy-tools, pi-tidy-subagents, pi-tidy-memory
- **Experimental:** pi-tidy-footer, pi-tidy-bots
