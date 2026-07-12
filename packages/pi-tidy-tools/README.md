# pi-tidy-tools

[![npm version](https://img.shields.io/npm/v/%40mobrienv%2Fpi-tidy-tools)](https://www.npmjs.com/package/@mobrienv/pi-tidy-tools)

**See what your pi agent is doing at a glance.** Restyles [pi](https://github.com/earendil-works/pi-mono)'s
built-in tools into compact, configurable blocks so the transcript reads like
a narrative, not a wall of boxes.

Restyles pi's built-in tools (`read` `write` `edit` `bash` `grep` `find` `ls`)
with a two-line default plus optional one-line reasoning and result layouts.

## Before and after

The same successful `read`, `grep`, and `edit` calls rendered by native pi and
pi-tidy-tools:

![Native pi tool cards compared with compact pi-tidy-tools output](docs/comparison.png)

- **Line 1** — status mark, tool icon/name, the model's **goal/reasoning**, and the settled call's compact relative age.
- **Line 2** — the concrete target (path/command/pattern) and a colored result summary.

By default, execution delegates to pi's built-in tools unchanged. When the
optional pi-fff integration below is explicitly set up, legacy `pi-fff` owns
`read`/`grep` execution while tidy owns their schema/rendering; scoped
`@ff-labs/pi-fff` instead adds its own FFF tools while tidy keeps native
`read`/`grep` ownership.

## In action

![pi-tidy-tools transcript showing successful and failed tool calls](docs/demo.png)

## Reasoning headline

In `default` and `reasoning` modes, each wrapped tool gains a required `reasoning`
parameter that the model fills with the *goal* behind the call (not a restatement
of the file or command, which is already shown). `result` mode leaves the native
tool schema unchanged and does not request reasoning.

## Expand for detail (`ctrl+o`)

Collapsed blocks show the two-line summary. Expanding a tool (`ctrl+o`,
`app.tools.expand`) appends its full output:

- **edit** — the colored, line-numbered diff
- **write** — the written content with line numbers
- **bash** — the full (multi-line) command input, then its output
- **read/grep/…** — the raw result text

## `/diff` — last-turn changes

`/diff` (or **`ctrl+shift+o`**) recaps successful `edit`/`write` changes from the
immediately preceding turn as colored line-by-line diffs, including new files and
whole-file overwrites.

![`/diff` recap of the last turn's edit and write changes](docs/diff.png)

> `ctrl+shift+o` also maps to the built-in `app.tree.filter.cycleBackward`; in the
> main transcript it triggers `/diff`. Rebind in `keybindings.json` if you prefer.

## Enable or disable persistently

The extension is enabled by default. Use the management command to change or
inspect its startup state:

```text
/tidy on
/tidy off
/tidy toggle
/tidy status
/tidy mode default
/tidy mode reasoning
/tidy mode result
/tidy mode status
```

Layout modes:

- `default` — reasoning headline, then target and result on line two
- `reasoning` — one line with the reasoning and summarized result
- `result` — one line with the target and summarized result; no reasoning parameter is requested

![Tidy Tools layout modes](docs/modes.png)

A successful change is saved to `~/.pi/agent/pi-tidy-tools.json` and reloads pi's
extensions immediately. While disabled, `/tidy` remains available, but all seven
tool overrides, reasoning prompts, diff hooks, `/diff`, its shortcut, and custom
rendering are absent.

For temporary or managed environments, `PI_TIDY_TOOLS` overrides the file. It
accepts `on`/`off`, `true`/`false`, `yes`/`no`, or `1`/`0`. Unset the variable
before using `/tidy on|off|toggle`; `/tidy status` reports when the override is
active. A missing, unreadable, or malformed config defaults to enabled.

## Optional pi-fff execution

pi-fff is optional and remains a separately installed Pi package. It is not
bundled by, or a peer dependency of, pi-tidy-tools. Two capability profiles are
supported, both on Pi **0.80.6+** and with no upper version bound:

- **Legacy:** [`pi-fff`](https://www.npmjs.com/package/pi-fff) **0.1.12+**;
  captures its enhanced `read`/`grep` and composes tidy presentation.
- **Scoped:** [`@ff-labs/pi-fff`](https://www.npmjs.com/package/@ff-labs/pi-fff)
  **0.6.0+**; replays `ffgrep`, `fffind`, optional `fff-multi-grep`, flags,
  commands, lifecycle, autocomplete, and embedded tool renderers unchanged.
  Tidy continues to own native `read` and `grep`; override mode is rejected
  because its `grep`/`find` names conflict with tidy's owned surface.

```bash
pi install npm:@ff-labs/pi-fff@0.9.6       # user scope
# or: pi install -l npm:@ff-labs/pi-fff@0.9.6  # project scope
# Legacy remains supported: pi install npm:pi-fff@0.1.12
```

Restart Pi, then explicitly let tidy manage pi-fff registration. Legacy setup transfers `read`/`grep` presentation ownership; scoped setup keeps tidy/native `read`/`grep` and replays the separate FFF tools:

```text
/tidy pi-fff setup
/tidy pi-fff status
/tidy pi-fff teardown
```

Setup previews every discovered user/project settings change and requires
confirmation. It first validates every installed participant, then atomically
changes each pi-fff package entry to object form with `extensions: []`. This
prevents standalone pi-fff and tidy's adapter from registering the same tools.
Linked `pi-tidy-tools.pi-fff.json` sidecars preserve each exact prior entry.
After every settings file reaches its target, setup and teardown durably mark all
linked sidecars `reload-pending`, then await Pi's reload. Replacement startup at
the target atomically commits setup sidecars or retires teardown sidecars before
routing tools; successful post-reload cleanup is idempotent. The old controller
frame never initializes routing after a requested or rejected reload. A failed
or aborted reload reports `recovery-pending`, leaves every linked journal pending,
and only the next actual startup finalizes it at that same safe boundary.

### Ownership and scope

`/tidy pi-fff status` reports one of these truthful states:

- `absent` — tidy presents native Pi `read`/`grep`.
- `standalone` — legacy pi-fff owns `read`/`grep`; scoped pi-fff leaves them with tidy/native while loading its own tools. Run setup to remove duplicate-extension risk and establish managed routing.
- `filtered-unmanaged` — neither extension claims them until explicit setup.
- `managed-compatible` — for legacy, pi-fff executes `read`/`grep` and tidy
  owns their schema/rendering; for scoped, status reports
  `tidy/native + pi-fff tools` and tidy owns native `read`/`grep`.
- `managed-invalid` or `recovery-pending` — native Pi owns them; the adapter
  fails closed instead of silently falling back or partly registering.
- `disabled` — native Pi owns them. Turning tidy off never edits Pi package
  settings; the committed sidecars remain available for later teardown.

Pi package precedence still applies by selected identity: a project pi-fff
entry shadows the user entry, with no fallback from a broken project install.
A settings scope containing both package identities (or duplicates) is
ambiguous and rejected. Setup preflights and journals every participant it
discovers; teardown restores the exact source string and entry in each scope.

The exact Pi `0.80.6` × `pi-fff@0.1.12` and Pi `0.80.6` ×
`@ff-labs/pi-fff@0.9.6` tuples are `verified`. Newer tuples at or above their
profile floors are eligible after structural capability validation and
are shown as `forward-compatible/unverified` until that exact tuple passes the
release smoke matrix. This status is not a claim that a newer release is
broken. Release maintainers must run:

```bash
npm run test:pi-fff-release-matrix --workspace @mobrienv/pi-tidy-tools -- --latest
npm run test:pi-fff-tui --workspace @mobrienv/pi-tidy-tools
```

The first command requires npm registry access and tests baseline/newest mixed
tuples; an unavailable registry is a **blocked release gate**, never a silently
skipped pass. The ordinary installed fixture is hermetic with respect to tuple
selection and runs the pinned baseline.

### Drift, recovery, and removal

Interrupted setup/teardown is recovered at startup before ordinary ownership is
claimed. A complete linked `reload-pending` transition already at its target is
finalized immediately; an earlier interruption may ask for one `/reload`. Drift
or malformed/missing linked state fails closed and `/tidy pi-fff status` reports
the concrete settings paths requiring manual attention. Do not edit managed
package entries or sidecars independently.

Always run `/tidy pi-fff teardown` **before** removing pi-tidy-tools or pi-fff.
Teardown restores the exact prior package entries, including sibling fields and
standalone extension filters. If automatic recovery says manual restoration is
required, inspect every linked `pi-tidy-tools.pi-fff.json`, restore each
`priorEntry` at its recorded `entryIndex` in the recorded `settingsPath`, remove
the sidecars only after all scopes agree, and then run `/reload`. Keep backups
and do not copy a project entry into the user scope (or vice versa).

### Editor caveats

Legacy pi-fff `0.1.12` installs a custom autocomplete editor and does not compose with
another custom editor; it is last-writer-wins. Tidy warns when one is already
installed. Disable one editor feature and `/reload`. Turning autocomplete off
in `/fff-features` persists the setting but the current editor remains active
until `/reload`. These are pi-fff editor/lifecycle constraints; tidy does not
take over or mask them.

## Styling

Mirrors a clean, theme-agnostic palette + icon mapping:

| Tools                    | Icon | Color   |
|--------------------------|------|---------|
| `read` `grep` `find` `ls`| 📖   | cyan    |
| `write` `edit`           | ✏️   | yellow  |
| `bash`                   | ⚡   | magenta |

- Settled calls show a compact completion age such as `(<1m ago)` or `(1h3m ago)`; it keeps advancing while displayed, including after `/reload` or session resume, and the timestamp persists with the result
- Paths collapse `$HOME` → `~`
- `edit` shows `+adds/-dels`; text `write` shows line count; `bash` shows status + elapsed time
- `grep` shows `N matches in M files`; `find`/`ls` show file or entry counts
- Every line is truncated to the live terminal width (ANSI-aware) so nothing wraps past the gutter
- Pi's native pending/success/error background colors remain, without restoring its padding or extra spacing

Raw ANSI is intentional for the foreground palette; tool backgrounds follow the active Pi theme.

## Scope

Only the seven built-in tools are restyled. MCP / third-party tools keep their
default rendering — pi does not expose a way to override a foreign tool's renderer
without owning its execution.

## Install

Install the published [npm package](https://www.npmjs.com/package/@mobrienv/pi-tidy-tools) with pi:

```bash
pi install npm:@mobrienv/pi-tidy-tools
```

Restart pi or run `/reload` in an existing session. To update later:

```bash
pi update --extension npm:@mobrienv/pi-tidy-tools
```

To remove it:

```bash
pi remove npm:@mobrienv/pi-tidy-tools
```

## Local development

From the monorepo root, quick-test this workspace:

```bash
pi -e ./packages/pi-tidy-tools/index.ts
```

Or install the workspace through `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/absolute/path/to/repo/packages/pi-tidy-tools"]
}
```

## Develop

Run all workspaces from the repository root:

```bash
npm install
npm test
npm run check
```

Or target this package with `--workspace @mobrienv/pi-tidy-tools`.

## Regenerating screenshots

`docs/comparison.png`, `docs/demo.png`, `docs/diff.png`, and `docs/modes.png` are
generated from **real** renderer output (no hand-typed ANSI): the scripts run the
built-in tools, render them through the actual extension (or native pi cards for
the comparison), and screenshot the result via headless Chrome.

```bash
bash packages/pi-tidy-tools/docs/comparison.sh # native vs tidy comparison
bash packages/pi-tidy-tools/docs/demo.sh       # full tidy transcript
bash packages/pi-tidy-tools/docs/diff.sh       # /diff last-turn recap
bash packages/pi-tidy-tools/docs/modes.sh      # layout-mode comparison
```

All four generators require Google Chrome/Chromium and ImageMagick.
