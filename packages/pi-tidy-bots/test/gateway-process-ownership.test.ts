import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ownedProcessIdentity,
  reconcileOwnedProcess,
  ownedGroupHasExited,
  processIdentity,
} from "../src/gateway/process-ownership.ts";
import { GatewayJournal } from "../src/gateway/journal.ts";

const launcher = fileURLToPath(
  new URL("../src/gateway/owned-launcher.mjs", import.meta.url)
);
async function until(check: () => Promise<boolean>, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error("Timed out waiting for owned fixture");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function exists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

test("trusted launcher cannot cross native boundary before durable activation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-gated-launch-"));
  const marker = join(dir, "effect");
  const token = `tidy-launch-${randomUUID()}`;
  const child = spawn(
    process.execPath,
    [
      launcher,
      token,
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`,
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] }
  );
  try {
    await ownedProcessIdentity(child.pid!, token);
    (child.stdio[3] as Writable).end();
    await exited(child);
    assert.equal(await exists(marker), false);
    assert.equal(await ownedGroupHasExited(child.pid!), true);
  } finally {
    (child.stdio[3] as Writable).destroy();
    await exited(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("activation preserves environment Unicode split across private pipe chunks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-activation-unicode-"));
  const marker = join(dir, "environment.txt");
  const token = `tidy-launch-${randomUUID()}`;
  const child = spawn(
    process.execPath,
    [
      launcher,
      token,
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},process.env.EXACT_VALUE)`,
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] }
  );
  try {
    await ownedProcessIdentity(child.pid!, token);
    const frame = Buffer.from(
      JSON.stringify({ activate: token, env: { EXACT_VALUE: "雪🌊" } }) + "\n"
    );
    const split = frame.indexOf(Buffer.from("雪")) + 1;
    (child.stdio[3] as Writable).write(frame.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 20));
    (child.stdio[3] as Writable).write(frame.subarray(split));
    await until(() => exists(marker));
    await exited(child);
    assert.equal(await readFile(marker, "utf8"), "雪🌊");
  } finally {
    (child.stdio[3] as Writable).destroy();
    await exited(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGKILL of parent closes private pipe and owned launcher reaps plugin plus stubborn descendant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-parent-loss-"));
  const marker = join(dir, "native.json");
  const owner = join(dir, "owner.json");
  const plugin = join(dir, "native.mjs");
  await writeFile(
    plugin,
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'}); process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,child:child.pid})); setInterval(()=>{},1000);`
  );
  const token = `tidy-launch-${randomUUID()}`;
  const driver = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const p=spawn(process.execPath,${JSON.stringify([launcher, token, process.execPath, plugin])},{detached:true,stdio:['pipe','ignore','ignore','pipe']}); p.stdio[3].write(${JSON.stringify(JSON.stringify({ activate: token, env: {} }) + "\n")}); writeFileSync(${JSON.stringify(owner)},JSON.stringify({pid:p.pid})); setInterval(()=>{},1000);`,
    ],
    { stdio: "ignore" }
  );
  let ownedPid: number | undefined;
  try {
    await until(() => exists(marker));
    ownedPid = JSON.parse(await readFile(owner, "utf8")).pid;
    const identity = await ownedProcessIdentity(ownedPid!, token);
    driver.kill("SIGKILL");
    await exited(driver);
    await reconcileOwnedProcess(identity, 15_000);
    assert.equal(await ownedGroupHasExited(ownedPid!), true);
  } finally {
    if (driver.exitCode === null && driver.signalCode === null)
      driver.kill("SIGKILL");
    await exited(driver);
    if (ownedPid) await until(() => ownedGroupHasExited(ownedPid!), 15_000);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a surviving separately supervised child prevents reconciliation after its parent group exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-child-ownership-"));
  const path = join(dir, "gateway.sqlite");
  const journal = new GatewayJournal(path, {
    fleetId: "child-ownership-fixture",
  });
  const lease = journal.acquireWriterLease("owner", {
    ownerProcess: await processIdentity(process.pid),
  });
  const children: ChildProcess[] = [];
  let reopened: GatewayJournal | undefined;
  try {
    for (const [launchId, parentLaunchId] of [
      ["parent", undefined],
      ["worker", "parent"],
    ] as const) {
      journal.prepareOwnedLaunch(lease, {
        launchId,
        bindingId: "binding",
        ...(parentLaunchId ? { parentLaunchId } : {}),
      });
      const token = `tidy-launch-${randomUUID()}`;
      const child = spawn(
        process.execPath,
        [launcher, token, process.execPath, "-e", "setInterval(()=>{},1000)"],
        {
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        }
      );
      children.push(child);
      const identity = await ownedProcessIdentity(child.pid!, token);
      journal.recordOwnedLaunch(lease, launchId, identity);
      (child.stdio[3] as Writable).write(
        JSON.stringify({ activate: token, env: {} }) + "\n"
      );
    }
    (children[0].stdio[3] as Writable).end();
    await exited(children[0]);
    assert.equal(await ownedGroupHasExited(children[0].pid!), true);
    journal.close();
    reopened = new GatewayJournal(path, { fleetId: "child-ownership-fixture" });
    const retained = reopened.getSupervisorRecord()!.launches;
    const worker = retained.find((launch) => launch.launchId === "worker")!;
    assert.equal(worker.parentLaunchId, "parent");
    assert.equal(worker.state, "started");
    if (worker.state !== "started")
      throw new Error("Expected retained worker identity");
    await assert.rejects(reconcileOwnedProcess(worker, 50), {
      code: "ownership_unreconciled",
    });
    assert.throws(() => reopened!.completeOwnedLaunch(lease, "parent"), {
      code: "ownership_unreconciled",
    });
    (children[1].stdio[3] as Writable).end();
    await exited(children[1]);
    await reconcileOwnedProcess(worker);
    reopened.completeOwnedLaunch(lease, "worker");
    reopened.completeOwnedLaunch(lease, "parent");
    reopened.releaseWriterLease(lease, { ownershipReconciled: true });
    assert.equal(reopened.getWriterState()!.reconciled, true);
  } finally {
    for (const child of children) (child.stdio[3] as Writable).destroy();
    await Promise.all(children.map(exited));
    journal.close();
    reopened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("historical identity mismatch refuses recovery without signalling an unrelated live group", async () => {
  const token = `tidy-launch-${randomUUID()}`;
  const child = spawn(
    process.execPath,
    [launcher, token, process.execPath, "-e", "setInterval(()=>{},1000)"],
    { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] }
  );
  try {
    const identity = await ownedProcessIdentity(child.pid!, token);
    await assert.rejects(
      reconcileOwnedProcess(
        { ...identity, token: `tidy-launch-${randomUUID()}` },
        50
      ),
      { code: "ownership_unreconciled" }
    );
    assert.equal(await ownedGroupHasExited(child.pid!), false);
  } finally {
    (child.stdio[3] as Writable).end();
    await exited(child);
  }
});
