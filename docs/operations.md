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
