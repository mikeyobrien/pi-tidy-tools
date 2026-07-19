# pi-tidy-footer

A responsive Pi footer for narrow terminals. It keeps repository and capacity information on the left, pins model and context information to the right, and reads Codex quota windows from the `codexbar` CLI.

> **Experimental.** This package is on `main` in [pi-tidy-tools](https://github.com/mikeyobrien/pi-tidy-tools) but is **not published to npm yet**. Layout tiers, status priority, and CodexBar integration may still change before a first release. Prefer a local checkout install and pin to a known commit if you rely on it day to day.

## Install

Install [CodexBar](https://github.com/steipete/CodexBar) so `codexbar` is on `PATH` if you want quota polling, then install the extension from a monorepo checkout:

```bash
git clone https://github.com/mikeyobrien/pi-tidy-tools.git
pi install ./pi-tidy-tools/packages/pi-tidy-footer
```

From inside a clone of this repository:

```bash
pi install ./packages/pi-tidy-footer
```

Quota polling is optional: without `codexbar`, the footer still shows branch, model, and context. After the first npm release, the stable install path will be:

```bash
pi install npm:@mobrienv/pi-tidy-footer
```

## Layout

At a 52–56-column Termux width, the footer renders as two justified lines:

```text
main                                      sol/max
5h 3% · 7d 20%                            ctx 28%
```

Active extension statuses fill unused space on the lower left. The right side remains anchored to the terminal edge. At wider widths, the location and context window expand and cumulative input/output totals appear when space remains.

The footer composes semantic fields before styling. It measures ANSI and Unicode display cells with Pi's TUI utilities, gives the left side the flexible budget, and applies truncation only there. Every completed line has a final width guard.

## CodexBar

The extension runs this command in the background:

```bash
codexbar usage \
  --provider codex \
  --source cli \
  --format json \
  --json-only \
  --no-color
```

Polling happens every five minutes and never inside `render()`. A request is killed after 45 seconds, output is capped at 1 MB, and the last successful quota snapshot remains visible during a transient failure. The footer does not read Codex credentials itself.

Run `/tidy-footer refresh` to request an immediate update.

## Commands

```text
/tidy-footer status   show footer and CodexBar state
/tidy-footer refresh  refresh Codex quota data
/tidy-footer on       enable the responsive footer
/tidy-footer default  restore Pi's built-in footer
```

## Priority

The fixed right-side fields are:

1. model and thinking level;
2. context percentage and warning marker.

The flexible left side is filled in this order:

1. repository branch or directory;
2. failed extension states and pressured quotas, ordered by severity;
3. routine five-hour and seven-day Codex quota usage;
4. normal extension statuses;
5. cumulative input/output totals when room remains.

Context and quota usage above 70% are prefixed with `!`; above 90% they use `!!`. Warning and error colors reinforce the marker but are not the only signal.

## Research

The design rationale and primary-source references are in the repository's [narrow-screen footer research](https://github.com/mikeyobrien/pi-tidy-tools/blob/main/docs/research/narrow-screen-footer.md).
