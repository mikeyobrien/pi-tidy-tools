# Routing evaluation suite

Observational measurements of whether frontier agents inherit or select per-child `model` / `thinking` consistently with task guidance. **Not release-blocking.**

## Task shapes

| ID | Intent | Default thinking | Default model |
| --- | --- | --- | --- |
| `bounded-lookup` | Exact fact retrieval | `minimal` | inherit |
| `mechanical-implementation` | Straightforward code change | `low` | inherit |
| `ordinary-review` | Local review feedback | `medium` | inherit |
| `architectural-judgment` | Boundary / seam design | `high` | inherit (user may map stronger model) |
| `concurrency-analysis` | Races / ordering | `high` | inherit |
| `cost-sensitive` | Cheap classification | `minimal` | inherit (user may map cheaper model) |
| `similarly-named-models` | Exact-ID discrimination | inherit | user map required |
| `cross-provider` | Different provider than parent | inherit | user map required |

Thinking is the **primary** per-child control. Model overrides come from the user structured map produced by `/tidy-subagents-routing` over authenticated models.

## Recording format

Each case records:

- `modelAction`: `inherit` | `select`
- `thinkingAction`: `inherit` | `select`
- `modelMatch` / `thinkingMatch`: whether the choice matches task guidance
- `choice` and `guidance` snapshots

Mismatches are retained as observational data. They do **not** fail default `npm test`.

## Commands

```bash
# Offline structural fixtures (always part of npm test; always pass)
npm test --workspace @mobrienv/pi-tidy-subagents -- test/routing-eval.test.ts

# Opt-in live probe hook (no release gate)
npm run routing-eval --workspace @mobrienv/pi-tidy-subagents
```

## Setup map

```bash
# In a Pi session with authenticated providers:
/tidy-subagents-routing setup     # interactive task→thinking/model map
/tidy-subagents-routing defaults  # thinking-primary defaults, model=inherit
/tidy-subagents-routing status
/tidy-subagents-routing clear
```

Config path: `<agent-dir>/pi-tidy-subagents/routing.json`.
