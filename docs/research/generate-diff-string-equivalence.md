# `generateDiffString` equivalence under an omp compatibility fork

**Status:** finding, verified by differential testing

**Date:** 2026-09-22

**Question:** the omp compatibility fork replaces the host import of
`generateDiffString` with a local reimplementation, because omp's rewritten
module graph no longer exports it. Is that reimplementation safe to use on hosts
that _do_ export the original?

**Verdict: no.** The local implementation is not output-equivalent to the host's.
Use the host's export wherever it exists and fall back to the local one only
where it does not.

## Why the question is not academic

`packages/pi-tidy-tools/tool-composition.ts` imports `generateDiffString` from
`@earendil-works/pi-coding-agent` and uses its `.diff` for every write/edit card.
On omp that import aborts extension load, so the fork swapped in a local shim.
The shim is imported **unconditionally**, which means vanilla Pi also silently
switched to the local implementation — while continuing to ship upstream's
`generateDiffString` unused.

Verified host difference:

```
pi 0.87.0  generateDiffString: function
omp        "generateDiffString" present in bundle: false
```

## Differential result

Hand-picked cases do **not** surface the divergence. Ten deliberately chosen
shapes — identical, one substitution, line add, line delete, empty↔content,
no trailing newline, CRLF, unicode, plus a 400-line change — matched byte for
byte:

```
10 match, 0 differ
```

Fuzzing with deterministic pseudo-random line mutations exposes it. 138 cases,
125 match, **13 differ**:

```
cases: 138, match: 125, differ: 13
```

The divergence is structural, not random. When a line is _changed_, the two
implementations attribute the removal and the addition to different sides:

```
fuzz56
  local:  -1 b  -2 :  +1 d   3 :
  host:   -1 b  +1 d   2 :  -3 :
```

The host uses `Diff.diffLines` (a real LCS diff) with `contextLines = 4`; the
local implementation uses a simpler adjacent-pairing algorithm. For pure
insertions and deletions they agree. For `change` regions — the common case in
real edits — they can disagree on which side of the hunk a line lands.

The `firstChangedLine` value agreed in every case; only the rendered body
differs. So this is a display regression, not a correctness one — but it changes
what users see on the host that never needed the shim.

## Consequence

The shim must be a **fallback**, not a replacement:

```ts
const hostDiff =
  typeof host.generateDiffString === "function"
    ? host.generateDiffString
    : localFallback;
```

This keeps Pi's rendered diffs byte-identical to upstream and confines the local
implementation to omp, which is the only host that requires it.

## Reproduction

```js
const { generateDiffString: host } = require("@earendil-works/pi-coding-agent");
// compare against the local implementation over mutated line arrays
```

Compare `JSON.stringify` of both results. Simple substitution cases agree;
multi-line change regions may not. The original differential harness used 120
random mutations plus long-file elision cases at 50/120/200/400/1000/3000 lines.

## Scope note

Established while validating an omp compatibility fork against vanilla Pi 0.87.0.
The fork itself lives outside this repo as a patched vendored copy; the
invariant it produced is recorded in `AGENTS.md`.
