# pi-tidy-footer

A responsive Pi footer for narrow terminals. It keeps repository and capacity information on the left, pins model and context information to the right, and reads Codex quota windows from the `codexbar` CLI.

> **Experimental.** This package is on `main` in [pi-tidy-tools](https://github.com/mikeyobrien/pi-tidy-tools) but is **not published to npm yet**. Layout tiers, status priority, and CodexBar integration may still change before a first release. Prefer a local checkout install and pin to a known commit if you rely on it day to day.

## Install

Install [CodexBar](https://github.com/steipete/CodexBar) so `codexbar` is on `PATH` if you want quota polling, then install from git:

```bash
pi install git:github.com/mikeyobrien/pi-tidy-tools@main
pi install ~/.pi/agent/git/github.com/mikeyobrien/pi-tidy-tools/packages/pi-tidy-footer
```

Other accepted git forms:

```bash
pi install https://github.com/mikeyobrien/pi-tidy-tools@main
pi install git:git@github.com:mikeyobrien/pi-tidy-tools@main
pi install git:github.com/mikeyobrien/pi-tidy-tools@<commit>   # pin experimental builds
```

From an existing local checkout of this repository:

```bash
pi install ./packages/pi-tidy-footer
```

Quota polling is optional: without `codexbar`, the footer still shows branch, model, and context. Use `-l` for project-local installs. After the first npm release, the stable install path will be:

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

## Resources

An optional segment shows CPU, memory, and disk use. It is off by default. Enable it in `~/.pi/agent/pi-tidy-footer.json` (or the file named by `PI_TIDY_FOOTER_CONFIG`):

```json
{
  "resources": {
    "enabled": true,
    "mounts": ["/", "/tmp"],
    "warnPercent": 85
  }
}
```

| Field         | Default         | Meaning                                                 |
| ------------- | --------------- | ------------------------------------------------------- |
| `enabled`     | `false`         | Only `true` turns the segment on.                       |
| `mounts`      | `["/", "/tmp"]` | Paths whose filesystems are reported, in order.         |
| `warnPercent` | `85`            | Readings at or above this value get `!` and warn color. |

The segment reads like this:

```text
cpu 34% · mem 12/31G · / 47% · ! /tmp 100%i
```

- `cpu` is the one-minute load average divided by the logical core count, so it can exceed 100% under load.
- `mem` is used and total memory in GiB. Used memory is total minus available: `MemAvailable` on Linux, and free, inactive, speculative, and purgeable pages from `vm_stat` on macOS.
- Each mount shows the higher of block use and inode use. An `i` suffix means inodes are the higher reading. A filesystem can run out of inodes while most of its space is free, and `df -h` will not show that.

Disk readings come from `fs.statfs`; if that call fails, the footer falls back to `df -P -k` and `df -i`. A mount that cannot be read is left out. Sampling runs in the background at most every five seconds and never inside `render()`. A warning reading moves ahead of routine quota and status fields, the same way pressured quotas do.

Linux and macOS are supported. Config is read when the footer installs, so run `/tidy-footer on` or start a new session after editing it.

## Commands

```text
/tidy-footer status   show footer, CodexBar, and resource segment state
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
2. failed extension states, pressured quotas, and resource readings at or above `warnPercent`, ordered by severity;
3. routine five-hour and seven-day Codex quota usage;
4. routine resource readings, when the segment is enabled;
5. normal extension statuses;
6. cumulative input/output totals when room remains.

Context and quota usage above 70% are prefixed with `!`; above 90% they use `!!`. Warning and error colors reinforce the marker but are not the only signal.

## Research

The design rationale and primary-source references are in the repository's [narrow-screen footer research](https://github.com/mikeyobrien/pi-tidy-tools/blob/main/docs/research/narrow-screen-footer.md).
