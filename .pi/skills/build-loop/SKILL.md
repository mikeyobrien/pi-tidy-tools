---
name: build-loop
description: Build and independently verify one ready implementation ticket through a human-gated repair loop.
disable-model-invocation: true
compatibility: Requires the pi-tidy-tools repository, its development dependencies, the subagent tool, configured issue-tracker access, Git, and util-linux flock.
---

# Pi Tidy Build Loop

Build exactly one unblocked implementation ticket per manually invoked run. A fresh builder or repairer changes only authorized scope, the parent owns canonical state and mechanical verification, and a fresh read-only verifier accounts for the complete acceptance contract. The human controls acceptance, revision, retesting, and stopping.

Ticket acceptance is not product sign-off. After the parent specification's complete ticket chain closes, prepare a handoff to `qa-loop` for assembled real-user behavior.

## Non-negotiable ownership

- One run handles one ticket. Never continue into another ticket in the same run or context.
- Existing staged, unstaged, and untracked changes are user-owned unless the confirmed charter explicitly attributes them to this ticket.
- Builders and repairers modify only authorized product scope and their assigned fragment and artifact paths.
- Acceptance verifiers remain read-only with respect to product source, tests, documentation, dependencies, Git metadata, user configuration, and tracker state.
- Only the parent sequences and appends canonical events, runs canonical mechanical verification, classifies repair authorization, commits, changes tracker state, and closes attempts, tickets, and runs.
- No subagent stages, unstages, commits, resets, restores, checks out, stashes, cleans, rebases, amends, or mutates the issue tracker.
- Never close or modify the parent specification.
- Never discard, overwrite, reformat, stage, or commit user-owned changes.
- A subagent's checks are evidence about its work, not canonical verification.
- Delegated Pi processes inherit `PI_TIDY_SUBAGENT_CHILD=1`. When builders, repairers, or verifiers run repository tests that instantiate the subagent extension, invoke that test command with only this sentinel unset (for example `env -u PI_TIDY_SUBAGENT_CHILD npm test`); never alter the parent environment. Parent canonical checks run normally.

## 1. Resolve one ready ticket

If the human supplied a ticket, fetch its full body and comments. Otherwise inspect the configured tracker, present the ready frontier, and ask the human to choose exactly one ticket. Never choose silently.

Read the issue-tracker configuration when present, the project ethos, the ticket, its complete parent specification, relevant package documentation, current source and tests, and declared blockers. For this repository, GitHub issue bodies use `## Parent` and `## Blocked by`; verify every blocker directly in the tracker.

Refuse a ticket that is missing, closed, ambiguous, lacks one unambiguous parent, lacks acceptance criteria, is not marked ready, or has any open blocker.

Normalize acceptance criteria in source order as `AC-001`, `AC-002`, and so on without changing their text. For every criterion select the highest practical seam:

1. public package or tool interface
2. CLI or integration interface with deterministic fake adapters
3. a lower internal seam only when the public seam cannot expose the behavior
4. the canonical QA TUI harness only for explicitly visual or interactive criteria

Charter the run with:

- exact ticket and parent identities, URLs, titles, states, and source text
- user-visible outcome
- stable acceptance criteria and selected seams
- focused checks plus required repository checks
- mutable product paths and isolated run-state paths
- safety constraints, external inputs, and named out-of-scope work
- exact staged, unstaged, and untracked starting state
- ownership attribution for every pre-existing change

The normal repository checks are:

```bash
npm test
npm run check
git diff --check
```

Add focused ticket checks before them. Include a worktree scope audit as canonical parent evidence even though it is not a shell command.

Summarize the charter and ask the human to confirm or amend it. After confirmation, choose a filename-safe run ID, create `.pi/build-runs/<run-id>/fragments/` and `artifacts/`, and snapshot the index plus every declared user-owned staged, unstaged, and untracked path without overwriting prior evidence:

```bash
.pi/skills/build-loop/scripts/worktree-audit.mjs snapshot <run-dir>/artifacts/worktree-baseline.json <user-owned-path ...>
```

Read `.pi/skills/build-loop/EVENT_LEDGER.md` and `.pi/skills/build-loop/ledger-types.d.ts`, write a parent-owned `run.started` fragment referencing that baseline, and initialize the ledger:

```bash
.pi/skills/build-loop/scripts/build-ledger.mjs init <run-dir> <run-started-fragment>
```

Append parent-owned `ticket.started` evidence proving the ticket is on the dependency frontier. Validate and render after every accepted fragment:

```bash
.pi/skills/build-loop/scripts/build-ledger.mjs append <run-dir> <fragment>
.pi/skills/build-loop/scripts/build-ledger.mjs validate <run-dir>
.pi/skills/build-loop/scripts/build-ledger.mjs report <run-dir>
```

This phase is complete only when canonical history contains `run.started` and `ticket.started`, every starting change has an owner, and the human-confirmed charter contains a seam and evidence plan for every criterion.

## 2. Dispatch a fresh builder

Append parent-owned `attempt.started` with kind `initial` or `revision`, a fresh agent ID, and any exact human revision direction. Invoke exactly one subagent with the builder prompt below.

Audit its response, worktree, and fragment before append. Reject missing criterion accounting, undeclared files, index mutation, user-owned changes, forbidden commands, or fragment events outside builder ownership. A builder may emit only `implementation.applied`. When its mode is `blocked`, append one parent-authored `failure.raised` with source kind `agent`, source ID equal to the assigned agent ID, and a non-repairable classification; close the attempt as blocked without inventing mechanical evidence, then append `run.blocked`.

### Builder prompt

```text
You are the builder for one ticket-scoped attempt in the pi-tidy-tools build loop.

Active ticket contract:
<verbatim ticket title, URL, body, comments, and AC mappings>

Parent specification:
<verbatim parent title, URL, and body>

Confirmed run charter:
<verbatim charter, seams, mutable and prohibited scope, safety, external inputs, and required checks>

Human revision direction:
<verbatim direction, or "none">

Current repository state:
<git status --short>
<git diff --stat>
<git diff --cached --stat>

User-owned starting changes:
<verbatim ownership inventory>

Prior context:
<prior attempt and failures, or "first attempt">

Ledger assignment:
- Run directory: <run directory>
- Attempt: <attempt number>
- Agent ID: <fresh agent ID>
- Builder fragment: <run directory>/fragments/attempt-<NNN>-builder.jsonl
- Artifact directory: <run directory>/artifacts/

Read .pi/skills/pi-tidy-tools-ethos/SKILL.md, .pi/skills/build-loop/EVENT_LEDGER.md, .pi/skills/build-loop/ledger-types.d.ts, relevant package documentation, and the complete current diff before editing.

Implement exactly this ticket and no follow-up ticket. Preserve every user-owned staged, unstaged, and untracked change. Modify only charter-authorized product paths plus your assigned fragment and artifact paths. Do not stage, unstage, commit, reset, restore, checkout, stash, clean, rebase, amend Git metadata, install or update dependencies without explicit charter authorization, publish, or mutate the issue tracker.

Work test-first at each criterion's agreed seam. Establish focused failing evidence where behavior lacks coverage, make the smallest extension-owned correction, and run focused checks. Keep automated tests hermetic: temporary state, fake providers and RPC, controlled clocks where relevant, zero network or credentials, no user configuration, and order-independent execution. Use the canonical TUI harness only when the charter explicitly requires visual or interaction acceptance.

Inspect the complete final diff and worktree status. If preserving user work conflicts with the ticket, expected behavior is ambiguous, scope must expand, or external action is needed, stop rather than improvising. Emit `implementation.applied` with mode `blocked`, no files or tests, and concrete blocker evidence; the parent will classify the agent blocker and close the attempt without fabricated mechanical checks.

Otherwise write exactly one `implementation.applied` event with mode `changed`, actor builder, your exact attempt and agent ID, changed files, tests, summary, residual risk, and evidence. Omit seq. Emit no parent, verifier, repair, human, commit, tracker, ticket-closure, or run-closure events.

Return the fragment path and a criterion-oriented ledger containing each AC ID, behavior implemented, files changed, tests added or updated, commands and observed outcomes, complete changed-file list, residual risks, and blockers. Never declare the ticket verified, accepted, committed, closed, or complete.
```

## 3. Perform parent-owned mechanical verification

After accepting the implementation fragment, the parent directly:

1. captures staged, unstaged, and untracked state
2. compares it with the run baseline and prior accepted attempt
3. proves user-owned bytes and the complete index remain preserved by running `.pi/skills/build-loop/scripts/worktree-audit.mjs compare <run-dir>/artifacts/worktree-baseline.json`
4. rejects changes outside mutable scope, index mutation, undeclared generated state, and changes belonging to blocked tickets
5. runs every focused and repository check from the charter
6. inspects the complete ticket delta and worktree status
7. writes `<run-dir>/artifacts/accepted-focused-plan.json` with `.pi/skills/build-loop/scripts/focused-plan.mjs <plan-file> <exact-ticket-file ...>` after all checks pass; inspect and reference its parent/tree/file set as mechanical evidence
8. records each command's status, exit code, evidence, accepted focused plan, exact current ticket-owned file set, and scope audit in one `mechanical.verification.recorded` event

Do not infer success from builder output. If any check or scope audit fails or blocks, skip acceptance verification and record one matching parent-authored `failure.raised` per non-pass source, using `sourceId: "scope-audit"` for scope and `verifierId: "parent"`. When a resumed mechanical BF source passes, record its matching parent-authored `failure.verification.recorded` before acceptance. Allocate or reuse stable `BF-001` IDs, then close the attempt with the reducer-derived outcome.

A failure is automatically repairable only when its expected behavior is already unambiguously required by the active ticket or parent and the repair remains within mutable scope. Classify missing decisions, scope expansion, and external action distinctly; they require human or external resolution.

## 4. Dispatch a fresh acceptance verifier

Only after all mechanical checks pass and scope is clean, append `acceptance.started` with a fresh verifier ID. Invoke exactly one read-only subagent with the verifier prompt below.

Audit its criterion coverage, seams, evidence, stable failure identity, and fragment ownership. The verifier emits events in reducer order: every `criterion.checked` first; then all acceptance-sourced `failure.raised` events; then every required independent `failure.verification.recorded` for authorized repairs or resumed blockers; finally terminal `acceptance.closed` after complete accounting. It never edits product files or emits parent-owned events.

### Acceptance verifier prompt

```text
You are the fresh independent acceptance verifier for one ticket-scoped attempt in the pi-tidy-tools build loop. You did not implement this attempt. Treat builder and repairer claims as leads, not proof.

Active ticket contract:
<verbatim ticket and AC mappings>

Parent specification:
<verbatim parent specification>

Confirmed run charter:
<verbatim charter, selected seam per AC, mutable scope, safety, and external-input contract>

Parent-owned mechanical evidence:
<verbatim command results, scope audit, worktree comparison, and artifact references>

Implementation context:
<builder or repair summaries, changed files, prior BF IDs, and any resumed BF IDs awaiting fresh verification>

Current repository state:
<git status --short>
<git diff --stat>
<git diff --cached --stat>

Failure identity assignment:
- Existing failures: <BF definitions, or "none">
- Authorized repaired failures requiring independent verification: <IDs, or "none">
- Next available failure ID: <BF-NNN>

Ledger assignment:
- Run directory: <run directory>
- Attempt: <attempt number>
- Verifier ID: <fresh verifier ID>
- Verifier fragment: <run directory>/fragments/attempt-<NNN>-acceptance.jsonl
- Artifact directory: <run directory>/artifacts/

Read .pi/skills/pi-tidy-tools-ethos/SKILL.md, .pi/skills/build-loop/EVENT_LEDGER.md, .pi/skills/build-loop/ledger-types.d.ts, relevant product documentation, the complete diff, and parent evidence before reviewing.

Remain read-only with respect to product source, tests, documentation, dependencies, Git metadata, user configuration, and tracker state. Write only your assigned fragment and evidence artifacts. Do not install, format, update, publish, or run commands that write outside charter-approved temporary or run paths.

Independently classify every AC exactly once at its agreed highest seam:
- pass: direct evidence demonstrates the criterion
- fail: observed behavior contradicts the criterion
- blocked: required evidence cannot be obtained inside the declared environment or safety contract

Missing evidence is not a pass. Code inspection, builder assertions, passing lower-level tests, or parent command success alone are insufficient when a criterion requires public or user-visible behavior. Reassess the complete ticket after a repair, not only repaired examples. Preserve existing BF identity when the same failure recurs; allocate new IDs monotonically only for distinct failures. Classify each new failure as repairable, decision-required, scope-expansion, or external.

Write `criterion.checked` events for every AC, then `failure.raised` events for new fail or blocked observations, then one `failure.verification.recorded` event for every authorized repaired or resumed criterion/agent failure after its source is freshly proven, and only then `acceptance.closed`. This order is mandatory: the reducer requires all criteria before failures, failures before verifications, and complete accounting before terminal acceptance closure. Every failure and verification event carries your exact verifier ID. Use actor acceptance-verifier, your exact attempt and verifier ID, and omit seq. Emit no implementation, mechanical, human, commit, tracker, ticket-closure, or run-closure events.

Return the fragment path and a complete coverage ledger mapping every AC to PASS, BF ID, or BLOCKED, with evidence, actual versus expected behavior, repair classification, residual risk, and confirmation that product source remained unchanged. Never declare the ticket accepted, committed, closed, or complete.
```

After appending the verifier fragment, parent appends `attempt.closed` with the exact reducer-derived outcome and open failure IDs. Validate and regenerate the report.

## 5. Repair authorized failures

When an attempt fails and every open failure is repairable, automatically append a new `attempt.started` of kind `repair` with a fresh repairer ID and the exact complete open failure set. No additional human authorization is needed because the ticket already authorizes these behaviors.

Invoke one fresh repairer with the prompt below. Audit its work and fragment. A successful repairer emits one `implementation.applied` for the attempt and exactly one `repair.applied` for every authorized BF ID. A blocked repairer emits only blocked implementation; parent records an agent blocker and closes the attempt without mechanical evidence.

### Repairer prompt

```text
You are a fresh repairer for one narrowly authorized attempt in the pi-tidy-tools build loop.

Active ticket and parent contract:
<verbatim ticket, AC mappings, and parent specification>

Confirmed charter:
<verbatim charter>

Authorized failures:
<verbatim BF IDs, sources, actual and expected behavior, evidence, reproductions, and acceptance tests>

Explicitly unauthorized observations:
<verbatim list, or "none">

Current repository and user-owned state:
<git status --short, diffs, and ownership inventory>

Ledger assignment:
- Run directory: <run directory>
- Attempt: <attempt number>
- Agent ID: <fresh repairer ID>
- Repair fragment: <run directory>/fragments/attempt-<NNN>-repair.jsonl
- Artifact directory: <run directory>/artifacts/

Read .pi/skills/pi-tidy-tools-ethos/SKILL.md, .pi/skills/build-loop/EVENT_LEDGER.md, .pi/skills/build-loop/ledger-types.d.ts, relevant product docs, and the complete diff before editing.

Repair every authorized BF ID and only those failures. Do not address unrelated defects, cleanup, speculative improvements, or follow-up tickets. Preserve all user-owned and previously accepted work. Modify only confirmed mutable scope and assigned run paths. Do not stage, unstage, commit, reset, restore, checkout, stash, clean, rebase, amend, install or update dependencies without authorization, publish, or mutate tracker state.

Work test-first at each authorized acceptance seam. Reproduce each failure hermetically, implement the smallest correction, run focused checks, and inspect the complete diff. If repair requires a product decision, scope expansion, external action, or user-owned modification, stop rather than improvising. Emit `implementation.applied` with mode `blocked`, the exact authorized failure set, no files or tests, and concrete blocker evidence; emit no `repair.applied` events.

Otherwise write one `implementation.applied` event with mode `changed`, actor repairer and the exact authorized failure set, then one `repair.applied` event per BF ID. Use your exact attempt and agent ID and omit seq. Emit no canonical verification, criteria, human, commit, tracker, ticket-closure, or run-closure events.

Return the fragment path, one resolution entry per BF ID with root cause, files, regression coverage, focused evidence and residual risk, complete changed-file list, blockers, and unauthorized observations. Never mark a failure canonically fixed or the ticket accepted, committed, closed, or complete.
```

After repair, repeat parent mechanical verification and dispatch a different fresh verifier over the entire acceptance contract only when the mechanical gate passes. The parent or verifier records independent verification for every authorized failure that reaches acceptance. If mechanical verification fails first, close the repair attempt as failed without fabricating acceptance or repair-verification evidence; the prior failure and new mechanical failures remain open for the next fresh repair. Continue with fresh agents while every open product failure remains repairable.

If an attempt blocks, append `run.blocked` naming exactly the open non-repairable blocker IDs and return to the human with the exact reason and required action. Resume in this exact reducer order:

1. For any `decision-required` or `scope-expansion` blocker, obtain explicit human revision direction and append `human.decided` with action `revise` for the blocked attempt. External-only blockers do not receive this decision event.
2. Append `run.resumed` for the same blocked stage and exactly the complete blocker ID set, with resolution evidence. This changes each blocker only to resolved-awaiting-verification, never fixed.
3. Start a fresh revision, repair, or retest attempt as appropriate. Never start the attempt before `run.resumed`.

The fresh attempt must pass its normal gates and record matching independent `failure.verification.recorded` evidence for every resumed blocker before readiness. Prior blocked evidence remains canonical.

## 6. Human completion gate

An attempt is ready only when every criterion passes, every mechanical check passes, scope is clean, user-owned changes are preserved, every historical failure is independently fixed, and a focused ticket commit can be formed safely.

Present a concise summary with criterion coverage, mechanical commands, complete ticket-owned file list, worktree ownership, residual risk, and proposed commit message. Wait for exactly one action:

- `accept` - authorize a focused ticket commit and closure
- `revise <direction>` - record direction and start a fresh builder attempt
- `retest` - run a fresh unchanged attempt with all mechanical checks and a fresh verifier
- `stop` - close only the build run, preserve work, and leave the ticket open

Resolve ambiguous input with one short question.

On `accept`, append `human.decided`, then:

1. prove every proposed commit path is ticket-owned and contains no inseparable user-owned edits
2. write the proposed commit message into the run artifacts and inspect the exact proposed ticket file set and previously recorded accepted focused plan
3. create the focused commit with `.pi/skills/build-loop/scripts/focused-commit.mjs <message-file> --accepted-plan <run-dir>/artifacts/accepted-focused-plan.json --audit-baseline <run-dir>/artifacts/worktree-baseline.json <exact-ticket-file ...>`; this rejects any parent/tree/file drift since mechanical acceptance, uses isolated index state, performs the preservation audit before installing the synchronized index, and restores the original index if final HEAD compare-and-swap fails
4. require successful helper JSON with `audited: true`; on failure, prove the helper did not overwrite concurrent HEAD/index work and that any helper-owned HEAD update was rolled back before retrying
5. rerun `.pi/skills/build-loop/scripts/worktree-audit.mjs compare <baseline> <exact-ticket-file ...>` as independent parent evidence, inspect the successful commit, and record its exact status, hexadecimal SHA, file set, and audited helper output in `commit.recorded`
6. if the helper fails or its output cannot establish that rollback-and-preservation invariant, record `commit.recorded` with `failed` or `blocked` status and its evidence, then append the matching `run.blocked`; do not close or retry blindly
7. close only the active ticket in the configured tracker
8. verify the exact charter ticket closed and the exact charter parent still open and unmodified in `tracker.recorded`, including both immutable tracker references
9. append `ticket.closed` and `run.closed` only after both operations succeed

If a focused commit cannot be separated safely, record the unsuccessful `commit.recorded` outcome before the matching `run.blocked` and ask the human. A commit or tracker failure preserves accepted evidence and becomes a resumable closure blocker. While blocked at commit or tracker closure, the human may retry after `run.resumed` or reply `stop`; record the additional stop decision and close the run while leaving any unclosed ticket open.

On `revise`, append the human decision and begin a fresh revision attempt carrying the direction verbatim. On `retest`, append the decision and run a fresh unchanged attempt. On `stop`, append the decision and `run.closed` with reason `stopped`; never commit or close the ticket.

## 7. Close and hand off

Generate the final report from canonical JSONL and present its path. It must account for charter, tracker frontier, every attempt, criterion, failure, repair, command, human decision, commit, tracker outcome, residual risk, and final worktree.

After accepted closure, recompute and report the dependency frontier but do not start another ticket. End the run and require a fresh invocation and context.

When every declared child ticket of the parent specification is closed, write the versioned artifact at `.pi/build-runs/<run-id>/artifacts/qa-handoff.v1.json`. It has this exact schema (all strings are non-empty; arrays may be empty only for `residualRisks` and `deferredWork`):

```json
{
  "schema": "pi-tidy-build-qa-handoff",
  "version": 1,
  "parent": { "id": "<provider>:<repository>#<number>", "url": "<url>", "title": "<title>", "promise": "<verbatim complete parent body>" },
  "acceptedTickets": [{ "id": "<provider>:<repository>#<number>", "url": "<url>", "commitSha": "<full lowercase commit SHA>", "reportPath": ".pi/build-runs/<run-id>/report.md" }],
  "entryPoints": ["<user-visible entry point>"],
  "environment": ["<relevant environment or configuration>"],
  "residualRisks": ["<risk>"],
  "deferredWork": ["<deferred item>"],
  "suggestedAcceptanceBoundaries": ["<product-level boundary>"]
}
```

Write atomically, reject unknown/missing keys, duplicate ticket IDs, commits, or report paths, and verify every ticket/commit/report against canonical closed build ledgers before presenting it. Record and report its SHA-256. Present `/skill:qa-loop <handoff path>`. The handoff is draft charter input only; the QA human must still confirm the resulting charter. Do not claim QA started or passed. The QA loop owns its own charter, real-user harness, human finding gate, ledger, and closure.

## Closure conditions

The build loop is complete only when one explicit terminal path is accepted by the reducer:

- human accepts, focused commit succeeds, active ticket closes, parent remains open and unmodified, and the generated report records ticket-closed run closure; or
- human stops, current work is preserved, the active ticket remains open, no commit or tracker closure occurs, and the report records stopped run closure.

Never compress multiple tickets, skip independent acceptance, use a builder's own tests as canonical proof, or describe a blocked or merely implemented ticket as complete.
