# Narrow-screen Pi footer plan

**Status:** proposal  
**Target:** Termux portrait sessions, usually 52–56 terminal columns  
**Recommendation:** add a `pi-tidy-footer` package with a two-line, priority-based responsive footer

## Executive recommendation

Do not make the current footer shorter by truncating its completed strings. Build the footer from semantic items that each have full, compact, and minimal forms, then select forms by priority for the actual `render(width)` value.

At the observed 52–56-column mobile width, reserve at most two lines:

```text
main · sol/max · ctx 28%
5h 3% · 7d 20% · 🧠58L/16P · ρ23m
```

The first line answers **where, what model, and how close to compaction**. The second answers **what scarce capacity or background state needs attention**. Cumulative token accounting, cache totals, synthetic subscription cost, provider name, full path, and decorative bars are progressively disclosed only at wider widths or through a detail command.

Warnings must replace lower-priority content rather than being clipped after it:

```text
main · sol/max · ! ctx 76%
!! 5h 91% used · 2 agents running
```

## Local evidence

A captured Pi frame in `~/.pi/agent/pi-crash.log` shows the real problem at 56 columns:

- the working directory line uses only 8 columns;
- the stats line uses 52 columns and loses the model entirely;
- an extension-status line uses 22 columns;
- the Codex quota bar uses 66 columns, exceeding the viewport;
- the footer therefore spends three lines while still hiding identity and overflowing quota information.

Pi's current footer constructs cumulative token/cache/cost fields first, truncates that complete left side, and gives the model only the remainder. At narrow widths this makes low-actionability historical counters crowd out the active model and thinking level. It also places all extension statuses on one string and truncates the tail. See Pi's current [`FooterComponent`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/modes/interactive/components/footer.ts).

## Primary-source findings

### Render against terminal cells, not string length

Pi's TUI contract passes the current terminal width into `render(width)`, requires every returned line to fit, and provides ANSI-aware `visibleWidth()` and `truncateToWidth()` helpers. It also tells components to invalidate cached output when state or theme changes. These are the correct primitives; the footer should not read `$COLUMNS` or infer width in a subprocess. [Pi TUI documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/tui.md)

POSIX defines `wcwidth()` as the number of terminal column positions occupied by a wide character. This is why JavaScript code-unit length is not a safe layout measure for emoji, combining characters, or East Asian text. [POSIX `wcwidth`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/wcwidth.html)

OpenAI Codex applies the same principle in its TUI: it measures styled spans with `UnicodeWidthStr` and truncates by display cells while preserving span styles. Its ellipsis helper reserves one cell before appending `…`. [Codex `line_truncation.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/line_truncation.rs)

### Bound regions and support multiple rows

tmux exposes explicit maximum lengths for left and right status regions (`status-left-length`, `status-right-length`) and allows the status area to use multiple rows. Its format language also supports width limits and focused content when a list cannot fit. This establishes two useful precedents: each region needs a budget, and constrained status content should preserve the focused item rather than clip an undifferentiated string. [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1)

Pi already supports complete footer replacement through `ctx.ui.setFooter()`. `footerData` supplies the Git branch and extension-status map, while session/model state supplies token and model data. Branch-change subscriptions can request rerenders and expose a disposer. [Pi custom-footer example](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts)

### Reflow and accessibility

WCAG's reflow guidance is written for graphical content, not terminal cells, but the underlying requirement is useful: users should not need two-dimensional scrolling to recover information at a narrow viewport. The footer should recompose or omit lower-priority items rather than overflow horizontally. [WCAG 2.2 Understanding Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)

Color cannot be the only way to communicate state. Context and quota warnings therefore need text or symbols in addition to warning/error colors. [WCAG 2.2 Understanding Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)

Dim text is common in terminal footers, but essential values and warnings need sufficient contrast. Use Pi's semantic theme colors and avoid applying `dim` to every item indiscriminately. [WCAG 2.2 Understanding Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

### Comparative issue evidence

These are user reports rather than normative sources, but they reinforce the failure mode:

- Codex users report long status content being clipped on narrow terminals and request multiline or better responsive behavior: [openai/codex#26442](https://github.com/openai/codex/issues/26442), [openai/codex#21653](https://github.com/openai/codex/issues/21653).
- Claude Code status-line users report width detection and ANSI/truncation problems when adaptation is delegated to an external status command: [anthropics/claude-code#60335](https://github.com/anthropics/claude-code/issues/60335), [anthropics/claude-code#22115](https://github.com/anthropics/claude-code/issues/22115).

Pi's in-process `render(width)` API avoids that subprocess-width problem.

## Information hierarchy

### Priority 0: never silently lose

1. Error, blocked, retrying, or degraded state
2. Context pressure at warning/error thresholds
3. Provider quota near exhaustion
4. Active background-agent count when nonzero

These may displace everything except the minimal model identity. They use both a textual/symbolic marker and semantic color.

### Priority 1: always show when width permits

1. Repository/branch identity
2. Short model identity
3. Thinking level
4. Context percentage

Recommended compact model aliases are presentation-only:

| Model ID        | Compact identity            |
| --------------- | --------------------------- |
| `gpt-5.6-sol`   | `sol`                       |
| `gpt-5.6-terra` | `terra`                     |
| `gpt-5.6-luna`  | `luna`                      |
| unknown model   | ANSI-safe tail-truncated ID |

Thinking joins the model as `sol/max`, not `sol • max`, to save cells while keeping meaning.

### Priority 2: show on target widths if active

1. Five-hour and seven-day Codex quota percentages
2. Mnemosyne/Hindsight state if degraded or actively processing
3. Subagent running/pending count
4. Gondolin state while starting, stopping, or failed

Idle healthy services should not consume permanent space.

### Priority 3: wide-screen or detail view

- cumulative input/output tokens;
- cache read/write and hit rate;
- synthetic dollar cost for subscription-backed providers;
- full provider name;
- complete path/session name;
- graphical quota bars;
- verbose extension status text.

These are useful diagnostics but are less actionable on every frame.

## Responsive tiers

These are behavior tiers, not fixed rendered templates. Every tier still packs by measured cell width.

### Fewer than 32 columns: emergency compact

One or two lines, no path, quotas, counters, or prose:

```text
sol/max ctx28%
! 2 agents
```

If there is an error, line two becomes the compact error status.

### 32–47 columns: compact

Two lines:

```text
main · sol/max · ctx28%
5h3% · 7d20% · ρ23m
```

Branch is reduced to a width-bounded basename/tail. Quota labels stay because bare percentages are ambiguous.

### 48–71 columns: mobile target

Two lines with readable separators and active service state:

```text
main · sol/max · ctx 28%
5h 3% · 7d 20% · 🧠58L/16P · ρ23m
```

This tier is the design center. It must be tested especially at 52 and 56 columns.

### 72–95 columns: standard

Two lines. Add session token totals or cache hit rate after all higher-priority items fit:

```text
~/projects/pi-tidy-tools (main) · sol/max · ctx 28%/272k
5h 3% · 7d 20% · ↑83k ↓37k · cache 93% · ρ23m
```

### 96 columns and above: expanded

Two or three lines according to configuration. Full model/provider, context window, counters, cache details, and full extension statuses may appear. Do not use extra space as a reason to show idle noise by default.

## Layout algorithm

Represent each semantic item independently:

```ts
type FooterVariant = {
  text: string;
  width: number;
};

type FooterItem = {
  id: string;
  priority: 0 | 1 | 2 | 3;
  line: "identity" | "capacity";
  variants: FooterVariant[]; // full -> compact -> minimal
  active: boolean;
};
```

1. Sanitize control characters from external status values.
2. Build item variants without pre-baked global padding.
3. Measure every variant with `visibleWidth()`.
4. Reserve line one for identity/context and line two for capacity/activity.
5. Insert priority 0 items first, then priority 1, and so on.
6. For each item, select the richest variant that fits.
7. If a new critical item does not fit, downgrade or evict the lowest-priority existing item.
8. Apply `truncateToWidth()` only to a single variable-length item such as branch, model ID, or error prose—not to the completed line.
9. Assert or defensively truncate each final line to `width` as the final safety net.
10. Return no more than two lines in `auto` and `compact` modes.

This is a small deterministic priority allocator, not a general layout engine. A greedy algorithm is sufficient because priorities and line assignments are explicit and the item count is small.

## Extension-status compatibility

`footerData.getExtensionStatuses()` returns keys and already-rendered strings, not semantic metadata. The first version should:

- preserve the key while sorting/classifying;
- strip line breaks and control characters from values;
- define compact adapters for known local keys such as Gondolin, memory, and subagents;
- treat unknown nonempty statuses as priority 2, with a bounded compact form;
- elevate unknown text containing clear error/failure markers to priority 0;
- never concatenate all statuses and then truncate the tail.

A later Pi upstream proposal could add structured status metadata (`priority`, `shortText`, `severity`) while preserving the existing string API.

## Commands and configuration

Package: `packages/pi-tidy-footer`

Commands:

```text
/tidy-footer auto      # responsive two-line default
/tidy-footer compact   # force narrow representation
/tidy-footer full      # diagnostic representation
/tidy-footer default   # restore Pi's stock footer
/tidy-footer inspect   # expanded current footer data in an overlay/dialog
```

Initial configuration should be small:

```json
{
  "mode": "auto",
  "maxLines": 2,
  "showQuota": true,
  "showInactiveStatuses": false,
  "modelAliases": {
    "gpt-5.6-sol": "sol",
    "gpt-5.6-terra": "terra",
    "gpt-5.6-luna": "luna"
  }
}
```

Avoid exposing arbitrary format strings in v1. They recreate the width-accounting and priority problems this package is meant to solve.

## Implementation phases

### Phase 1: pure layout core

- Create item/variant types, sanitization, model aliases, number formatting, and the two-line allocator.
- Keep rendering independent of Pi session objects.
- Add golden cases for widths 20, 31, 32, 40, 47, 48, 52, 56, 71, 72, 80, 95, 96, and 120.

### Phase 2: Pi adapter

- Register `ctx.ui.setFooter()` on `session_start`.
- Read branch/status data from `footerData` and model/session data from `ctx`.
- Subscribe to branch changes and dispose the subscription correctly.
- Request renders after relevant state changes; do no network or filesystem work inside `render()`.
- Restore the prior/default footer on disable and shutdown.

### Phase 3: local status adapters

- Convert Codex quota bars to compact labeled percentages on narrow widths.
- Add known adapters for memory, subagents, and Gondolin.
- Keep raw full status text available through `/tidy-footer inspect`.

### Phase 4: field test and upstream feedback

- Capture portrait Termux frames at 52 and 56 columns while idle, streaming, near context compaction, with active subagents, and with a provider error.
- Rotate/rescale during streaming to verify immediate recomposition.
- If extension status strings remain the main limitation, propose structured status variants upstream to Pi.

## Test and acceptance criteria

### Width safety

For every test width and every generated state:

```ts
for (const line of footer.render(width)) {
  assert(visibleWidth(line) <= width);
}
```

Include ANSI colors, OSC controls, emoji, combining marks, CJK text, long Git branches, long model IDs, and malformed multiline extension statuses.

### Priority behavior

- Model alias and context percentage are visible at 32 columns and above.
- A context warning above 70% has a non-color marker.
- A context error above 90% displaces token/cache/cost fields.
- Near-exhausted quota displaces inactive service statuses.
- Active/failed statuses appear before cumulative accounting.
- No bare unlabeled percentage appears.
- Unknown statuses cannot push a line past its width.

### Stability

- Repeated renders with identical state are byte-identical.
- Resizing 120 → 52 → 32 → 80 columns never leaves stale cached layout.
- Theme invalidation rebuilds themed strings.
- Branch subscription is disposed exactly once.
- Rendering performs no asynchronous work and remains fast over repeated frames.

### Mobile acceptance

At the actual 52–56-column portrait width:

- footer height is at most two rows;
- no quota bar or footer line exceeds the viewport;
- branch, model/thinking, and context are simultaneously visible;
- five-hour and seven-day quotas are visible when Codex is active;
- errors and pressure states are understandable without relying on color;
- detailed counters remain available through `/tidy-footer inspect`.

## Decision

Build a responsive semantic footer rather than a configurable status string. Design for 52 columns first, preserve actionability by priority, and treat truncation as a final per-item safety mechanism rather than the layout strategy.
