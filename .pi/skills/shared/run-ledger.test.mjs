import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createLedgerCli } from "./run-ledger.mjs";

const validateEvent = (event, { fragment = false } = {}) => {
  assert.equal(event.v, 1); assert.ok(["run.started", "step.recorded", "run.closed"].includes(event.type));
  if (fragment) assert.equal(event.seq, undefined, "fragment events must omit seq"); else assert.ok(Number.isInteger(event.seq));
};
const reduce = (events) => {
  assert.ok(events.length); assert.equal(events[0].type, "run.started");
  events.forEach((event, index) => { validateEvent(event); assert.equal(event.seq, index + 1); });
  const closed = events.findIndex((event) => event.type === "run.closed"); assert.ok(closed < 0 || closed === events.length - 1, "events cannot follow closure");
  return { closed: closed >= 0 };
};
const renderReport = (events) => `events=${events.length}\nclosed=${reduce(events).closed}\n`;
const save = (path, events) => writeFile(path, `${events.map(JSON.stringify).join("\n")}\n`);

async function fixture(lockOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "run-ledger-")), runDir = join(root, "run"), init = join(root, "init.jsonl"), fragment = join(root, "fragment.jsonl");
  const cli = createLedgerCli({ name: "fixture-ledger", validateEvent, reduce, renderReport, refuseExisting: true, ...lockOptions });
  await save(init, [{ v: 1, type: "run.started" }]);
  return { root, runDir, init, fragment, cli };
}

test("shared ledger initializes, sequences fragments, validates, and dispatches reports", async () => {
  const { runDir, init, fragment, cli } = await fixture();
  assert.equal((await cli(["init", runDir, init])).output, join(runDir, "events.jsonl"));
  await save(fragment, [{ v: 1, type: "step.recorded" }, { v: 1, type: "run.closed" }]);
  assert.equal((await cli(["append", runDir, fragment])).output, "2 event(s) appended");
  assert.equal((await cli(["validate", runDir])).output, "3 event(s) valid");
  const custom = join(runDir, "artifacts", "custom.md"); assert.equal((await cli(["report", runDir, custom])).output, custom); assert.equal(await readFile(custom, "utf8"), "events=3\nclosed=true\n");
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
});

test("failed candidate history leaves canonical bytes unchanged", async () => {
  const { runDir, init, fragment, cli } = await fixture(); await cli(["init", runDir, init]); const before = await readFile(join(runDir, "events.jsonl"), "utf8");
  await save(fragment, [{ v: 1, type: "run.closed" }, { v: 1, type: "step.recorded" }]); await assert.rejects(cli(["append", runDir, fragment]), /events cannot follow closure/); assert.equal(await readFile(join(runDir, "events.jsonl"), "utf8"), before);
  await writeFile(fragment, "{not json}\n"); await assert.rejects(cli(["append", runDir, fragment]), /fragment\.jsonl:1/); assert.equal(await readFile(join(runDir, "events.jsonl"), "utf8"), before);
});

test("shared initialization refuses to overwrite canonical history", async () => {
  const { runDir, init, cli } = await fixture(); await cli(["init", runDir, init]); const before = await readFile(join(runDir, "events.jsonl"), "utf8"); await assert.rejects(cli(["init", runDir, init]), /already exists/); assert.equal(await readFile(join(runDir, "events.jsonl"), "utf8"), before);
});

test("concurrent appends serialize without losing accepted events", async () => {
  const { root, runDir, init, cli } = await fixture(); await cli(["init", runDir, init]); const left = join(root, "left.jsonl"), right = join(root, "right.jsonl"); await save(left, [{ v: 1, type: "step.recorded", side: "left" }]); await save(right, [{ v: 1, type: "step.recorded", side: "right" }]);
  await Promise.all([cli(["append", runDir, left]), cli(["append", runDir, right])]); const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]); assert.deepEqual(new Set(events.slice(1).map((event) => event.side)), new Set(["left", "right"]));
});

async function externalLock(path) {
  const child = spawn("flock", ["--exclusive", "--no-fork", path, process.execPath, "-e", "process.stdout.write('locked\\n'); process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((resolveReady, rejectReady) => { child.once("error", rejectReady); child.stdout.once("data", resolveReady); child.once("exit", (code) => rejectReady(new Error(`external lock exited ${code}`))); });
  return child;
}

const waitForExit = (child) => new Promise((resolveExit) => { if (child.exitCode !== null || child.signalCode !== null) resolveExit(); else child.once("exit", resolveExit); });

test("a live advisory lock times out without mutating canonical history", async () => {
  const { runDir, init, fragment, cli } = await fixture({ lockTimeoutMs: 40 }); await cli(["init", runDir, init]); await save(fragment, [{ v: 1, type: "step.recorded" }]);
  const holder = await externalLock(join(runDir, ".events.lock")); await assert.rejects(cli(["append", runDir, fragment]), /write lock timed out/); holder.stdin.end(); await waitForExit(holder);
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); assert.equal(events.length, 1);
});

test("an OS-released abandoned advisory lock needs no stale reclamation", async () => {
  const { runDir, init, fragment, cli } = await fixture(); await cli(["init", runDir, init]); await save(fragment, [{ v: 1, type: "step.recorded" }]);
  const holder = await externalLock(join(runDir, ".events.lock")); holder.kill("SIGKILL"); await waitForExit(holder); await cli(["append", runDir, fragment]);
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); assert.equal(events.length, 2);
});
