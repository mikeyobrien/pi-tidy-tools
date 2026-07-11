---
name: qa-loop
description: Run a human-gated QA and repair loop for pi-tidy-tools.
disable-model-invocation: true
compatibility: Requires the pi-tidy-tools repository, its development dependencies, the subagent tool, and external agent-tty 0.5.0 running on Node 24-26.
---

# Pi Tidy QA Loop

Use a sequential dyad: one fresh **QA agent** exhausts the product surface, then one **fixer agent** repairs only the findings the human selects. The human is the release gate between them.

## 1. Charter the run

Interview the human about the feature or use-case. Ask one short question at a time and recover repository facts yourself. Establish:

- the user-visible promise and real-user entry point
- relevant environment, configuration, and starting state
- happy paths, boundaries, failures, reload/resume behavior, and visual states
- the acceptance oracle: what counts as correct
- safety constraints for destructive, networked, credentialed, or publishing actions
- the hermetic boundary: declared external inputs and permitted mutable paths

Summarize these as a QA charter with stable kebab-case acceptance requirement IDs and ask the human to confirm or amend it. Once confirmed, read `.pi/skills/qa-loop/EVENT_LEDGER.md`, choose a filename-safe run ID, create `.pi/qa-runs/<run-id>/fragments/run-started.jsonl`, and initialize the canonical ledger with `scripts/qa-ledger.mjs init` as documented there.

This step is complete when every item has an explicit answer or named out-of-scope boundary, the human confirms the charter, and the validated ledger contains `run.started`.

## 2. Establish the baseline

Read `.pi/skills/pi-tidy-tools-ethos/SKILL.md` and the charter-relevant package documentation. Inspect `git status --short`; treat existing changes as user-owned.

Use `.pi/skills/qa-loop/scripts/pi-tui-harness.sh` as the canonical real-user driver. It wraps external `agent-tty@0.5.0` with an isolated Home Registry, a dedicated Pi session directory, literal keystrokes, Ghostty-rendered waits, controlled viewport sizes, semantic text snapshots, and native Ghostty PNG screenshots. `agent-tty` remains a QA prerequisite—not a product dependency—because it requires Node 24-26 while the product supports Node 22.19+. Run:

```bash
.pi/skills/qa-loop/scripts/pi-tui-harness.sh preflight
.pi/skills/qa-loop/scripts/pi-tui-harness.sh reset
```

The fixed viewport matrix is `120x36` baseline and `72x24` narrow. Drive text with `send`, control keys with `key`, synchronization with `wait`, evidence with `capture`, state transitions with `resize`, and cleanup with `stop`. Every wrapper command emits a stable JSON envelope. `wait` observes the rendered screen through agent-tty's semantic Ghostty backend; `capture` writes a semantic `.txt` snapshot and canonical `ghostty-web` `.png` screenshot. Poll for user-visible state instead of sleeping. Use shell tools only for fixtures, process inspection, automated supporting checks, and evidence analysis. If the canonical harness cannot exercise a charter requirement, mark that surface BLOCKED and ask the human to amend the tooling contract.

### Hermetic contract

Every scenario starts from declared state and is reproducible independently. Keep mutable QA state within `/tmp/pi-tidy-qa/` and `.pi/qa-runs/<run-id>/`; the fixer may additionally change only its authorized worktree scope. Treat the checked-out source, pinned harness, declared provider/model credentials, and explicitly named network calls as inputs. Record every external input in the charter or evidence. Use controlled fixtures, fixed viewport/environment values, isolated HOME/config/session paths, observable-state waits, and explicit cleanup. Compare pre/post worktree and user-configuration state so leaked mutation becomes a finding. Real-provider calls are the declared external dependency for product interaction; all automated regression tests use fakes, temporary directories, controlled clocks, and zero network/provider access, and pass independently of execution order.

Copy harness `.txt` and `.png` captures used as evidence from `/tmp/pi-tidy-qa/artifacts/` into the run's `artifacts/` directory. Treat the native PNG as canonical visual evidence; do not convert ANSI to HTML or reconstruct terminal rows with CSS. Record the reported Pi, agent-tty, and agent-tty Node versions plus `/tmp/pi-tidy-qa/agent-tty` in `run.started`.

This step is complete when preflight passes, external inputs and permitted mutable paths are recorded, pre-run state is captured, and the QA agent can be given the charter, product entry points, safety boundary, harness contract, run directory, round number, available finding IDs, and current worktree state without guessing.

## 3. Dispatch the QA agent

Append `round.started`, then invoke exactly one subagent with the prompt below, filled with the current charter and prior-round context. The QA agent is read-only with respect to product source. It may create isolated temporary fixtures, evidence, and its assigned QA fragment, and must clean up anything that could affect later observations.

```text
You are the QA half of a closed-loop product dyad for pi-tidy-tools.

QA charter:
<verbatim charter>

Prior fixes or unresolved findings:
<verbatim context, or "first round">

Current worktree state:
<git status --short>

Ledger assignment:
- Run directory: <run directory>
- Round: <round number>
- QA fragment: <run directory>/fragments/round-<NNN>-qa.jsonl
- Existing findings and next available finding ID: <IDs>

Read .pi/skills/pi-tidy-tools-ethos/SKILL.md, .pi/skills/qa-loop/EVENT_LEDGER.md, ledger-types.d.ts, and the relevant product docs before testing. Act like a real user through .pi/skills/qa-loop/scripts/pi-tui-harness.sh. This is the sole product-interaction driver: start at 120x36, use literal send/key input, poll the Ghostty-rendered screen with wait, capture native Ghostty PNG and semantic text evidence for every finding, repeat applicable scenarios at 72x24, and stop cleanly. Use the isolated session directory for reload/resume scenarios. Shell tools may prepare fixtures, inspect processes, run supporting checks, and analyze captures; they do not replace harness interaction or reconstruct screenshots from ANSI. Report an unmet interaction need as BLOCKED rather than improvising another driver. A passing automated test is supporting evidence, not product QA.

Be adversarial and relentless. Inventory the charter's surface, then exercise every applicable state and transition: happy path, boundaries, malformed input, failure and cancellation, running and settled state, collapsed and expanded output, reload/resume, repetition, concurrency, and recovery. Add discovered states to the inventory. Synchronize on visible state rather than fixed delays. For each suspected issue, reproduce it from a reset or captured state and distinguish product behavior from harness or environment failure.

Enforce the hermetic contract: begin each scenario from declared state, use only controlled fixtures and permitted mutable paths, record external inputs, and compare pre/post worktree and user-configuration state. Preserve product source and pre-existing worktree changes. Report leaked state or undeclared dependencies as findings.

Write the assigned JSONL fragment using only `finding.raised` and `scenario.checked` events from the closed algebra. Emit one scenario event for every inventoried surface/state. Copy referenced captures into the run's `artifacts/` directory. Omit `seq`; the parent owns canonical sequencing. Reuse existing finding IDs when rediscovered and allocate new IDs monotonically from the supplied next ID.

Return the fragment path plus one of:

A. A numbered findings list matching the fragment's finding IDs. Every finding must include severity, confidence, user-visible actual versus expected behavior, exact reproduction, evidence, recommended fix behavior, and a checkable acceptance test. Follow it with the fragment's coverage ledger assigning every inventoried surface/state PASS, FINDING ID, or BLOCKED.

B. NO FINDINGS, followed by the same exhaustive coverage ledger and evidence for the exercised production paths.

Number only actionable findings. Report blocked coverage explicitly; never call blocked coverage exhausted.
```

Audit the response and fragment against the charter. Send the QA agent back for missing evidence or unaccounted surfaces before accepting its fragment. Append it with `qa-ledger.mjs`, then run `validate` and `report`. This step is complete only when every charter item and discovered surface has PASS, FINDING, or BLOCKED evidence in the canonical ledger.

## 4. Gate on human selection

Present the findings as a concise numbered list, preserving the QA numbers. Add a recommended selection based on severity, confidence, user impact, and repair risk. Include the quick replies:

- `recommended` — fix the recommended numbers
- `all` — fix every finding
- `1,3-5` — fix any combination of numbers
- `retest` — run another QA round without repairs
- `close` — sign off and stop, listing any accepted open findings

Wait for the human. Resolve ambiguous selections with one short question. Normalize the response into one `human.selected` event and append, validate, and render it. This step is complete when the human decision is present in the canonical ledger or there are no findings.

## 5. Dispatch the fixer agent

For selected findings, invoke exactly one fresh fixer subagent with this prompt:

```text
You are the fixer half of a closed-loop product dyad for pi-tidy-tools.

QA charter:
<verbatim charter>

Authorized findings:
<verbatim selected findings, including evidence and acceptance tests>

Current worktree state:
<git status --short>

Ledger assignment:
- Run directory: <run directory>
- Round: <round number>
- Fixer fragment: <run directory>/fragments/round-<NNN>-fixer.jsonl

Read .pi/skills/pi-tidy-tools-ethos/SKILL.md, .pi/skills/qa-loop/EVENT_LEDGER.md, and ledger-types.d.ts. Resolve every authorized finding and only that scope. Preserve user-owned changes and understand the current diff before editing. Work test-first: reproduce each issue with focused coverage, implement the smallest extension-owned correction, and prove each acceptance test. Every regression test is hermetic: temporary state, fake RPC/providers, controlled time where relevant, zero network access, no user configuration, and order-independent results. Exercise the applicable visual and lifecycle matrix. Update public documentation and regenerate/inspect real-renderer screenshots when the contract is public or visual.

Run focused checks while iterating, then run npm test, npm run check, and git diff --check. Inspect the complete diff.

Write the assigned JSONL fragment with exactly one `fix.applied` event for every repaired finding and omit `seq`. Return the fragment path plus a numbered resolution ledger matching the finding IDs: root cause, files changed, acceptance evidence, and residual risk. Report any true blocker with concrete evidence; never emit `verification.recorded` or mark an unverified finding resolved—the parent owns verification.
```

Audit every selected number against the worktree, acceptance test, and fixer evidence. Append the fixer fragment, then append one parent-owned `verification.recorded` event per selected finding using observed evidence. If repair validation fails, send the failure evidence to a fresh fixer agent under the same authorization. Ask the human only when a genuine product decision or external action is required. Append, validate, and render after each accepted fragment or parent event.

This step is complete when every selected finding has a canonical `fix.applied` and `verification.recorded` event, with verification passed or explicitly blocked.

## 6. Close the loop

Append `round.closed` with the reducer-required outcome. After verified repairs, dispatch a fresh QA agent from step 3. It must retest the entire charter and search for regressions, not merely check the repaired examples. Repeat the human gate and fixer cycle.

Stop when either:

- the QA agent returns `NO FINDINGS` with a complete, unblocked coverage ledger and the parent verifies the final checks; or
- the human replies `close`.

Append `run.closed` with final verification commands, worktree status, and every human-accepted open finding. Run `qa-ledger.mjs validate` and `report`; present the generated `report.md` path and its concise closure summary.

The loop is complete only when one stopping condition is explicit, the reducer accepts closure, and the generated report accounts for every event and finding in `events.jsonl`.
