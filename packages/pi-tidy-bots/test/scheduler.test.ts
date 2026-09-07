import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSchedulerTick } from "../src/daemon.ts";
import { RoutineFireLedger, routineFireId } from "../src/scheduler.ts";

const DUE = new Date(2026, 7, 31, 10, 5, 0); // local 10:05 — matches "5 10 * * *"

interface Routine {
  bot: string;
  name: string;
  schedule: string;
  enabled?: boolean;
}

/** Hermetic tick harness: fire booleans queue per tick, journal rows are captured. */
function harness(routines: Routine[]) {
  const firedKeys = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  const fires: boolean[] = [];
  const deps = {
    routines: routines.map((routine) => ({
      ...routine,
      enabled: routine.enabled ?? true,
    })),
    firedKeys,
    fireRoutine: () => fires.shift() ?? false,
    journal: (record: Record<string, unknown>) => entries.push(record),
  };
  const tick = (...fire: boolean[]) => {
    fires.push(...fire);
    for (let i = 0; i < fire.length; i++) runSchedulerTick(DUE, deps);
  };
  return { firedKeys, entries, tick };
}

test("due routine with an offline bot journals skipped and keeps the minute key", () => {
  const h = harness([
    { bot: "scribe", name: "nightly", schedule: "5 10 * * *" },
  ]);
  h.tick(false);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].status, "skipped");
  assert.equal(h.entries[0].reason, "bot_offline");
  assert.equal(h.entries[0].bot, "scribe");
  assert.equal(h.entries[0].routine, "nightly");
  assert.equal(h.firedKeys.size, 0, "failed fire must not burn the minute key");
});

test("offline tick retries next tick in the same minute and journals fired on success", () => {
  const h = harness([
    { bot: "scribe", name: "nightly", schedule: "5 10 * * *" },
  ]);
  h.tick(false, true);
  assert.deepEqual(
    h.entries.map((entry) => entry.status),
    ["skipped", "fired"],
    "miss first, real fire after the bot comes back"
  );
  assert.equal(h.entries[1].key, "scribe:nightly:2026-08-31 10:05");
  // Success consumed the key: a third tick in the same minute stays silent.
  runSchedulerTick(DUE, {
    routines: [
      { bot: "scribe", name: "nightly", schedule: "5 10 * * *", enabled: true },
    ],
    firedKeys: h.firedKeys,
    fireRoutine: () => true,
    journal: (record) => h.entries.push(record),
  });
  assert.equal(
    h.entries.length,
    2,
    "no duplicate fire once the key is consumed"
  );
});

test("success path is unchanged: fired key consumed, status fired", () => {
  const h = harness([{ bot: "forge", name: "sweep", schedule: "5 10 * * *" }]);
  h.tick(true);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].status, "fired");
  assert.equal(h.entries[0].reason, undefined);
  assert.equal(h.firedKeys.has("forge:sweep:2026-08-31 10:05"), true);
});

test("not-due and disabled routines journal nothing", () => {
  const h = harness([
    { bot: "scribe", name: "later", schedule: "15 10 * * *" },
    { bot: "forge", name: "off", schedule: "5 10 * * *", enabled: false },
  ]);
  h.tick(true, true);
  assert.deepEqual(h.entries, []);
  assert.equal(h.firedKeys.size, 0);
});

test("routine fire ledger durably dedupes identities and fences owner cutover", () => {
  const dir = mkdtempSync(join(tmpdir(), "tidy-routine-ledger-"));
  const path = join(dir, ".fleet", "routine-fires.jsonl");
  try {
    const fireId = routineFireId("scribe", "nightly", "2026-08-31 10:05");
    const legacy = new RoutineFireLedger(path, "legacy-gateway");
    const first = legacy.admit(fireId);
    assert.equal(
      first.operationId,
      "op:routine:scribe:nightly:2026-08-31 10:05"
    );
    assert.deepEqual(legacy.admit(fireId), first);
    assert.throws(
      () => legacy.admit(fireId, "hermes"),
      /owner is legacy-gateway/
    );
    legacy.cutover("hermes");
    assert.equal(legacy.scheduleOwner, "hermes");
    assert.throws(
      () =>
        legacy.admit(
          routineFireId("scribe", "nightly", "2026-08-31 10:06"),
          "legacy-gateway"
        ),
      /owner is hermes/
    );
    const hermes = new RoutineFireLedger(path, "legacy-gateway");
    assert.equal(hermes.scheduleOwner, "hermes");
    assert.deepEqual(hermes.get(fireId), first);
    assert.deepEqual(hermes.admit(fireId), first);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
