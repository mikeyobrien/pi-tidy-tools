# pi-tidy-tools

**See what your pi agent is doing at a glance.** Restyles [pi](https://github.com/earendil-works/pi-mono)'s
built-in tools into tidy two-line blocks — each led by the agent's own reason
for the call — so the transcript reads like a narrative, not a wall of boxes.

Replaces pi's built-in tool rendering (`read` `write` `edit` `bash` `grep` `find` `ls`)
so every tool call renders as a **compact two-line block** instead of a boxed
multi-line card:

![pi-tidy-tools demo](docs/demo.png)

- **Line 1** — status mark, tool icon/name, and the model's **goal/reasoning** for the call.
- **Line 2** — the concrete target (path/command/pattern) and a colored result summary.

Execution is inherited from the built-in tools **unchanged** — only the TUI
rendering is replaced.

## Reasoning headline

Each wrapped tool gains a required `reasoning` parameter that the model must fill
with the *goal* behind the call (not a restatement of the file or command, which
are already shown). This becomes the line-1 headline, so the left column reads as
a running narrative of *why* each step is happening.

## Expand for detail (`ctrl+o`)

Collapsed blocks show the two-line summary. Expanding a tool (`ctrl+o`,
`app.tools.expand`) appends its full output:

- **edit** — the colored, line-numbered diff
- **bash** — the full (multi-line) command input, then its output
- **read/grep/…** — the raw result text

## `/diff` — last-turn changes

`/diff` (or **`ctrl+shift+o`**) prints a combined, colored diff of every `edit`/`write`
made in the last turn that touched files — a quick recap of what just changed.

> `ctrl+shift+o` also maps to the built-in `app.tree.filter.cycleBackward`; in the
> main transcript it triggers `/diff`. Rebind in `keybindings.json` if you prefer.

## Styling

Mirrors a clean, theme-agnostic palette + icon mapping:

| Tools                    | Icon | Color   |
|--------------------------|------|---------|
| `read` `grep` `find` `ls`| 📖   | cyan    |
| `write` `edit`           | ✏️   | yellow  |
| `bash`                   | ⚡   | magenta |

- Paths collapse `$HOME` → `~`
- `edit` shows `+adds/-dels`; `write` shows byte count; `bash` shows `done` / `exit N` + line count
- `grep`/`find`/`ls` show a `→ N matches/files/entries` count
- Every line is truncated to the live terminal width (ANSI-aware) so nothing wraps past the gutter

Raw ANSI is intentional so the look stays identical across terminal themes.

## Scope

Only the seven built-in tools are restyled. MCP / third-party tools keep their
default rendering — pi does not expose a way to override a foreign tool's renderer
without owning its execution.

## Usage

Quick test:

```bash
pi -e ./index.ts
```

Install as a pi package (add to `~/.pi/agent/settings.json`):

```json
{
  "packages": ["/absolute/path/to/pi-tidy-tools"]
}
```

or drop the directory in `~/.pi/agent/extensions/pi-tidy-tools/`.

## Develop

```bash
npm install
npm run check   # tsc --noEmit
```

## Regenerating the demo image

`docs/demo.png` is generated from **real** renderer output (no hand-typed ANSI):
the demo runs the built-in tools, renders them through the actual extension, and
screenshots the result via headless Chrome.

```bash
bash docs/demo.sh   # requires Google Chrome + ImageMagick
```
