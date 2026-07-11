# pi-tidy-subagents

Compact, synchronous RPC fan-out for [Pi](https://github.com/earendil-works/pi-mono). It registers one `subagent` tool whose ordered `agents` each contain an optional label, short transcript reason, and verbatim child prompt.

```bash
pi install npm:@mobrienv/pi-tidy-subagents
```

![Queued, running, successful, warning, failed, cancelled, parallel-tool, and expanded subagent states](docs/visual.png)

## Runtime selection

Children inherit the parent's model, thinking level, working directory, project resources, extensions, skills, and active tools by default. Each child may optionally select:

| Field | Values | Default |
| --- | --- | --- |
| `model` | Exact registered `provider/model-id` (split at the first `/`) | inherit parent |
| `thinking` | Closed Pi set: `off\|minimal\|low\|medium\|high\|xhigh\|max` | inherit parent |

**Thinking is the primary per-child control.** Prefer omit model (inherit parent) unless capability or cost warrants an exact override. Fuzzy patterns, aliases, and profiles are rejected.

### Inheritance and overrides

| Pattern | Behavior |
| --- | --- |
| Unchanged inheritance | Both fields omitted → parent model + thinking |
| Model-only override | Exact `provider/model-id`; thinking inherits (clamped if unsupported) |
| Thinking-only override | Closed Pi level on the parent model; fails preflight if unsupported |
| Heterogeneous fan-out | Siblings may mix inherit / model-only / thinking-only / both in input order |
| Explicit unsupported thinking | Whole batch fails preflight with supported alternatives; no partial artifacts |
| Inherited adjustment | Unsupported inherited levels clamp via `@earendil-works/pi-ai` (non-reasoning → `off`); adjustment retained in artifacts |
| Startup observation | After spawn, each child answers RPC `get_state` before its prompt |
| Runtime provenance | Manifests record parent vs request for model and thinking |

Runtime selection never mutates the parent session model or thinking.

### Requested / resolved / observed

These are distinct truths:

| Stage | Meaning |
| --- | --- |
| **Requested** | Caller intent on the tool call (`model` / `thinking` fields) |
| **Resolved** | Parent-side validation, inheritance, and canonical thinking clamp before launch |
| **Observed** | What the child Pi process reports via `get_state` before prompt |

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

A session-wide FIFO queue admits the smaller of half available CPU parallelism and one child per 2 GiB free memory. Calls wait for every child and preserve healthy sibling results after individual failures.

Collapsed output shows one current activity per child; `ctrl+o` shows the latest fifteen. Running children use a stable status dot, and live output redraws only when child state or activity changes. The robot glyph identifies the row as delegated work, so headers omit a redundant `subagent` noun and read `<agentName>[<model>|<thinking>] <reason> → <metrics>`. Compact headers show the **effective/observed** thinking level without routine adjustment noise. When the header fits, it stays on one scan-friendly row; narrow viewports move only the metrics to a second row. Metrics report tool calls, directional provider usage (`↑` input and `↓` output), and elapsed duration. Cache traffic is intentionally omitted from the compact header.

Complete versioned `run.json` manifests (schema version 2) persist the parent runtime snapshot, per-child requested/resolved/observed model and thinking provenance (including thinking adjustment metadata), exact cumulative `input`, `output`, `cacheRead`, `cacheWrite`, and total `providerTraffic` per child alongside responses and normalized child JSONL events beneath Pi's configured agent directory at `pi-tidy-subagents/runs/<run-id>/`. The legacy `tokens` total remains in manifests for compatibility. Legacy child details that only carry top-level `model`/`thinking` remain renderable. Parent results are ordered XML with CDATA-protected Markdown and bounded to 16 KiB per child / 50 KiB total; hidden artifact attributes retain access to complete responses.

> **Filesystem safety:** children share the same working tree. This package does not lock files, create worktrees, or coordinate writes. Allocate non-overlapping mutation scopes or use read-only fan-out.

Installing this beside another extension that owns the `subagent` tool name is unsupported. Detached runs, selective cancellation, personas, automatic model selection, fuzzy matching, and project-level routing rules are intentionally outside this package.

## Development

```bash
npm test --workspace @mobrienv/pi-tidy-subagents
npm run check --workspace @mobrienv/pi-tidy-subagents
npm pack --workspace @mobrienv/pi-tidy-subagents --dry-run
```

| Script | Role |
| --- | --- |
| `npm test` | Release-blocking hermetic suite (fake RPC; no network) |
| `npm run smoke` | Opt-in real-provider smoke (`PI_TIDY_REAL_SMOKE=1`); hetero children when ≥2 auth'd models; skips with diagnostics otherwise |
| `npm run routing-eval` | Opt-in observational routing probes (`PI_TIDY_ROUTING_EVAL=1`); offline structural fixtures already run under `npm test` |

Routing evaluations cover the task shapes above, record inherit vs select for model and thinking, and whether the choice matches guidance. They are observational and never gate releases. See [docs/routing-eval.md](docs/routing-eval.md).

Heterogeneous smoke confirms each child reports the expected observed model and effective thinking level before prompt execution. When credentials or models are unavailable it skips with actionable diagnostics (`PI_TIDY_SMOKE_MODELS=provider/a,provider/b` optional override).

Regenerate the renderer artifact with `bash docs/visual.sh` (Chrome/Chromium and ImageMagick required).
