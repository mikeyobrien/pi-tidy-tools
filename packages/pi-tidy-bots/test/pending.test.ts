import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPendingStore, type PendingMessage } from "../src/pending.ts";

const msg = (id: string, text: string): PendingMessage => ({
  id,
  text,
  origin: "operator",
  ts: new Date(Date.UTC(2026, 7, 31, 12, 0)).toISOString(),
});

test("pending journal: append, ordered load, remove, drop", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-pending-"));
  try {
    const store = createPendingStore(dir);
    store.append("forge", msg("id-1", "first thought"));
    store.append("forge", msg("id-2", "second thought"));
    store.append("forge", msg("id-3", "third thought"));

    // FIFO load: human-readable JSONL lines.
    const loaded = store.load("forge");
    assert.deepEqual(
      loaded.map((m) => m.id),
      ["id-1", "id-2", "id-3"]
    );

    // Delivered: remove the head, order preserved for the rest.
    store.remove("forge", "id-1");
    assert.deepEqual(
      store.load("forge").map((m) => m.id),
      ["id-2", "id-3"]
    );

    // Bot removed: journal dropped with the runtime.
    store.drop("forge");
    assert.deepEqual(store.load("forge"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending journal round-trips images and provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-pending-2-"));
  try {
    const store = createPendingStore(dir);
    store.append("scout", {
      id: "id-img",
      text: "what is this?",
      origin: "operator",
      images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      ts: "2026-08-31T12:00:00Z",
    });
    const [loaded] = store.load("scout");
    assert.deepEqual(loaded.images, [
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
    assert.equal(loaded.origin, "operator");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimClientMessageId: once per id, absent ids always claim", async () => {
  const { claimClientMessageId } = await import("../src/daemon.ts");
  const seen = new Set<string>();
  assert.equal(claimClientMessageId(seen, undefined), true);
  assert.equal(claimClientMessageId(seen, undefined), true);
  assert.equal(claimClientMessageId(seen, "cm-1"), true);
  assert.equal(claimClientMessageId(seen, "cm-1"), false, "duplicate rejected");
  const other = new Set<string>();
  assert.equal(claimClientMessageId(other, "cm-1"), true, "per-bot registry");
});

test("torn journal line salvages good rows; rewrite keeps them (issue 143)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-torn-"));
  try {
    const store = createPendingStore(dir);
    store.append("aa", {
      id: "m1",
      text: "first",
      origin: "operator",
      ts: new Date().toISOString(),
    });
    store.append("aa", {
      id: "m2",
      text: "second",
      origin: "operator",
      ts: new Date().toISOString(),
    });
    store.append("aa", {
      id: "m3",
      text: "third",
      origin: "operator",
      ts: new Date().toISOString(),
    });
    // Corrupt the MIDDLE line (crash mid-write shape: truncated JSON).
    const file = join(dir, "aa.jsonl");
    const lines = readFileSync(file, "utf8").split("\n");
    lines[1] = lines[1].slice(0, Math.max(1, lines[1].length - 20));
    writeFileSync(file, lines.join("\n"));

    const salvaged = store.load("aa");
    assert.equal(salvaged.length, 2, "good rows survive the torn line");
    assert.deepEqual(
      salvaged.map((message) => message.id),
      ["m1", "m3"],
      "order preserved around the tear"
    );

    // The rewrite-after-append must KEEP the salvaged rows (hound probe:
    // the old flow physically deleted them on the next append).
    store.append("aa", {
      id: "m4",
      text: "fourth",
      origin: "operator",
      ts: new Date().toISOString(),
    });
    assert.equal(store.load("aa").length, 3);
    const onDisk = readFileSync(file, "utf8");
    assert.ok(
      onDisk.includes("m1") && onDisk.includes("m3") && onDisk.includes("m4")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
