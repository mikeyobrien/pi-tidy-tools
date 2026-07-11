---
name: pi-tidy-tools-ethos
description: Narrative guardrails for @mobrienv/pi-tidy-tools. Use when designing, implementing, reviewing, or documenting non-release changes to that package.
compatibility: Requires the pi-tidy-tools repository and Node.js 22.19+.
---

# Pi Tidy Tools Ethos

## Narrative

The transcript is a **narrative**. Each tool call advances it with distinct intent, target, state, and outcome in a compact inline block.

Resolve trade-offs in this order:

1. Truthful behavior and state
2. At-a-glance comprehension
3. Useful detail on demand
4. Compactness
5. Decoration

## Process

### 1. Frame the promise

State the change as one user-observable sentence, then classify the affected branches: schema/rendering, execution/lifecycle, configuration, or documentation.

Complete this step when the sentence names what a user will notice and every affected branch is named.

### 2. Recover the current contract

Read `packages/pi-tidy-tools/README.md`, then follow each affected branch:

- Schema/rendering: `packages/pi-tidy-tools/index.ts`, `packages/pi-tidy-tools/render.ts`, and renderer tests
- Execution/lifecycle: delegation and event handling in `packages/pi-tidy-tools/index.ts`, plus lifecycle tests
- Configuration: `packages/pi-tidy-tools/config.ts` and config tests
- Documentation or compatibility: the package manifest and affected generators under `packages/pi-tidy-tools/docs/`

Treat current behavior and tests as the operational source of truth; use this skill as the decision lens. Trace each affected promise to its authoritative code or documentation and identify the test that protects each behavior.

Complete this step when every affected promise has an authoritative source and every affected behavior has existing or planned coverage.

### 3. Preserve the adapter contracts

Make the smallest extension-owned change that satisfies the promise. For a review-only run, evaluate the change against the same contracts instead of editing it.

- **Semantic transparency:** built-in execution behavior stays native. `write` may instrument its per-call filesystem operations only to produce behavior-compatible diffs.
- **Reason first:** `default` and `reasoning` put a short goal first in the schema and strip it before execution; `result` keeps the native schema and omits reasoning.
- **Progressive disclosure:** collapsed output stays scan-friendly; expansion prefers useful source detail over generic success prose.
- **Decision utility:** summaries answer the next useful question with status, duration, or meaningful counts.
- **Terminal truth:** ANSI-aware lines fit the live viewport, preserve the useful result tail, and keep native state backgrounds continuous.
- **Live truth:** running state appears promptly, elapsed time advances, settled output replaces the running block, and call-scoped state is cleared at its lifecycle boundary.
- **Reversibility:** each mode keeps its distinct contract; disabled startup leaves only `/tidy`; configuration changes preserve precedence, provenance, sibling settings, and atomic writes.
- **Ownership:** styling remains limited to the seven owned built-ins. Inline, execution-ordered rendering remains the product shape.
- **Turn locality:** `/diff` represents successful `edit` and `write` changes from the immediately preceding turn.

Complete this step when every affected contract is either preserved by the implementation or reported as a concrete review finding.

### 4. Prove the promise

Add focused regression coverage for each changed invariant. Exercise the applicable matrix: running/settled, success/error, collapsed/expanded, narrow width, layout modes, disabled mode, and turn boundaries.

Update `packages/pi-tidy-tools/README.md` when the public contract changes. For a visual change, regenerate the affected package screenshot from the real renderer and inspect the image. Inspect `git status --short` and the complete diff for accidental scope.

Run:

```bash
npm test
npm run check
git diff --check
```

Complete the task only when every affected invariant is covered, all applicable checks pass, and residual risks are reported.
