import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { spawn } from "node:child_process";
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

test("quiesce freezes the heartbeat in place for staleness takeover", async () => {
  const dir = freshFleetDir();
  const path = join(dir, ".fleet", "lock.json");
  const acquired = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 400 });
  assert.ok(acquired.ok);
  if (!acquired.ok) return;
  await new Promise((resolve) => setTimeout(resolve, 120));
  const before = JSON.parse(readFileSync(path, "utf8"));
  acquired.lock.quiesce();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const frozen = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(
    frozen.heartbeatAt,
    before.heartbeatAt,
    "quiesced lock must stop heartbeating"
  );
  assert.ok(existsSync(path), "quiesce keeps the lock file");
  assert.equal(frozen.birth, before.birth, "quiesce keeps ownership identity");
  assert.equal(
    isFleetLockFree(dir, 10_000),
    false,
    "quiesced lock is still held while its heartbeat is fresh"
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    isFleetLockFree(dir, 400),
    true,
    "frozen heartbeat goes stale and permits takeover"
  );
  const takeover = acquireFleetLock(dir, { heartbeatMs: 50, staleMs: 400 });
  assert.ok(takeover.ok, "stale quiesced lock must be takeable");
  if (takeover.ok) takeover.lock.release();
});

test("recycled holder pid is not an owner (issue 178 vs pid reuse)", async () => {
  // A dead holder's pid was reused by an unrelated live process. The lock
  // must recover: staleness — not pid liveness — is the takeover authority
  // for a live-but-silent pid; a stale heartbeat recovers even then.
  const dir = freshFleetDir();
  const path = join(dir, ".fleet", "lock.json");
  mkdirSync(join(dir, ".fleet"), { recursive: true });
  const recycled = spawn(process.execPath, ["-e", "setInterval(()=>{},1<<30)"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(recycled.pid!, 0); // the "recycled" holder is provably alive
    writeFileSync(
      path,
      JSON.stringify({
        pid: recycled.pid,
        birth: "crashed-holder-whose-pid-was-reused",
        host: "local",
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      })
    );
    assert.equal(
      isFleetLockFree(dir, 10_000),
      true,
      "stale heartbeat recovers even when the pid was recycled to a live process"
    );
    const acquired = acquireFleetLock(dir, {
      heartbeatMs: 50,
      staleMs: 1_000,
    });
    assert.ok(
      acquired.ok,
      "recycled pid with stale heartbeat must be takeable"
    );
    if (acquired.ok) acquired.lock.release();
  } finally {
    recycled.kill("SIGKILL");
    await new Promise((resolve) => recycled.once("exit", resolve));
  }
});
