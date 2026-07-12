import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("./qa-ledger.mjs", import.meta.url).pathname;
const run = (args, expected = 0) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  return result;
};
const save = async (path, events) => writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
const evidence = [{ kind: "capture", ref: "artifacts/reload.txt" }];
const started = {
  v: 1, type: "run.started", runId: "Q001",
  charter: { feature: "reload durations", promise: "Elapsed time survives reload", entryPoint: "interactive Pi TUI", environment: "local package", acceptance: ["Duration remains 7s"], safety: ["isolated session"], outOfScope: [] },
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
  { v: 1, type: "run.closed", reason: "no-findings", acceptedOpenFindingIds: [], verificationCommands: ["npm test", "npm run check", "git diff --check"], worktreeStatus: [" M index.ts"] },
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

test("run tooling accepts a matched safe per-run QA root", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "Q006"), init = join(root, "init.jsonl");
  await save(init, [{ ...started, runId: "Q006", tooling: { ...started.tooling, agentTtyHome: "/tmp/pi-tidy-qa-Q006/agent-tty", sessionDir: "/tmp/pi-tidy-qa-Q006/sessions" } }]);
  run(["init", runDir, init]); run(["validate", runDir]);
});

test("run tooling rejects mismatched per-run QA roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-ledger-")), runDir = join(root, "Q007"), init = join(root, "init.jsonl");
  await save(init, [{ ...started, runId: "Q007", tooling: { ...started.tooling, agentTtyHome: "/tmp/pi-tidy-qa-Q007/agent-tty", sessionDir: "/tmp/pi-tidy-qa-other/sessions" } }]);
  assert.match(run(["init", runDir, init], 1).stderr, /sessionDir must share/);
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
    { v: 1, type: "scenario.checked", round: 1, scenarioId: "blocked", requirementIds: ["reload"], status: "blocked", findingIds: [], evidence: [{ kind: "note", ref: "PTY unavailable" }], notes: "Harness blocked" },
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
