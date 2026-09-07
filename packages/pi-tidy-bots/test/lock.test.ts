import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFleetLock, isFleetLockFree } from "../src/lock.ts";

function freshFleetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tidy-bots-lock-"));
  return dir;
}

test("lock is acquired, heartbeats, and releases cleanly", async () => {
  const dir = freshFleetDir();
  const acquired = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 500 });
  assert.ok(acquired.ok);
  if (!acquired.ok) return;
  const before = JSON.parse(
    readFileSync(join(dir, ".fleet", "lock.json"), "utf8")
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  const after = JSON.parse(
    readFileSync(join(dir, ".fleet", "lock.json"), "utf8")
  );
  assert.notEqual(after.heartbeatAt, before.heartbeatAt, "heartbeat advances");
  acquired.lock.release();
  assert.ok(
    !existsSync(join(dir, ".fleet", "lock.json")),
    "release removes own lock"
  );
});

test("second acquirer is refused while lock is fresh, naming the holder", () => {
  const dir = freshFleetDir();
  const first = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 10_000 });
  assert.ok(first.ok);
  const second = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 10_000 });
  assert.ok(!second.ok);
  if (!second.ok) {
    assert.equal(second.holder.pid, process.pid);
    assert.ok(second.holder.birth.length > 0);
  }
  if (first.ok) first.lock.release();
});

test("stale lock is taken over by a new owner", async () => {
  const dir = freshFleetDir();
  const path = join(dir, ".fleet", "lock.json");
  mkdirSync(join(dir, ".fleet"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      pid: 999_999,
      birth: "dead-owner",
      host: "local",
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );
  const acquired = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 1_000 });
  assert.ok(acquired.ok, "stale lock must be takeable");
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.notEqual(after.birth, "dead-owner");
  if (acquired.ok) acquired.lock.release();
});

test("dead holder with a fresh heartbeat is an orphan (issue 178)", () => {
  const dir = freshFleetDir();
  const path = join(dir, ".fleet", "lock.json");
  mkdirSync(join(dir, ".fleet"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      pid: 999_999,
      birth: "killed-mid-exit",
      host: "local",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })
  );
  assert.equal(
    isFleetLockFree(dir, 10_000),
    true,
    "dead pid is free even when heartbeat is fresh"
  );
  const acquired = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 10_000 });
  assert.ok(
    acquired.ok,
    "replacement boot must take over a dead holder's leftover lock"
  );
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.notEqual(after.birth, "killed-mid-exit");
  if (acquired.ok) acquired.lock.release();
});

test("live holder with a fresh heartbeat still refuses (issue 178)", () => {
  const dir = freshFleetDir();
  const first = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 10_000 });
  assert.ok(first.ok);
  assert.equal(isFleetLockFree(dir, 10_000), false, "live owner is not free");
  const second = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 10_000 });
  assert.ok(!second.ok, "must not steal from a live owner");
  if (first.ok) first.lock.release();
  assert.equal(isFleetLockFree(dir, 10_000), true, "release frees the lock");
});
