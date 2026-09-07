import assert from "node:assert/strict";
import test from "node:test";
import { runSchedulerTick } from "../src/daemon.ts";

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
