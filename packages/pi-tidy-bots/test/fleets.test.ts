import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry,
  pruneRegistry,
  registerFleet,
  registryPath,
  resolveFleetRecord,
} from "../src/fleets.ts";

test("registry: upsert by name, resolve, and persistence across restarts", () => {
  const home = mkdtempSync(join(tmpdir(), "ptb-registry-"));
  try {
    const path = registryPath(home);
    assert.deepEqual(loadRegistry(path), [], "empty until first start");

    const dirA = join(home, "fleets", "a");
    const dirB = join(home, "fleets", "b");
    registerFleet(path, { name: "a", dir: dirA, port: 4317 });
    registerFleet(path, {
      name: "b",
      dir: dirB,
      port: 0,
      tokenFile: ".fleet/token",
    });
    // Upsert: same name replaces, no duplicate rows.
    registerFleet(path, { name: "a", dir: dirA, port: 4695 });

    const records = loadRegistry(path);
    assert.equal(records.length, 2);
    const a = resolveFleetRecord(path, "a");
    assert.equal(a?.port, 4695, "last writer wins");
    assert.equal(resolveFleetRecord(path, "ghost"), undefined);

    // Simulated restart: a fresh read of the same file sees everything.
    assert.deepEqual(loadRegistry(path), records);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("registry prune drops dead dirs and keeps live ones", () => {
  const home = mkdtempSync(join(tmpdir(), "ptb-registry-prune-"));
  try {
    const path = registryPath(home);
    const liveDir = join(home, "fleets", "live");
    const deadDir = join(home, "fleets", "dead");
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(deadDir, { recursive: true });
    registerFleet(path, { name: "live", dir: liveDir });
    registerFleet(path, { name: "dead", dir: deadDir });
    rmSync(deadDir, { recursive: true, force: true });
    const pruned = pruneRegistry(path);
    assert.deepEqual(
      pruned.map((entry) => entry.name),
      ["dead"]
    );
    assert.deepEqual(
      loadRegistry(path).map((entry) => entry.name),
      ["live"]
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
