# pi-tidy-subagents

Compact, synchronous RPC fan-out for [Pi](https://github.com/earendil-works/pi-mono). It registers one `subagent` tool whose ordered `agents` each contain an optional label, short transcript reason, and verbatim child prompt.

```bash
pi install npm:@mobrienv/pi-tidy-subagents
```

![Queued, running, successful, warning, failed, cancelled, parallel-tool, and expanded subagent states](docs/visual.png)

Children inherit the parent's model, thinking level, working directory, project resources, extensions, skills, and active tools. Delegation itself is disabled in children. A session-wide FIFO queue admits the smaller of half available CPU parallelism and one child per 2 GiB free memory. Calls wait for every child and preserve healthy sibling results after individual failures.

Collapsed output shows one current activity per child; `ctrl+o` shows the latest fifteen. Multi-child fan-out inserts one unpainted blank line between siblings so parallel agents scan like parallel tool cards (real gap through the shared pending/success background); a single child stays tight. Running children use a stable status dot, and live output redraws only when child state or activity changes. The robot glyph identifies the row as delegated work, so headers omit a redundant `subagent` noun and read `<agentName>[<model>|<thinking>] <reason> → <metrics>`. When that fits, the header stays on one scan-friendly row; narrow viewports move only the metrics to a second row. Metrics report tool calls, directional provider usage (`↑` input and `↓` output), and elapsed duration. Cache traffic is intentionally omitted from the compact header. Complete versioned `run.json` manifests persist exact cumulative `input`, `output`, `cacheRead`, `cacheWrite`, and total `providerTraffic` per child alongside responses and normalized child JSONL events beneath Pi's configured agent directory at `pi-tidy-subagents/runs/<run-id>/`. The legacy `tokens` total remains in manifests for compatibility. Parent results are ordered XML with CDATA-protected Markdown and bounded to 16 KiB per child / 50 KiB total; hidden artifact attributes retain access to complete responses.

> **Filesystem safety:** children share the same working tree. This package does not lock files, create worktrees, or coordinate writes. Allocate non-overlapping mutation scopes or use read-only fan-out.

Installing this beside another extension that owns the `subagent` tool name is unsupported. Detached runs, selective cancellation, personas, overrides, routing hints, and `/subagents` exploration are intentionally outside P0.

## Development

```bash
npm test --workspace @mobrienv/pi-tidy-subagents
npm run check --workspace @mobrienv/pi-tidy-subagents
npm pack --workspace @mobrienv/pi-tidy-subagents --dry-run
```

`npm run smoke` is opt-in and requires a configured real provider. The standard suite uses a deterministic fake RPC executable.

Regenerate the renderer artifact with `bash docs/visual.sh` (Chrome/Chromium and ImageMagick required).
