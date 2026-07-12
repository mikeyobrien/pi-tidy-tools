import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("./build-ledger.mjs", import.meta.url).pathname;
const run = (args, expected = 0) => { const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" }); assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`); return result; };
const save = async (path, events) => writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
const ev = (ref = "observed") => [{ kind: "note", ref }];
const commitSha = "0123456789abcdef".padEnd(40, "0");
const tracker = (number, title, state = "open") => ({ provider: "github", repository: "mikeyobrien/pi-tidy-tools", number, url: `https://github.com/mikeyobrien/pi-tidy-tools/issues/${number}`, title, state });
const charter = {
  ticket: tracker(8, "Add a ticket-driven build loop"), ticketBody: "## Acceptance criteria\n\n- Public flow works\n- State stays truthful", ticketComments: ["Keep the parent open"], parent: tracker(3, "Parent specification"), parentBody: "Build one independently verified ticket", parentComments: [], userVisibleOutcome: "One ticket is independently verified and human accepted",
  criteria: [{ criterionId: "AC-001", text: "Public flow works" }, { criterionId: "AC-002", text: "State stays truthful" }],
  testSeams: [{ seamId: "public-cli", criterionIds: ["AC-001", "AC-002"], kind: "cli", description: "Canonical CLI behavior" }],
  mechanicalChecks: [{ checkId: "focused", command: "node --test focused", required: true }, { checkId: "workspace", command: "npm test", required: true }, { checkId: "types", command: "npm run check", required: true }, { checkId: "diff", command: "git diff --check", required: true }],
  mutablePaths: [".pi/skills/build-loop"], safety: ["preserve user changes"], outOfScope: ["release"], startingWorktree: [], userOwnedPaths: [],
};
const started = { v: 1, type: "run.started", actor: "parent", runId: "build-008", charter, evidence: ev("ticket and worktree captured") };
const ticketStarted = { v: 1, type: "ticket.started", actor: "parent", blockers: [tracker(4, "Prerequisite", "closed")], frontierStatus: "ready", evidence: ev("tracker frontier checked") };
const attempt = (number, kind, agentId, authorizedFailureIds = [], direction = "") => ({ v: 1, type: "attempt.started", actor: "parent", attempt: number, kind, agentId, authorizedFailureIds, direction });
const implementation = (number, actor, agentId, failureIds = [], mode = "changed") => ({ v: 1, type: "implementation.applied", actor, attempt: number, agentId, mode, failureIds, files: mode === "changed" ? [".pi/skills/build-loop/SKILL.md"] : [], tests: mode === "changed" ? ["build ledger"] : [], summary: mode === "changed" ? "Implemented ticket scope" : "Retest without changes", residualRisk: "none", evidence: ev("implementation audited") });
const mechanical = (number, status = "passed", scopeAudit = "clean") => ({ v: 1, type: "mechanical.verification.recorded", actor: "parent", attempt: number, checks: charter.mechanicalChecks.map((check, index) => { const effective = index === 0 ? status : "passed"; return { checkId: check.checkId, command: check.command, status: effective, exitCode: effective === "blocked" ? null : effective === "passed" ? 0 : 1, evidence: ev(`${check.checkId} output`) }; }), scopeAudit, ticketFiles: [".pi/skills/build-loop/SKILL.md"], worktreeStatus: ["?? .pi/skills/build-loop/"], evidence: ev("parent mechanical verification") });
const acceptance = (number, verifierId, statuses = ["pass", "pass"], accounting = []) => [
  { v: 1, type: "acceptance.started", actor: "parent", attempt: number, verifierId, evidence: ev("verifier dispatched") },
  ...charter.criteria.map((criterion, index) => ({ v: 1, type: "criterion.checked", actor: "acceptance-verifier", attempt: number, verifierId, criterionId: criterion.criterionId, seamId: "public-cli", status: statuses[index], notes: `${criterion.criterionId} ${statuses[index]}`, evidence: ev(`${criterion.criterionId} evidence`) })),
  ...accounting,
  { v: 1, type: "acceptance.closed", actor: "acceptance-verifier", attempt: number, verifierId, evidence: ev("complete acceptance ledger") },
];
const closeAttempt = (number, outcome, openFailureIds = []) => ({ v: 1, type: "attempt.closed", actor: "parent", attempt: number, outcome, openFailureIds, residualRisk: "none", evidence: ev("attempt audited") });
const delivery = (attemptNumber) => [
  { v: 1, type: "human.decided", actor: "parent", attempt: attemptNumber, action: "accept", direction: "", evidence: ev("human replied accept") },
  { v: 1, type: "commit.recorded", actor: "parent", attempt: attemptNumber, status: "succeeded", sha: commitSha, files: [".pi/skills/build-loop/SKILL.md"], worktreeStatus: [], evidence: ev("commit inspected") },
  { v: 1, type: "tracker.recorded", actor: "parent", attempt: attemptNumber, status: "succeeded", ticket: tracker(8, "Add a ticket-driven build loop", "closed"), parent: tracker(3, "Parent specification"), parentModified: false, evidence: ev("tracker checked") },
  { v: 1, type: "ticket.closed", actor: "parent", attempt: attemptNumber, commitSha, finalWorktree: [], residualRisk: "none", evidence: ev("ticket closure verified") },
  { v: 1, type: "run.closed", actor: "parent", reason: "ticket-closed", ticketState: "closed", parentState: "open", parentModified: false, commitSha, finalWorktree: [], residualRisk: "none", evidence: ev("run closure verified") },
];
async function fixture(name, events) { const root = await mkdtemp(join(tmpdir(), "build-ledger-")), runDir = join(root, name), init = join(root, "init.jsonl"), fragment = join(root, "events.jsonl"); await save(init, [started]); await save(fragment, events); run(["init", runDir, init]); return { root, runDir, fragment }; }

const successful = [ticketStarted, attempt(1, "initial", "builder-1"), implementation(1, "builder", "builder-1"), mechanical(1), ...acceptance(1, "verifier-1"), closeAttempt(1, "ready"), ...delivery(1)];

test("canonical build run sequences, verifies, delivers, and reports one ticket", async () => {
  const { runDir, fragment } = await fixture("success", successful); run(["append", runDir, fragment]); run(["validate", runDir]);
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); assert.deepEqual(events.map((event) => event.seq), Array.from({ length: events.length }, (_, index) => index + 1));
  run(["report", runDir]); const first = await readFile(join(runDir, "report.md"), "utf8"); run(["report", runDir]); assert.equal(await readFile(join(runDir, "report.md"), "utf8"), first); assert.match(first, /Ticket body[\s\S]*Public flow works/); assert.match(first, /AC-001.*pass/); assert.match(first, /Acceptance closure evidence/); assert.match(first, new RegExp(`Commit attempt 1: succeeded ${commitSha}`)); assert.match(first, new RegExp(`Ticket closure: commit ${commitSha}`)); assert.match(first, /ticket-closed/);
});

test("in-scope acceptance failure can be repaired and independently verified", async () => {
  const failure = { v: 1, type: "failure.raised", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier-a", failureId: "BF-001", sourceKind: "criterion", sourceId: "AC-002", classification: "repairable", summary: "State is stale", actual: "requested state shown", expected: "observed state shown", evidence: ev("acceptance capture") };
  const events = [ticketStarted, attempt(1, "initial", "builder-a"), implementation(1, "builder", "builder-a"), mechanical(1), ...acceptance(1, "verifier-a", ["pass", "fail"], [failure]), closeAttempt(1, "failed", ["BF-001"]), attempt(2, "repair", "repairer-b", ["BF-001"]), implementation(2, "repairer", "repairer-b", ["BF-001"]), { v: 1, type: "repair.applied", actor: "repairer", attempt: 2, agentId: "repairer-b", failureId: "BF-001", files: [".pi/skills/build-loop/SKILL.md"], tests: ["state regression"], summary: "Use observed state", residualRisk: "none", evidence: ev("repair diff") }, mechanical(2), ...acceptance(2, "verifier-b", ["pass", "pass"], [{ v: 1, type: "failure.verification.recorded", actor: "acceptance-verifier", attempt: 2, verifierId: "verifier-b", failureId: "BF-001", status: "passed", notes: "Fresh verifier observed corrected state", evidence: ev("repair acceptance") }]), closeAttempt(2, "ready"), ...delivery(2)];
  const { runDir, fragment } = await fixture("repair", events); run(["append", runDir, fragment]); run(["report", runDir]); const report = await readFile(join(runDir, "report.md"), "utf8"); assert.match(report, /BF-001.*repairable.*fixed/); assert.match(report, /\| 2 \| repair \| repairer-b \| ready \|/); assert.match(report, /Repair BF-001/); assert.match(report, /Verification BF-001: passed by verifier-b[\s\S]*repair acceptance/);
});

test("human revision and retest require fresh agents and complete evidence", async () => {
  const readyOne = [ticketStarted, attempt(1, "initial", "builder-one"), implementation(1, "builder", "builder-one"), mechanical(1), ...acceptance(1, "verify-one"), closeAttempt(1, "ready"), { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "revise", direction: "Improve the user-facing wording", evidence: ev("human revision") }, attempt(2, "revision", "builder-two", [], "Improve the user-facing wording"), implementation(2, "builder", "builder-two"), mechanical(2), ...acceptance(2, "verify-two"), closeAttempt(2, "ready"), { v: 1, type: "human.decided", actor: "parent", attempt: 2, action: "retest", direction: "", evidence: ev("human retest") }, attempt(3, "retest", "parent-retest"), implementation(3, "parent", "parent-retest", [], "unchanged"), mechanical(3), ...acceptance(3, "verify-three"), closeAttempt(3, "ready"), ...delivery(3)];
  const { runDir, fragment } = await fixture("revision", readyOne); run(["append", runDir, fragment]); run(["validate", runDir]);
});

test("blocked external work can stop without committing or closing the ticket", async () => {
  const blockedFailure = { v: 1, type: "failure.raised", actor: "parent", attempt: 1, verifierId: "parent", failureId: "BF-001", sourceKind: "mechanical", sourceId: "focused", classification: "external", summary: "Credential unavailable", actual: "Smoke check cannot start", expected: "Smoke check runs", evidence: ev("missing credential") };
  const events = [ticketStarted, attempt(1, "initial", "builder-x"), implementation(1, "builder", "builder-x"), mechanical(1, "blocked"), blockedFailure, closeAttempt(1, "blocked", ["BF-001"]), { v: 1, type: "run.blocked", actor: "parent", attempt: 1, stage: "attempt", failureIds: ["BF-001"], reason: "Credential unavailable", requiredAction: "Provide credential or stop", evidence: ev("blocker recorded") }, { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "stop", direction: "", evidence: ev("human stopped") }, { v: 1, type: "run.closed", actor: "parent", reason: "stopped", ticketState: "open", parentState: "open", parentModified: false, commitSha: "", finalWorktree: [" M partial.ts"], residualRisk: "Smoke check remains blocked", evidence: ev("partial work preserved") }];
  const { runDir, fragment } = await fixture("stopped", events); run(["append", runDir, fragment]); run(["report", runDir]); const report = await readFile(join(runDir, "report.md"), "utf8"); assert.match(report, /Run closed by \*\*stopped\*\*/); assert.match(report, /Delivery operations[\s\S]*- None\./);
});

test("blocked run can resume into a fresh retest after external resolution", async () => {
  const blockedFailure = { v: 1, type: "failure.raised", actor: "parent", attempt: 1, verifierId: "parent", failureId: "BF-001", sourceKind: "mechanical", sourceId: "focused", classification: "external", summary: "Service unavailable", actual: "Check blocked", expected: "Check runs", evidence: ev("service down") };
  const events = [ticketStarted, attempt(1, "initial", "builder-r"), implementation(1, "builder", "builder-r"), mechanical(1, "blocked"), blockedFailure, closeAttempt(1, "blocked", ["BF-001"]), { v: 1, type: "run.blocked", actor: "parent", attempt: 1, stage: "attempt", failureIds: ["BF-001"], reason: "Service unavailable", requiredAction: "Restore service", evidence: ev("blocker") }, { v: 1, type: "run.resumed", actor: "parent", attempt: 1, stage: "attempt", failureIds: ["BF-001"], resolution: "Service restored", evidence: ev("service healthy") }, attempt(2, "retest", "parent-resume"), implementation(2, "parent", "parent-resume", [], "unchanged"), mechanical(2), ...acceptance(2, "verify-resume", ["pass", "pass"], [{ v: 1, type: "failure.verification.recorded", actor: "parent", attempt: 2, verifierId: "parent", failureId: "BF-001", status: "passed", notes: "Service-dependent focused check now passes", evidence: ev("resumed blocker verified") }]), closeAttempt(2, "ready"), ...delivery(2)];
  const { runDir, fragment } = await fixture("resumed", events); run(["append", runDir, fragment]); run(["validate", runDir]);
});

test("invalid append is atomic and fragments cannot assign sequence numbers", async () => {
  const { runDir } = await fixture("atomic", []); const before = await readFile(join(runDir, "events.jsonl"), "utf8"), invalid = join(runDir, "invalid.jsonl");
  await save(invalid, [{ ...ticketStarted, seq: 2 }]); assert.match(run(["append", runDir, invalid], 1).stderr, /must omit seq/); assert.equal(await readFile(join(runDir, "events.jsonl"), "utf8"), before);
  await save(invalid, [ticketStarted, attempt(2, "initial", "skip")]); assert.match(run(["append", runDir, invalid], 1).stderr, /attempt numbers must be contiguous/); assert.equal(await readFile(join(runDir, "events.jsonl"), "utf8"), before);
});

test("acceptance closure requires complete criterion and failure accounting", async () => {
  const partial = [ticketStarted, attempt(1, "initial", "builder-p"), implementation(1, "builder", "builder-p"), mechanical(1), { v: 1, type: "acceptance.started", actor: "parent", attempt: 1, verifierId: "verifier-p", evidence: ev("dispatch") }, acceptance(1, "verifier-p")[1], { v: 1, type: "acceptance.closed", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier-p", evidence: ev("partial") }];
  const first = await fixture("coverage", partial); assert.match(run(["append", first.runDir, first.fragment], 1).stderr, /every criterion exactly once/);
  const unaccounted = await fixture("failure-accounting", [ticketStarted, attempt(1, "initial", "builder-failure-accounting"), implementation(1, "builder", "builder-failure-accounting"), mechanical(1), ...acceptance(1, "verifier-failure-accounting", ["pass", "fail"])]); assert.match(run(["append", unaccounted.runDir, unaccounted.fragment], 1).stderr, /requires failure accounting for criterion: AC-002/);
  const wrong = join(first.runDir, "wrong.jsonl"); await save(wrong, [{ ...mechanical(1), actor: "builder" }]); assert.match(run(["append", first.runDir, wrong], 1).stderr, /actor must be one of: parent/);
});

test("acceptance criteria, failures, verification, and closure cannot interleave", async () => {
  const review = acceptance(1, "verifier-order", ["fail", "pass"]), failure = { v: 1, type: "failure.raised", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier-order", failureId: "BF-001", sourceKind: "criterion", sourceId: "AC-001", classification: "repairable", summary: "failed", actual: "failed", expected: "pass", evidence: ev("failure") };
  const events = [ticketStarted, attempt(1, "initial", "builder-acceptance-order"), implementation(1, "builder", "builder-acceptance-order"), mechanical(1), review[0], review[1], failure, review[2]];
  const { runDir, fragment } = await fixture("acceptance-order", events); assert.match(run(["append", runDir, fragment], 1).stderr, /all criteria must precede acceptance failure and verification events/);
});

test("acceptance.closed is terminal for verifier acceptance events", async () => {
  const terminalEvents = [
    { ...acceptance(1, "verifier-terminal")[1], criterionId: "AC-001" },
    { v: 1, type: "failure.raised", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier-terminal", failureId: "BF-001", sourceKind: "criterion", sourceId: "AC-001", classification: "repairable", summary: "late", actual: "late", expected: "before closure", evidence: ev("late failure") },
    { v: 1, type: "failure.verification.recorded", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier-terminal", failureId: "BF-001", status: "passed", notes: "late", evidence: ev("late verification") },
  ];
  for (const [index, late] of terminalEvents.entries()) {
    const events = [ticketStarted, attempt(1, "initial", `builder-terminal-${index}`), implementation(1, "builder", `builder-terminal-${index}`), mechanical(1), ...acceptance(1, "verifier-terminal"), late];
    const { runDir, fragment } = await fixture(`terminal-acceptance-${index}`, events); assert.match(run(["append", runDir, fragment], 1).stderr, /acceptance\.closed|active acceptance/);
  }
});

test("ticket closure cannot precede human acceptance, commit, and tracker success", async () => {
  const events = [ticketStarted, attempt(1, "initial", "builder-c"), implementation(1, "builder", "builder-c"), mechanical(1), ...acceptance(1, "verifier-c"), closeAttempt(1, "ready"), { v: 1, type: "ticket.closed", actor: "parent", attempt: 1, commitSha: "deadbeef", finalWorktree: [], residualRisk: "none", evidence: ev("premature") }];
  const { runDir, fragment } = await fixture("closure", events); assert.match(run(["append", runDir, fragment], 1).stderr, /successful commit and tracker closure/);
});

test("tracker failure resumes without rebuilding or reverifying accepted code", async () => {
  const prefix = [ticketStarted, attempt(1, "initial", "builder-t"), implementation(1, "builder", "builder-t"), mechanical(1), ...acceptance(1, "verifier-t"), closeAttempt(1, "ready"), { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "accept", direction: "", evidence: ev("human accepted") }, { v: 1, type: "commit.recorded", actor: "parent", attempt: 1, status: "succeeded", sha: commitSha, files: [".pi/skills/build-loop/SKILL.md"], worktreeStatus: [], evidence: ev("commit") }, { v: 1, type: "tracker.recorded", actor: "parent", attempt: 1, status: "failed", ticket: tracker(8, "Add a ticket-driven build loop"), parent: tracker(3, "Parent specification"), parentModified: false, evidence: ev("tracker outage") }, { v: 1, type: "run.blocked", actor: "parent", attempt: 1, stage: "tracker", failureIds: [], reason: "GitHub unavailable", requiredAction: "Retry tracker closure", evidence: ev("outage") }, { v: 1, type: "run.resumed", actor: "parent", attempt: 1, stage: "tracker", failureIds: [], resolution: "GitHub restored", evidence: ev("tracker healthy") }, { v: 1, type: "tracker.recorded", actor: "parent", attempt: 1, status: "succeeded", ticket: tracker(8, "Add a ticket-driven build loop", "closed"), parent: tracker(3, "Parent specification"), parentModified: false, evidence: ev("tracker closed") }, { v: 1, type: "ticket.closed", actor: "parent", attempt: 1, commitSha, finalWorktree: [], residualRisk: "none", evidence: ev("closure") }, { v: 1, type: "run.closed", actor: "parent", reason: "ticket-closed", ticketState: "closed", parentState: "open", parentModified: false, commitSha, finalWorktree: [], residualRisk: "none", evidence: ev("done") }];
  const { runDir, fragment } = await fixture("tracker-resume", prefix); run(["append", runDir, fragment]); run(["validate", runDir]);
});

test("implementation and commit paths must stay in ticket-owned mutable scope", async () => {
  const outside = [ticketStarted, attempt(1, "initial", "builder-o"), { ...implementation(1, "builder", "builder-o"), files: ["packages/unrelated.ts"] }];
  const first = await fixture("outside", outside); assert.match(run(["append", first.runDir, first.fragment], 1).stderr, /outside mutable scope/);
  const ownedCharter = { ...charter, userOwnedPaths: [".pi/skills/build-loop/user-note.md"] }, ownedStart = { ...started, charter: ownedCharter, runId: "build-owned" };
  const root = await mkdtemp(join(tmpdir(), "build-ledger-")), runDir = join(root, "owned"), init = join(root, "init.jsonl"), fragment = join(root, "events.jsonl"); await save(init, [ownedStart]); await save(fragment, [ticketStarted, attempt(1, "initial", "builder-u"), { ...implementation(1, "builder", "builder-u"), files: [".pi/skills/build-loop/user-note.md"] }]); run(["init", runDir, init]); assert.match(run(["append", runDir, fragment], 1).stderr, /user-owned path/);
});

test("path traversal cannot escape mutable scope", async () => {
  const events = [ticketStarted, attempt(1, "initial", "builder-traversal"), { ...implementation(1, "builder", "builder-traversal"), files: [".pi/skills/build-loop/../../qa-loop/SKILL.md"] }];
  const { runDir, fragment } = await fixture("traversal", events); assert.match(run(["append", runDir, fragment], 1).stderr, /normalized repository-relative path/);
});

test("failed closure operation must enter and resume a canonical blocker before retry", async () => {
  const prefix = [ticketStarted, attempt(1, "initial", "builder-block"), implementation(1, "builder", "builder-block"), mechanical(1), ...acceptance(1, "verifier-block"), closeAttempt(1, "ready"), { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "accept", direction: "", evidence: ev("accepted") }, { v: 1, type: "commit.recorded", actor: "parent", attempt: 1, status: "failed", sha: "", files: [".pi/skills/build-loop/SKILL.md"], worktreeStatus: [], evidence: ev("commit failed") }, { v: 1, type: "commit.recorded", actor: "parent", attempt: 1, status: "succeeded", sha: commitSha, files: [".pi/skills/build-loop/SKILL.md"], worktreeStatus: [], evidence: ev("retry") }];
  const { runDir, fragment } = await fixture("mandatory-block", prefix); assert.match(run(["append", runDir, fragment], 1).stderr, /commit failure must be followed by run.blocked/);
});

test("human retest and revision decisions are one-shot transitions", async () => {
  const events = [ticketStarted, attempt(1, "initial", "builder-d1"), implementation(1, "builder", "builder-d1"), mechanical(1), ...acceptance(1, "verifier-d1"), closeAttempt(1, "ready"), { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "retest", direction: "", evidence: ev("retest") }, attempt(2, "retest", "parent-d2"), implementation(2, "parent", "parent-d2", [], "unchanged"), mechanical(2), ...acceptance(2, "verifier-d2"), closeAttempt(2, "ready"), attempt(3, "retest", "parent-d3")];
  const { runDir, fragment } = await fixture("stale-decision", events); assert.match(run(["append", runDir, fragment], 1).stderr, /immediately preceding unconsumed retest decision/);
});

test("recurring verified failure reuses its stable identity", async () => {
  const raised = (attemptNumber, verifierId) => ({ v: 1, type: "failure.raised", actor: "acceptance-verifier", attempt: attemptNumber, verifierId, failureId: "BF-001", sourceKind: "criterion", sourceId: "AC-002", classification: "repairable", summary: "State is stale again", actual: "requested state shown", expected: "observed state shown", evidence: ev("recurrence") });
  const events = [ticketStarted, attempt(1, "initial", "builder-f1"), implementation(1, "builder", "builder-f1"), mechanical(1), ...acceptance(1, "verifier-f1", ["pass", "fail"], [raised(1, "verifier-f1")]), closeAttempt(1, "failed", ["BF-001"]), attempt(2, "repair", "repairer-f2", ["BF-001"]), implementation(2, "repairer", "repairer-f2", ["BF-001"]), { v: 1, type: "repair.applied", actor: "repairer", attempt: 2, agentId: "repairer-f2", failureId: "BF-001", files: [".pi/skills/build-loop/SKILL.md"], tests: ["recurrence"], summary: "Fix state", residualRisk: "none", evidence: ev("repair") }, mechanical(2), ...acceptance(2, "verifier-f2", ["pass", "pass"], [{ v: 1, type: "failure.verification.recorded", actor: "acceptance-verifier", attempt: 2, verifierId: "verifier-f2", failureId: "BF-001", status: "passed", notes: "fixed", evidence: ev("verified") }]), closeAttempt(2, "ready"), { v: 1, type: "human.decided", actor: "parent", attempt: 2, action: "retest", direction: "", evidence: ev("retest") }, attempt(3, "retest", "parent-f3"), implementation(3, "parent", "parent-f3", [], "unchanged"), mechanical(3), ...acceptance(3, "verifier-f3", ["pass", "fail"], [raised(3, "verifier-f3")]), closeAttempt(3, "failed", ["BF-001"]), { v: 1, type: "human.decided", actor: "parent", attempt: 3, action: "stop", direction: "", evidence: ev("stop") }, { v: 1, type: "run.closed", actor: "parent", reason: "stopped", ticketState: "open", parentState: "open", parentModified: false, commitSha: "", finalWorktree: [], residualRisk: "failure recurred", evidence: ev("stopped") }];
  const { runDir, fragment } = await fixture("recurrence", events); run(["append", runDir, fragment]); run(["validate", runDir]);
});

test("repair verification requires the active verifier and passing source evidence", async () => {
  const failure = { v: 1, type: "failure.raised", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier-v1", failureId: "BF-001", sourceKind: "criterion", sourceId: "AC-002", classification: "repairable", summary: "Stale", actual: "stale", expected: "fresh", evidence: ev("failure") };
  const events = [ticketStarted, attempt(1, "initial", "builder-v1"), implementation(1, "builder", "builder-v1"), mechanical(1), ...acceptance(1, "verifier-v1", ["pass", "fail"], [failure]), closeAttempt(1, "failed", ["BF-001"]), attempt(2, "repair", "repairer-v2", ["BF-001"]), implementation(2, "repairer", "repairer-v2", ["BF-001"]), { v: 1, type: "repair.applied", actor: "repairer", attempt: 2, agentId: "repairer-v2", failureId: "BF-001", files: [".pi/skills/build-loop/SKILL.md"], tests: ["fix"], summary: "fixed", residualRisk: "none", evidence: ev("repair") }, { v: 1, type: "failure.verification.recorded", actor: "acceptance-verifier", attempt: 2, verifierId: "old-verifier", failureId: "BF-001", status: "passed", notes: "claimed", evidence: ev("claim") }];
  const { runDir, fragment } = await fixture("verification-order", events); assert.match(run(["append", runDir, fragment], 1).stderr, /fresh post-mechanical evidence/);
});

test("delivery rejects empty commits and wrong tracker identities", async () => {
  const ready = [ticketStarted, attempt(1, "initial", "builder-delivery"), implementation(1, "builder", "builder-delivery"), mechanical(1), ...acceptance(1, "verifier-delivery"), closeAttempt(1, "ready"), { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "accept", direction: "", evidence: ev("accept") }];
  const empty = await fixture("empty-commit", [...ready, { v: 1, type: "commit.recorded", actor: "parent", attempt: 1, status: "succeeded", sha: commitSha, files: [], worktreeStatus: [], evidence: ev("empty") }]); assert.match(run(["append", empty.runDir, empty.fragment], 1).stderr, /exactly match the accepted ticket delta/);
  const wrongTracker = await fixture("wrong-tracker", [...ready, { v: 1, type: "commit.recorded", actor: "parent", attempt: 1, status: "succeeded", sha: commitSha, files: [".pi/skills/build-loop/SKILL.md"], worktreeStatus: [], evidence: ev("commit") }, { v: 1, type: "tracker.recorded", actor: "parent", attempt: 1, status: "succeeded", ticket: tracker(99, "Wrong", "closed"), parent: tracker(3, "Parent specification"), parentModified: false, evidence: ev("wrong") }]); assert.match(run(["append", wrongTracker.runDir, wrongTracker.fragment], 1).stderr, /identities must match/);
});

test("mechanical status must agree with process exit code", async () => {
  const dishonest = mechanical(1); dishonest.checks[0] = { ...dishonest.checks[0], status: "passed", exitCode: 1 };
  const { runDir, fragment } = await fixture("exit-truth", [ticketStarted, attempt(1, "initial", "builder-exit"), implementation(1, "builder", "builder-exit"), dishonest]); assert.match(run(["append", runDir, fragment], 1).stderr, /exitCode does not match status/);
});

test("one non-pass source cannot allocate multiple failure identities", async () => {
  const first = { v: 1, type: "failure.raised", actor: "parent", attempt: 1, verifierId: "parent", failureId: "BF-001", sourceKind: "mechanical", sourceId: "focused", classification: "external", summary: "blocked", actual: "blocked", expected: "passes", evidence: ev("one") };
  const second = { ...first, failureId: "BF-002", evidence: ev("two") };
  const { runDir, fragment } = await fixture("duplicate-source", [ticketStarted, attempt(1, "initial", "builder-source"), implementation(1, "builder", "builder-source"), mechanical(1, "blocked"), first, second]); assert.match(run(["append", runDir, fragment], 1).stderr, /source already owns stable identity BF-001/);
});

test("builder can report a pre-change blocker and close without fabricated checks", async () => {
  const blockedImplementation = { ...implementation(1, "builder", "builder-agent"), mode: "blocked", files: [], tests: [], summary: "Product decision missing" };
  const blocker = { v: 1, type: "failure.raised", actor: "parent", attempt: 1, verifierId: "parent", failureId: "BF-001", sourceKind: "agent", sourceId: "builder-agent", classification: "decision-required", summary: "Product decision missing", actual: "Two valid behaviors", expected: "One selected behavior", evidence: ev("builder blocker") };
  const events = [ticketStarted, attempt(1, "initial", "builder-agent"), blockedImplementation, blocker, closeAttempt(1, "blocked", ["BF-001"]), { v: 1, type: "run.blocked", actor: "parent", attempt: 1, stage: "attempt", failureIds: ["BF-001"], reason: "Decision required", requiredAction: "Choose behavior", evidence: ev("blocked") }, { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "stop", direction: "", evidence: ev("stop") }, { v: 1, type: "run.closed", actor: "parent", reason: "stopped", ticketState: "open", parentState: "open", parentModified: false, commitSha: "", finalWorktree: [], residualRisk: "decision open", evidence: ev("closed") }];
  const { runDir, fragment } = await fixture("agent-blocked", events); run(["append", runDir, fragment]); run(["validate", runDir]);
});

test("failed repair verification closes as failed for another fresh repair", async () => {
  const failure = { v: 1, type: "failure.raised", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier-r1", failureId: "BF-001", sourceKind: "criterion", sourceId: "AC-002", classification: "repairable", summary: "Still stale", actual: "stale", expected: "fresh", evidence: ev("failure") };
  const events = [ticketStarted, attempt(1, "initial", "builder-r1"), implementation(1, "builder", "builder-r1"), mechanical(1), ...acceptance(1, "verifier-r1", ["pass", "fail"], [failure]), closeAttempt(1, "failed", ["BF-001"]), attempt(2, "repair", "repairer-r2", ["BF-001"]), implementation(2, "repairer", "repairer-r2", ["BF-001"]), { v: 1, type: "repair.applied", actor: "repairer", attempt: 2, agentId: "repairer-r2", failureId: "BF-001", files: [".pi/skills/build-loop/SKILL.md"], tests: ["retry"], summary: "Attempted repair", residualRisk: "may remain", evidence: ev("repair") }, mechanical(2), ...acceptance(2, "verifier-r2", ["pass", "fail"], [{ v: 1, type: "failure.verification.recorded", actor: "acceptance-verifier", attempt: 2, verifierId: "verifier-r2", failureId: "BF-001", status: "failed", notes: "Failure remains", evidence: ev("reverified failure") }]), closeAttempt(2, "failed", ["BF-001"])];
  const { runDir, fragment } = await fixture("failed-repair", events); run(["append", runDir, fragment]); run(["validate", runDir]);
});

test("human can stop after an accepted commit operation blocks", async () => {
  const events = [ticketStarted, attempt(1, "initial", "builder-stop"), implementation(1, "builder", "builder-stop"), mechanical(1), ...acceptance(1, "verifier-stop"), closeAttempt(1, "ready"), { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "accept", direction: "", evidence: ev("accept") }, { v: 1, type: "commit.recorded", actor: "parent", attempt: 1, status: "failed", sha: "", files: [".pi/skills/build-loop/SKILL.md"], worktreeStatus: [], evidence: ev("commit failed") }, { v: 1, type: "run.blocked", actor: "parent", attempt: 1, stage: "commit", failureIds: [], reason: "Commit unavailable", requiredAction: "Retry or stop", evidence: ev("blocked") }, { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "stop", direction: "", evidence: ev("stop") }, { v: 1, type: "run.closed", actor: "parent", reason: "stopped", ticketState: "open", parentState: "open", parentModified: false, commitSha: "", finalWorktree: [" M ticket.ts"], residualRisk: "verified work remains uncommitted", evidence: ev("stopped") }];
  const { runDir, fragment } = await fixture("stop-after-accept", events); run(["append", runDir, fragment]); run(["validate", runDir]);
});

test("repair can fail at the mechanical gate before acceptance verification", async () => {
  const criterionFailure = { v: 1, type: "failure.raised", actor: "acceptance-verifier", attempt: 1, verifierId: "verify-mech1", failureId: "BF-001", sourceKind: "criterion", sourceId: "AC-002", classification: "repairable", summary: "stale", actual: "stale", expected: "fresh", evidence: ev("criterion failure") };
  const mechanicalFailure = { v: 1, type: "failure.raised", actor: "parent", attempt: 2, verifierId: "parent", failureId: "BF-002", sourceKind: "mechanical", sourceId: "focused", classification: "repairable", summary: "focused check failed", actual: "exit 1", expected: "exit 0", evidence: ev("mechanical failure") };
  const events = [ticketStarted, attempt(1, "initial", "builder-mech1"), implementation(1, "builder", "builder-mech1"), mechanical(1), ...acceptance(1, "verify-mech1", ["pass", "fail"], [criterionFailure]), closeAttempt(1, "failed", ["BF-001"]), attempt(2, "repair", "repairer-mech2", ["BF-001"]), implementation(2, "repairer", "repairer-mech2", ["BF-001"]), { v: 1, type: "repair.applied", actor: "repairer", attempt: 2, agentId: "repairer-mech2", failureId: "BF-001", files: [".pi/skills/build-loop/SKILL.md"], tests: ["focused"], summary: "repair attempted", residualRisk: "mechanical failure", evidence: ev("repair") }, mechanical(2, "failed"), mechanicalFailure, closeAttempt(2, "failed", ["BF-001", "BF-002"])];
  const { runDir, fragment } = await fixture("mechanical-repair-failure", events); run(["append", runDir, fragment]); run(["validate", runDir]);
});

test("resumed blocker cannot become fixed without fresh verification", async () => {
  const blocker = { v: 1, type: "failure.raised", actor: "parent", attempt: 1, verifierId: "parent", failureId: "BF-001", sourceKind: "mechanical", sourceId: "focused", classification: "external", summary: "blocked", actual: "blocked", expected: "pass", evidence: ev("blocked") };
  const events = [ticketStarted, attempt(1, "initial", "builder-unverified"), implementation(1, "builder", "builder-unverified"), mechanical(1, "blocked"), blocker, closeAttempt(1, "blocked", ["BF-001"]), { v: 1, type: "run.blocked", actor: "parent", attempt: 1, stage: "attempt", failureIds: ["BF-001"], reason: "blocked", requiredAction: "restore", evidence: ev("block") }, { v: 1, type: "run.resumed", actor: "parent", attempt: 1, stage: "attempt", failureIds: ["BF-001"], resolution: "restored", evidence: ev("resume") }, attempt(2, "retest", "parent-unverified"), implementation(2, "parent", "parent-unverified", [], "unchanged"), mechanical(2), ...acceptance(2, "verify-unverified"), closeAttempt(2, "ready")];
  const { runDir, fragment } = await fixture("unverified-resume", events); assert.match(run(["append", runDir, fragment], 1).stderr, /acceptance closure requires complete failure verification accounting/);
});

test("human stop must close immediately and cannot resume", async () => {
  const blocker = { v: 1, type: "failure.raised", actor: "parent", attempt: 1, verifierId: "parent", failureId: "BF-001", sourceKind: "mechanical", sourceId: "focused", classification: "external", summary: "blocked", actual: "blocked", expected: "pass", evidence: ev("blocked") };
  const events = [ticketStarted, attempt(1, "initial", "builder-terminal"), implementation(1, "builder", "builder-terminal"), mechanical(1, "blocked"), blocker, closeAttempt(1, "blocked", ["BF-001"]), { v: 1, type: "run.blocked", actor: "parent", attempt: 1, stage: "attempt", failureIds: ["BF-001"], reason: "External blocker", requiredAction: "Resolve or stop", evidence: ev("blocked") }, { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "stop", direction: "", evidence: ev("stop") }, { v: 1, type: "run.resumed", actor: "parent", attempt: 1, stage: "attempt", failureIds: ["BF-001"], resolution: "attempted resume", evidence: ev("resume") }];
  const { runDir, fragment } = await fixture("terminal-stop", events); assert.match(run(["append", runDir, fragment], 1).stderr, /stop must be followed immediately by run.closed/);
});

test("repair events cannot precede changed implementation", async () => {
  const failure = { v: 1, type: "failure.raised", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier-order1", failureId: "BF-001", sourceKind: "criterion", sourceId: "AC-002", classification: "repairable", summary: "stale", actual: "stale", expected: "fresh", evidence: ev("failure") };
  const events = [ticketStarted, attempt(1, "initial", "builder-order1"), implementation(1, "builder", "builder-order1"), mechanical(1), ...acceptance(1, "verifier-order1", ["pass", "fail"], [failure]), closeAttempt(1, "failed", ["BF-001"]), attempt(2, "repair", "repairer-order2", ["BF-001"]), { v: 1, type: "repair.applied", actor: "repairer", attempt: 2, agentId: "repairer-order2", failureId: "BF-001", files: [".pi/skills/build-loop/SKILL.md"], tests: ["order"], summary: "out of order", residualRisk: "none", evidence: ev("repair") }];
  const { runDir, fragment } = await fixture("repair-order", events); assert.match(run(["append", runDir, fragment], 1).stderr, /must follow changed implementation/);
});
