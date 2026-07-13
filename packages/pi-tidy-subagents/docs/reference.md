# pi-tidy-subagents reference

The complete behavior contract for pi-tidy-subagents: runtime selection and
provenance, routing guidance, scheduling, rendering, run artifacts, and the
background execution lifecycle. For an overview and quick start, see the
[README](../README.md).

## Runtime selection

Children inherit the parent's model, thinking level, working directory, project resources, extensions, skills, and active tools by default. Each child may optionally select:

| Field      | Values                                                        | Default        |
| ---------- | ------------------------------------------------------------- | -------------- |
| `model`    | Exact registered `provider/model-id` (split at the first `/`) | inherit parent |
| `thinking` | Closed Pi set: `off\|minimal\|low\|medium\|high\|xhigh\|max`  | inherit parent |

**Thinking is the primary per-child control.** Prefer omit model (inherit parent) unless capability or cost warrants an exact override. Fuzzy patterns, aliases, and profiles are rejected.

### Inheritance and overrides

| Pattern                       | Behavior                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unchanged inheritance         | Both fields omitted → parent model + thinking                                                                            |
| Model-only override           | Exact `provider/model-id`; thinking inherits (clamped if unsupported)                                                    |
| Thinking-only override        | Closed Pi level on the parent model; fails preflight if unsupported                                                      |
| Heterogeneous fan-out         | Siblings may mix inherit / model-only / thinking-only / both in input order                                              |
| Explicit unsupported thinking | Whole batch fails preflight with supported alternatives; no partial artifacts                                            |
| Inherited adjustment          | Unsupported inherited levels clamp via `@earendil-works/pi-ai` (non-reasoning → `off`); adjustment retained in artifacts |
| Startup observation           | After spawn, each child answers RPC `get_state` before its prompt                                                        |
| Runtime provenance            | Manifests record parent vs request for model and thinking                                                                |

Runtime selection never mutates the parent session model or thinking.

### Requested / resolved / observed

These are distinct truths:

| Stage         | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| **Requested** | Caller intent on the tool call (`model` / `thinking` fields)                    |
| **Resolved**  | Parent-side validation, inheritance, and canonical thinking clamp before launch |
| **Observed**  | What the child Pi process reports via `get_state` before prompt                 |

They may differ (for example inherited clamp, or provider-side thinking adjustment). **Compact rendering shows effective/observed model id and thinking level.** Requested values, resolved values, and clamp reasons remain in expanded diagnostics and schema v2 run artifacts.

### Preflight and launch

The complete ordered batch is resolved against Pi's live model registry, configured authentication, and Pi's canonical thinking-capability utilities before any child starts. One invalid model or explicitly unsupported thinking level fails the whole call with no partial run artifacts. After process startup, each child reports RPC state before receiving its prompt; observed model identity must match the resolved selection, and observed thinking becomes the effective compact-render and persistence truth. Delegation itself is disabled only in true child RPC processes (`PI_TIDY_SUBAGENT_CHILD=1` **and** `--mode rpc`); a leaked child env alone does not disable parent sessions, and intentional skips emit a one-line startup diagnostic.

## Runtime routing guidance

Short schema defaults stay generic (exact IDs, omit inherits, thinking-primary task-shape hints). When choosing optional per-child `model` / `thinking`, use an idiomatic **override hierarchy** — **most specific wins**:

1. **Explicit per-child `model` / `thinking` request fields** on the tool call
2. **User turn instructions** in the current session
3. **AGENTS.md / project agent instructions** (when present in the project)
4. **Optional structured agent-dir routing map** from `/tidy-subagents-routing`
5. **Extension short schema defaults / `promptGuidelines`**
6. **Parent inheritance** when fields remain omitted

This package does **not** parse `AGENTS.md`, auto-read project agent instructions, or inject routing onto child requests — the frontier agent applies the hierarchy and sets optional fields (or omits them so parent inheritance applies at runtime).

### User routing map (optional)

Detailed task→model mapping can be **user-provided** via a structured agent-dir config over authenticated models:

```text
<agent-dir>/pi-tidy-subagents/routing.json
```

#### Slash command

```text
/tidy-subagents-routing setup      # agentic: assign thinking (primary) + optional model per task class
/tidy-subagents-routing defaults   # write thinking-primary defaults; model always inherit
/tidy-subagents-routing status
/tidy-subagents-routing clear
```

Setup lists authenticated models from the session registry, never mutates parent model/thinking, and atomically writes the map. Standard task classes:

`bounded-lookup`, `mechanical-implementation`, `ordinary-review`, `architectural-judgment`, `concurrency-analysis`, `cost-sensitive`, `similarly-named-models`, `cross-provider`

Example map:

```json
{
  "version": 1,
  "taskClasses": {
    "bounded-lookup": { "thinking": "minimal" },
    "architectural-judgment": { "thinking": "high", "model": "other/strong" },
    "cross-provider": { "model": "other/strong" }
  }
}
```

When present, the map is summarized in tool `promptGuidelines` as one layer of the override hierarchy (below user turn / AGENTS.md, above schema defaults). Explicit tool-call fields always win over the map.

## Execution contract

### Scheduling

A session-wide FIFO queue admits the smaller of half available CPU parallelism
and one child per 2 GiB free memory. Foreground and background children share
this cap and launch order. Foreground ownership remains the default: calls with
no `execution` field wait synchronously and preserve healthy sibling results
after individual failures. A background child is durably registered and
acknowledged immediately, then continues under the session coordinator while
the parent proceeds.

### Live rendering

Collapsed output shows one current activity per child; `ctrl+o` shows the
latest fifteen.

- Multi-child fan-out inserts one unpainted blank line between siblings so
  parallel agents scan like parallel tool cards (a real gap through the shared
  pending/success background); a single child stays tight.
- Running children use a stable status dot, and live output redraws only when
  child state or activity changes.
- Child completion timestamps persist in result details and run manifests, so
  ages remain accurate after session restarts; active children omit the age.
- Compact headers show the **effective/observed** thinking level without
  routine adjustment noise. Cache traffic is intentionally omitted from the
  compact header.
- When the header fits, it stays on one scan-friendly row; narrow viewports
  move only the metrics to a second row.

### Run artifacts

Complete versioned `run.json` manifests (schema version 3) persist the parent
runtime snapshot; per-child requested/resolved/observed model and thinking
provenance; requested execution, current and terminal ownership, ownership
timestamps/reason, completion-delivery state, follow-up acceptance, collection
metadata, control history; and exact cumulative `input`, `output`, `cacheRead`,
`cacheWrite`, and total `providerTraffic`. Full prompts, responses, and
normalized child JSONL events remain beneath Pi's configured agent directory at
`pi-tidy-subagents/runs/<run-id>/`. Public tool details redact prompts and
responses. The legacy `tokens` total remains in manifests, schema-v1/v2 details
remain renderable, and terminal legacy artifacts can be collected by canonical
target when available. Historical manifests never reconstruct active workers.

Parent results are ordered XML with CDATA-protected Markdown and bounded to
16 KiB per child / 50 KiB total; artifact attributes point to complete
responses.

## Background execution and control

Each agent request accepts `execution: "foreground" | "background"`; omission means `foreground`. One fan-out may mix both modes. The call waits only for children still owned in the foreground:

```json
{
  "agents": [
    {
      "label": "needed",
      "reason": "return required analysis",
      "prompt": "..."
    },
    {
      "label": "watcher",
      "reason": "continue long investigation",
      "prompt": "...",
      "execution": "background"
    }
  ]
}
```

Foreground children retain their ordered bounded result envelopes. Background children return an ordered `<background_ack>` containing canonical target, label, process state, ownership, delivery policy, and artifact path—never partial assistant output. A canonical target is `<run-id>:<child-id>`; an active label is accepted only when it resolves unambiguously. Ambiguous labels fail with every matching canonical target and state.

`subagent_control` uses parallel tool execution and supports:

| Action         | Required fields                          | Behavior                                                                               |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `background`   | `target`                                 | One-way handoff of queued/starting/running foreground work                             |
| `steer`        | `target`, non-empty `message`            | Sends Pi RPC's native FIFO `steer`; queued/not-ready children return a retryable error |
| `cancel`       | `target`                                 | Cancels only that queued or running child; terminal retries are idempotent             |
| `inspect`      | `target`                                 | Returns target, process/ownership state, activity, delivery, and artifact metadata     |
| `status`       | none                                     | Lists active foreground, active background, and terminal uncollected results           |
| `set_delivery` | `target`, `delivery: "auto" \| "manual"` | Changes completion policy before Pi accepts an automatic follow-up                     |
| `collect`      | `target`                                 | Returns the same bounded CDATA envelope repeatedly without deleting artifacts          |

A same-turn sibling control call may rendezvous with a label declared by a parallel `subagent` call; failed lookup expires and cannot affect a later turn. Operations for one child serialize through the coordinator, while different targets remain independently parallelizable.

### Widget, stamps, and management

In TUI mode, active background children appear in one read-only widget above the editor in stable launch order. Rows reuse the synchronous robot identity, observed model/thinking, reason, activity, tool count, directional usage, duration, delivery policy, and pending-steering vocabulary. Queued work remains visible. Terminal work leaves the widget after a durable terminal stamp is appended.

Direct launch and foreground handoff append an immediate transcript stamp. Completion, warning, failure, cancellation, and shutdown cancellation append terminal stamps. Stamps use Pi custom entries, remain outside model context, survive session resume, and expand with artifact/result detail via `ctrl+o`. The synchronous card retains only a compact background acknowledgement, so one child never has two live progress owners.

Open the management overlay with `/subagents` or `ctrl+shift+b`. It groups active foreground, active background, and terminal uncollected children and exposes only state-valid actions. Steering opens a targeted multiline editor. User-side collection queues the bounded result as a parent follow-up.

### Completion delivery and session lifetime

Background delivery defaults to `auto`. After terminal state and the terminal stamp are persisted, Pi receives one compact custom message with `deliverAs: "followUp"` and idle triggering enabled. It waits behind active parent work and starts a turn when the parent is idle. `set_delivery manual` suppresses that follow-up only before Pi accepts it; accepted follow-ups cannot be retracted. Manual and otherwise uncollected results remain discoverable through `status`, the overlay, and `collect`. Repeated collection returns identical result content plus prior-collection metadata.

Workers survive parent turns, not extension reload, session replacement, fork/clone replacement, Pi exit, or crashes. Every normal session shutdown cancels queued/running children, persists terminal truth, appends terminal stamps while the old TUI is valid, clears the widget, and suppresses new parent completions.

| Parent mode | Background contract                                                                     |
| ----------- | --------------------------------------------------------------------------------------- |
| TUI         | Launch/control, widget, overlay, shortcut, stamps, follow-ups                           |
| RPC / JSON  | Launch/control, artifacts, and completion messages; no terminal component factories     |
| Print       | Background launch and handoff rejected; ordinary foreground execution remains supported |

## Testing notes

Routing evaluations cover the task shapes above, record inherit vs select for model and thinking, and whether the choice matches guidance. They are observational and never gate releases. See [routing-eval.md](routing-eval.md).

Heterogeneous smoke confirms each child reports the expected observed model and effective thinking level before prompt execution. When credentials or models are unavailable it skips with actionable diagnostics (`PI_TIDY_SMOKE_MODELS=provider/a,provider/b` optional override).
