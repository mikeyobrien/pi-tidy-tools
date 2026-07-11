import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("./qa-ledger.mjs", import.meta.url).pathname;
const buildCli = new URL("../../build-loop/scripts/build-ledger.mjs", import.meta.url).pathname;
const run = (args, expected = 0, cwd) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd });
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  return result;
};
const save = async (path, events) => writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
const evidence = [{ kind: "capture", ref: "artifacts/reload.txt" }];
const started = {
  v: 1, type: "run.started", runId: "Q001",
  charter: { feature: "reload durations", promise: "Elapsed time survives reload", entryPoint: "interactive Pi TUI", environment: "local package", acceptance: [{ id: "duration-persistence", text: "Duration remains 7s" }], safety: ["isolated session"], outOfScope: [], handoff: null },
  tooling: { driver: "agent-tty", harness: ".pi/skills/qa-loop/scripts/pi-tui-harness.sh", viewports: ["120x36", "72x24"], sessionDir: "/tmp/pi-tidy-qa/sessions", agentTtyHome: "/tmp/pi-tidy-qa/agent-tty", piVersion: "0.80.6", agentTtyVersion: "0.5.0", nodeVersion: "v24.18.0" },
};

const repairedRun = [
  { v: 1, type: "round.started", round: 1, objective: "initial" },
  { v: 1, type: "finding.raised", round: 1, findingId: "F001", severity: "high", confidence: "high", summary: "Duration resets", actual: "Shows <1s", expected: "Shows 7s", reproduction: ["Run bash", "Reload"], evidence, recommendation: "Persist duration", acceptance: "Reload shows 7s" },
  { v: 1, type: "scenario.checked", round: 1, scenarioId: "reload.completed-bash", requirementIds: ["duration-persistence"], status: "finding", findingIds: ["F001"], evidence, notes: "Reproduced twice" },
  { v: 1, type: "human.selected", round: 1, action: "fix", findingIds: ["F001"] },
  { v: 1, type: "fix.applied", round: 1, findingId: "F001", files: ["index.ts"], tests: ["reload regression"], summary: "Persisted elapsed metadata", residualRisk: "Historical rows lack metadata" },
  { v: 1, type: "verification.recorded", round: 1, findingId: "F001", status: "passed", evidence: [{ kind: "command", ref: "npm test" }], notes: "Regression passes" },
  { v: 1, type: "round.closed", round: 1, outcome: "findings" },
  { v: 1, type: "round.started", round: 2, objective: "post-fix" },
  { v: 1, type: "scenario.checked", round: 2, scenarioId: "reload.completed-bash", requirementIds: ["duration-persistence"], status: "pass", findingIds: [], evidence: [{ kind: "capture", ref: "artifacts/reload-fixed.txt" }], notes: "Duration retained at both widths" },
  { v: 1, type: "round.closed", round: 2, outcome: "no-findings" },
  { v: 1, type: "run.closed", reason: "no-findings", acceptedOpenFindingIds: [], verificationChecks: ["npm test", "npm run check", "git diff --check"].map((command) => ({ command, status: "passed", exitCode: 0, evidence: [{ kind: "command", ref: `${command} passed` }] })), worktreeStatus: [" M index.ts"] },
];

test("canonical writer sequences fragments and renders a stable report", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "Q001"), init = join(root, "init.jsonl"), fragment = join(root, "rounds.jsonl");
  await save(init, [started]); await save(fragment, repairedRun);
  run(["init", runDir, init]); run(["append", runDir, fragment]); run(["validate", runDir]);
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.ok(events.every((event) => event.v === 1));
  run(["report", runDir]); const first = await readFile(join(runDir, "report.md"), "utf8"); run(["report", runDir]); const second = await readFile(join(runDir, "report.md"), "utf8");
  assert.equal(first, second); assert.match(first, /F001 \| high \| high \| fixed/); assert.match(first, /Closed by \*\*no-findings\*\*/); assert.match(first, /reload\.completed-bash/);
});

test("initialization rejects missing build provenance and tampered handoff bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-handoff-")), relative = ".pi/build-runs/B001/artifacts/qa-handoff.v1.json", handoff = join(root, relative), init = join(root, "init.jsonl"), runDir = join(root, ".pi/qa-runs/QH001"); await mkdir(join(root, ".pi/build-runs/B001/artifacts"), { recursive: true });
  const artifact = { schema: "pi-tidy-build-qa-handoff", version: 1, parent: { id: "github:example/repo#1", url: "https://example.test/P1", title: "Parent", promise: "Works end to end" }, acceptedTickets: [{ id: "github:example/repo#2", url: "https://example.test/T1", commitSha: "0".repeat(40), reportPath: ".pi/build-runs/B001/report.md" }], entryPoints: ["Pi TUI"], environment: ["isolated HOME"], residualRisks: [], deferredWork: [], suggestedAcceptanceBoundaries: ["setup and teardown"] };
  const bytes = `${JSON.stringify(artifact)}\n`; await writeFile(handoff, bytes); const sha256 = createHash("sha256").update(bytes).digest("hex"), charter = { ...started.charter, handoff: { path: relative, schemaVersion: 1, sha256 } }; await save(init, [{ ...started, runId: "QH001", charter }]);
  assert.match(run(["init", runDir, init], 1, root).stderr, /events\.jsonl|ENOENT/);
  const missing = join(root, "missing.jsonl"), missingCharter = { ...started.charter, handoff: { path: ".pi/build-runs/B002/artifacts/qa-handoff.v1.json", schemaVersion: 1, sha256 } }; await save(missing, [{ ...started, runId: "QH002", charter: missingCharter }]); assert.match(run(["init", join(root, ".pi/qa-runs/QH002"), missing], 1, root).stderr, /ENOENT/);
  await writeFile(handoff, `${JSON.stringify({ ...artifact, unknown: true })}\n`); assert.match(run(["init", join(root, ".pi/qa-runs/QH003"), init], 1, root).stderr, /sha256 does not match/);
});

test("initialization accepts provenance from a matching closed build ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-valid-handoff-")), invoke = (script, args, expected = 0) => { const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" }); assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`); return result; }, git = (...args) => { const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git("init", "-q"); git("config", "user.email", "fixture@example.com"); git("config", "user.name", "Fixture"); await writeFile(join(root, "product.txt"), "built\n"); git("add", "product.txt"); git("commit", "-qm", "built ticket"); const commitSha = git("rev-parse", "HEAD"), buildDir = join(root, ".pi/build-runs/B001"), init = join(root, "build-init.jsonl"), fragment = join(root, "build-events.jsonl"), note = [{ kind: "note", ref: "verified" }]; await mkdir(buildDir, { recursive: true });
  const tracker = (number, title, state = "open") => ({ provider: "github", repository: "example/repo", number, url: `https://example.test/issues/${number}`, title, state }), ticket = tracker(2, "Ticket"), parent = tracker(1, "Parent"), buildCharter = { ticket, ticketBody: "Acceptance", ticketComments: [], parent, parentBody: "Works end to end", parentComments: [], userVisibleOutcome: "Feature works", criteria: [{ criterionId: "AC-001", text: "Works" }], testSeams: [{ seamId: "cli", criterionIds: ["AC-001"], kind: "cli", description: "CLI" }], mechanicalChecks: [{ checkId: "tests", command: "npm test", required: true }], mutablePaths: ["product.txt"], safety: ["preserve state"], outOfScope: [], startingWorktree: [], userOwnedPaths: [] };
  await save(init, [{ v: 1, type: "run.started", actor: "parent", runId: "B001", charter: buildCharter, evidence: note }]);
  const buildEvents = [
    { v: 1, type: "ticket.started", actor: "parent", blockers: [], frontierStatus: "ready", evidence: note },
    { v: 1, type: "attempt.started", actor: "parent", attempt: 1, kind: "initial", agentId: "builder", authorizedFailureIds: [], direction: "" },
    { v: 1, type: "implementation.applied", actor: "builder", attempt: 1, agentId: "builder", mode: "changed", failureIds: [], files: ["product.txt"], tests: ["npm test"], summary: "Built", residualRisk: "none", evidence: note },
    { v: 1, type: "mechanical.verification.recorded", actor: "parent", attempt: 1, checks: [{ checkId: "tests", command: "npm test", status: "passed", exitCode: 0, evidence: note }], scopeAudit: "clean", ticketFiles: ["product.txt"], worktreeStatus: [], evidence: note },
    { v: 1, type: "acceptance.started", actor: "parent", attempt: 1, verifierId: "verifier", evidence: note },
    { v: 1, type: "criterion.checked", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier", criterionId: "AC-001", seamId: "cli", status: "pass", notes: "Observed", evidence: note },
    { v: 1, type: "acceptance.closed", actor: "acceptance-verifier", attempt: 1, verifierId: "verifier", evidence: note },
    { v: 1, type: "attempt.closed", actor: "parent", attempt: 1, outcome: "ready", openFailureIds: [], residualRisk: "none", evidence: note },
    { v: 1, type: "human.decided", actor: "parent", attempt: 1, action: "accept", direction: "", evidence: note },
    { v: 1, type: "commit.recorded", actor: "parent", attempt: 1, status: "succeeded", sha: commitSha, files: ["product.txt"], worktreeStatus: [], evidence: note },
    { v: 1, type: "tracker.recorded", actor: "parent", attempt: 1, status: "succeeded", ticket: { ...ticket, state: "closed" }, parent, parentModified: false, evidence: note },
    { v: 1, type: "ticket.closed", actor: "parent", attempt: 1, commitSha, finalWorktree: [], residualRisk: "none", evidence: note },
    { v: 1, type: "run.closed", actor: "parent", reason: "ticket-closed", ticketState: "closed", parentState: "open", parentModified: false, commitSha, finalWorktree: [], residualRisk: "none", evidence: note },
  ];
  await save(fragment, buildEvents); invoke(buildCli, ["init", buildDir, init]); invoke(buildCli, ["append", buildDir, fragment]); invoke(buildCli, ["report", buildDir]);
  const relative = ".pi/build-runs/B001/artifacts/qa-handoff.v1.json", handoff = join(root, relative); await mkdir(join(buildDir, "artifacts"), { recursive: true }); const artifact = { schema: "pi-tidy-build-qa-handoff", version: 1, parent: { id: "github:example/repo#1", url: parent.url, title: parent.title, promise: buildCharter.parentBody }, acceptedTickets: [{ id: "github:example/repo#2", url: ticket.url, commitSha, reportPath: ".pi/build-runs/B001/report.md" }], entryPoints: ["Pi TUI"], environment: ["isolated HOME"], residualRisks: [], deferredWork: [], suggestedAcceptanceBoundaries: ["feature works"] }, bytes = `${JSON.stringify(artifact)}\n`; await writeFile(handoff, bytes);
  const qaInit = join(root, "qa-init.jsonl"), sha256 = createHash("sha256").update(bytes).digest("hex"), qaCharter = { ...started.charter, handoff: { path: relative, schemaVersion: 1, sha256 } }; await save(qaInit, [{ ...started, runId: "QH-valid", charter: qaCharter }]); run(["init", join(root, ".pi/qa-runs/QH-valid"), qaInit], 0, root);
  const tamperedBytes = `${JSON.stringify({ ...artifact, parent: { ...artifact.parent, promise: "Altered promise" } })}\n`, tamperedSha = createHash("sha256").update(tamperedBytes).digest("hex"), tamperedInit = join(root, "qa-tampered-init.jsonl"); await writeFile(handoff, tamperedBytes); await save(tamperedInit, [{ ...started, runId: "QH-tampered", charter: { ...started.charter, handoff: { path: relative, schemaVersion: 1, sha256: tamperedSha } } }]); assert.match(run(["init", join(root, ".pi/qa-runs/QH-tampered"), tamperedInit], 1, root).stderr, /handoff parent does not match/);
});

test("charter requirements require unique stable kebab-case IDs", async () => {
  const cases = [
    { acceptance: [{ id: "Duration Persistence", text: "Duration remains 7s" }], message: /must be stable kebab-case/ },
    { acceptance: [{ id: "duration-persistence", text: "One" }, { id: "duration-persistence", text: "Two" }], message: /duplicate acceptance requirement ID/ },
  ];
  for (const [index, value] of cases.entries()) {
    const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, `requirements-${index}`), init = join(root, "init.jsonl");
    await save(init, [{ ...started, runId: `requirements-${index}`, charter: { ...started.charter, acceptance: value.acceptance } }]);
    assert.match(run(["init", runDir, init], 1).stderr, value.message);
  }
});

test("scenarios reject unknown acceptance requirement references", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "unknown-requirement"), init = join(root, "init.jsonl"), fragment = join(root, "round.jsonl");
  await save(init, [{ ...started, runId: "unknown-requirement" }]); run(["init", runDir, init]);
  await save(fragment, [
    { v: 1, type: "round.started", round: 1, objective: "initial" },
    { v: 1, type: "scenario.checked", round: 1, scenarioId: "reload", requirementIds: ["unknown-requirement"], status: "pass", findingIds: [], evidence, notes: "Observed" },
  ]);
  assert.match(run(["append", runDir, fragment], 1).stderr, /unknown scenario requirement: unknown-requirement/);
});

test("round closure requires coverage of every acceptance requirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "partial-coverage"), init = join(root, "init.jsonl"), fragment = join(root, "round.jsonl");
  const charter = { ...started.charter, acceptance: [...started.charter.acceptance, { id: "narrow-viewport", text: "Duration remains visible when narrow" }] };
  await save(init, [{ ...started, runId: "partial-coverage", charter }]); run(["init", runDir, init]);
  await save(fragment, [
    { v: 1, type: "round.started", round: 1, objective: "initial" },
    { v: 1, type: "scenario.checked", round: 1, scenarioId: "reload", requirementIds: ["duration-persistence"], status: "pass", findingIds: [], evidence, notes: "Observed" },
    { v: 1, type: "round.closed", round: 1, outcome: "no-findings" },
  ]);
  assert.match(run(["append", runDir, fragment], 1).stderr, /round cannot close without requirement coverage: narrow-viewport/);
});

test("findings and repairs obey the human-gated round phases", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-gate-")), base = async (name, events) => { const runDir = join(root, name), init = join(root, `${name}-init.jsonl`), fragment = join(root, `${name}.jsonl`); await save(init, [{ ...started, runId: name }]); run(["init", runDir, init]); await save(fragment, events); return { runDir, fragment }; };
  const finding = repairedRun[1], scenario = repairedRun[2], close = { v: 1, type: "round.closed", round: 1, outcome: "findings" };
  const noSelection = await base("no-selection", [{ v: 1, type: "round.started", round: 1, objective: "initial" }, finding, scenario, close]); assert.match(run(["append", noSelection.runDir, noSelection.fragment], 1).stderr, /requires a human selection/);
  const lateFinding = await base("late-finding", [{ v: 1, type: "round.started", round: 1, objective: "initial" }, { ...scenario, status: "pass", findingIds: [] }, finding]); assert.match(run(["append", lateFinding.runDir, lateFinding.fragment], 1).stderr, /findings must precede every scenario/);
  const selected = { v: 1, type: "human.selected", round: 1, action: "fix", findingIds: ["F001"] };
  const noFix = await base("no-fix", [{ v: 1, type: "round.started", round: 1, objective: "initial" }, finding, scenario, selected, close]); assert.match(run(["append", noFix.runDir, noFix.fragment], 1).stderr, /requires one fix/);
  const noVerification = await base("no-verification", [{ v: 1, type: "round.started", round: 1, objective: "initial" }, finding, scenario, selected, repairedRun[4], close]); assert.match(run(["append", noVerification.runDir, noVerification.fragment], 1).stderr, /requires terminal verification/);
  const unrelated = await base("unrelated-selection", [{ v: 1, type: "round.started", round: 1, objective: "initial" }, finding, { ...scenario, status: "pass", findingIds: [] }, selected]); assert.match(run(["append", unrelated.runDir, unrelated.fragment], 1).stderr, /not open and observed in this round/);
});

test("no-findings closure requires passing final verification evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-final-check-")), runDir = join(root, "failed-check"), init = join(root, "init.jsonl"), fragment = join(root, "events.jsonl"); await save(init, [{ ...started, runId: "failed-check" }]); run(["init", runDir, init]);
  await save(fragment, [{ v: 1, type: "round.started", round: 1, objective: "initial" }, { v: 1, type: "scenario.checked", round: 1, scenarioId: "reload", requirementIds: ["duration-persistence"], status: "pass", findingIds: [], evidence, notes: "Observed" }, { v: 1, type: "round.closed", round: 1, outcome: "no-findings" }, { v: 1, type: "run.closed", reason: "no-findings", acceptedOpenFindingIds: [], verificationChecks: [{ command: "npm test", status: "failed", exitCode: 1, evidence: [{ kind: "command", ref: "npm test failed" }] }], worktreeStatus: [] }]);
  assert.match(run(["append", runDir, fragment], 1).stderr, /requires every final verification check to pass/);
});

test("run tooling rejects an unpinned agent-tty version", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "Q005"), init = join(root, "init.jsonl");
  await save(init, [{ ...started, runId: "Q005", tooling: { ...started.tooling, agentTtyVersion: "0.5.1" } }]);
  assert.match(run(["init", runDir, init], 1).stderr, /agentTtyVersion must be 0\.5\.0/);
});

test("invalid closure cannot mutate the canonical ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "Q002"), init = join(root, "init.jsonl"), fragment = join(root, "invalid.jsonl");
  await save(init, [{ ...started, runId: "Q002" }]); run(["init", runDir, init]);
  await save(fragment, [
    { v: 1, type: "round.started", round: 1, objective: "initial" },
    { v: 1, type: "scenario.checked", round: 1, scenarioId: "blocked", requirementIds: ["duration-persistence"], status: "blocked", findingIds: [], evidence: [{ kind: "note", ref: "PTY unavailable" }], notes: "Harness blocked" },
    { v: 1, type: "round.closed", round: 1, outcome: "no-findings" },
  ]);
  const before = await readFile(join(runDir, "events.jsonl"), "utf8");
  assert.match(run(["append", runDir, fragment], 1).stderr, /round outcome must be blocked/);
  assert.equal(await readFile(join(runDir, "events.jsonl"), "utf8"), before);
});

test("finding IDs are allocated monotonically", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "Q004"), init = join(root, "init.jsonl"), fragment = join(root, "skipped-id.jsonl");
  await save(init, [{ ...started, runId: "Q004" }]); run(["init", runDir, init]);
  await save(fragment, [
    { v: 1, type: "round.started", round: 1, objective: "initial" },
    { ...repairedRun[1], findingId: "F002" },
  ]);
  assert.match(run(["append", runDir, fragment], 1).stderr, /next finding ID must be F001/);
});

test("fragments cannot assign canonical sequence numbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "Q003"), init = join(root, "init.jsonl"), fragment = join(root, "invalid-seq.jsonl");
  await save(init, [{ ...started, runId: "Q003" }]); run(["init", runDir, init]);
  await save(fragment, [{ v: 1, seq: 2, type: "round.started", round: 1, objective: "initial" }]);
  assert.match(run(["append", runDir, fragment], 1).stderr, /must omit seq/);
});

test("initialization refuses to replace authoritative QA history", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "Q006"), init = join(root, "init.jsonl");
  await save(init, [{ ...started, runId: "Q006" }]); run(["init", runDir, init]); const before = await readFile(join(runDir, "events.jsonl"), "utf8");
  assert.match(run(["init", runDir, init], 1).stderr, /already exists/); assert.equal(await readFile(join(runDir, "events.jsonl"), "utf8"), before);
});
