import assert from "node:assert/strict";
import test from "node:test";
import { routineBootWarnings } from "../src/daemon.ts";

test("routineBootWarnings names bot, routine, and schedule for dead config", () => {
  const warnings = routineBootWarnings([
    { bot: "scribe", name: "nightly", schedule: "at 5" },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /routine "nightly"/);
  assert.match(warnings[0], /bot "scribe"/);
  assert.match(warnings[0], /schedule "at 5" will never fire/);
  assert.match(warnings[0], /\[reason: invalid cron\]/);
});

test("routineBootWarnings stays silent for valid schedules", () => {
  const warnings = routineBootWarnings([
    {
      bot: "scribe",
      name: "nightly",
      schedule: "0 5 * * *",
    },
    { bot: "forge", name: "sweep", schedule: "*/15 * * * *" },
    { bot: "atlas", name: "weekly", schedule: "30 9 * * 1-5" },
  ]);
  assert.deepEqual(warnings, []);
});

test("routineBootWarnings flags only the invalid rows in a mixed fleet", () => {
  const warnings = routineBootWarnings([
    {
      bot: "scribe",
      name: "nightly",
      schedule: "0 5 * * *",
    },
    { bot: "scribe", name: "broken", schedule: "at 5am" },
    { bot: "forge", name: "also-broken", schedule: "5" },
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /routine "broken"/);
  assert.match(warnings[0], /bot "scribe"/);
  assert.match(warnings[1], /routine "also-broken"/);
  assert.match(warnings[1], /bot "forge"/);
});
