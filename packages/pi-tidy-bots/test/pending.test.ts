import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
