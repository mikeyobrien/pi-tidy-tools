# Renderer theme argument position is host-specific

**Status:** finding from an out-of-tree compatibility port; recorded as a hazard

**Date:** 2026-09-22

**Scope note:** this repository's renderers declare `(args, theme, context)` and
`(result, options, theme, context)`, matching Pi. **There is no bug here today.**
The finding describes what breaks if those signatures are re-indexed to support a
second host, which is exactly what an out-of-tree omp port did.

## The shapes

| Host | `renderCall`             | `renderResult`                      |
| ---- | ------------------------ | ----------------------------------- |
| Pi   | `(args, theme, context)` | `(result, options, theme, context)` |
| omp  | `(args, options, theme)` | `(result, options, theme, args)`    |

The theme's position differs, and so does what occupies the other slots. A
renderer rewritten as `(args, options, theme)` reads a render _context_ as the
theme on Pi, because Pi puts the theme second.

## Why it is fatal, not cosmetic

Calling `theme.bg(...)` on a context object throws. Renderer exceptions are not
contained on Pi: it reports an `uncaughtException` and **exits**, taking the
session with it.

```
TypeError: theme.bg is not a function. (In 'theme.bg(background, text)', 'theme.bg' is undefined)
      at pi-tidy-tools/index.ts:539:31
pi exiting due to uncaughtException
```

The port hit exactly this after re-indexing the renderers for omp.

## Why ordinary testing misses it

Every non-interactive check passes while the TUI dies on the first tool call:

- `-p` / `--print` headless mode never constructs a renderer.
- `--mode json` emits tool payloads without rendering them. Those payloads come
  from `execute`, which is independent of the renderer, so schema, executor, and
  diff behavior all verify green.
- `npm test` exercises `buildToolBlock` and the renderers directly, but with
  test-supplied arguments — it cannot detect that the _host_ passes them
  differently.

An interactive session on each host is the only check that reaches this path.

## If a second host is ever supported

Locate the theme by shape rather than position, and never assume it exists:

```ts
/** A theme is an object carrying a callable `bg`. */
const asTheme = (v: unknown): RenderTheme | undefined =>
  typeof v === "object" && v !== null && typeof (v as any).bg === "function"
    ? (v as RenderTheme)
    : undefined;

/** First argument that is actually a theme, or undefined. */
const findTheme = (...candidates: unknown[]) => {
  for (const c of candidates) {
    const t = asTheme(c);
    if (t) return t;
  }
  return undefined;
};

/** Never throw from a renderer. */
const withBackground = (
  theme: RenderTheme | undefined,
  name: string,
  text: string
) => {
  if (!theme) return text;
  try {
    return theme.bg(name, text);
  } catch {
    return text;
  }
};
```

Both the "no theme supplied" and "theme throws" paths must degrade to unstyled
text: the cost of an uncaught renderer exception is the whole process.

## Verified

Interactive TUI on vanilla Pi 0.87.0 and on omp with the same build, after the
port adopted shape-based lookup: Pi renders `→ +1/-1` and `done in <1s`, omp
unchanged.

## Related

The same host split governs the renderer _argument contents_, not just positions.
Position alone is not a reliable discriminator for either the theme or the
context.
