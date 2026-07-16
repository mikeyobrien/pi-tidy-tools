# pi-tidy-subagents

[![npm version](https://img.shields.io/npm/v/%40mobrienv%2Fpi-tidy-subagents)](https://www.npmjs.com/package/@mobrienv/pi-tidy-subagents)

**Fan work out to child Pi agents without losing the thread.** Adds a
`subagent` tool for [Pi](https://github.com/earendil-works/pi-mono) that runs
independent child prompts concurrently — in the foreground or as session-scoped
background workers — and renders each child as one compact, scannable line. A
companion `subagent_control` tool steers, cancels, inspects, and collects them.

```bash
pi install npm:@mobrienv/pi-tidy-subagents
```

![Mixed foreground and background cards, active widget, durable stamps, management overlay, expanded detail, and narrow viewport](docs/visual.png)

## Usage

The model calls `subagent` with an ordered batch. Each child carries a short
transcript `reason` and a verbatim `prompt`:

```jsonc
{
  "agents": [
    {
      "label": "tests",
      "reason": "run the unit suite",
      "prompt": "Run npm test and summarize any failures.",
    },
    {
      "label": "review",
      "reason": "audit the diff",
      "prompt": "Review the working-tree diff for correctness bugs.",
      "thinking": "high",
    },
  ],
}
```

Children inherit the parent's model, thinking level, working directory,
extensions, skills, and active tools by default; each may optionally pick an
exact `model` or a different `thinking` level. The call waits for every
foreground child and preserves healthy sibling results when an individual
child fails. Settled children read:

```text
<agentName>[<model>|<thinking>] <reason> (<age> ago) → <metrics>
```

Active children keep their latest activity visible. Once settled, response prose
moves behind `ctrl+o`, leaving the child summary compact; interrupted tool state
remains visible because it is terminal truth. Metrics show tool calls, token
traffic (`↑` input, `↓` output), and elapsed time.

## Background children

Add `execution: "background"` to any child and the call returns immediately
with an acknowledgement while the child keeps working:

- Active background work appears in a live widget above the editor; durable
  transcript stamps record launches and completions, and survive session
  resume.
- Manage children with the `/subagents` overlay (`ctrl+shift+b`) or the
  `subagent_control` tool: `background`, `steer`, `cancel`, `inspect`,
  `status`, `set_delivery`, `collect`. Control calls render as one compact,
  action-specific status line; `ctrl+o` reveals their bounded raw response.
- Finished results arrive automatically as a follow-up turn when the parent is
  idle, or on demand via `collect`.
- Workers live for the session: reload, exit, or session replacement cancels
  them cleanly.

## Good to know

- **Children share your working tree.** This package does not lock files,
  create worktrees, or coordinate writes — give children non-overlapping
  mutation scopes or read-only work.
- Complete run manifests (prompts, responses, usage, model/thinking
  provenance) persist under Pi's agent directory at
  `pi-tidy-subagents/runs/<run-id>/`.
- A batch fails preflight as a whole if any child requests an invalid model or
  an unsupported thinking level — no partial runs.
- An optional per-task routing map (`/tidy-subagents-routing`) can suggest
  thinking levels and models per task class.

The full behavior contract — runtime selection and provenance, routing
hierarchy, scheduling, rendering, run-artifact schema, and the background
lifecycle — lives in [docs/reference.md](docs/reference.md).

## Out of scope

Installing this beside another extension that owns the `subagent` tool name is
unsupported. Cross-session/crash recovery, background-to-foreground handoff,
personas, automatic model selection, fuzzy matching, and project-level routing
rules are intentionally outside this package.

## Development

```bash
npm test --workspace @mobrienv/pi-tidy-subagents
npm run check --workspace @mobrienv/pi-tidy-subagents
npm pack --workspace @mobrienv/pi-tidy-subagents --dry-run
```

| Script                 | Role                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm test`             | Release-blocking hermetic suite (fake RPC; no network)                                                                       |
| `npm run smoke`        | Opt-in real-provider smoke (`PI_TIDY_REAL_SMOKE=1`); hetero children when ≥2 auth'd models; skips with diagnostics otherwise |
| `npm run routing-eval` | Opt-in observational routing probes (`PI_TIDY_ROUTING_EVAL=1`); offline structural fixtures already run under `npm test`     |

See [docs/reference.md](docs/reference.md#testing-notes) for routing-eval and
smoke details. Regenerate the renderer artifact with `bash docs/visual.sh`
(Chrome/Chromium and ImageMagick required).
