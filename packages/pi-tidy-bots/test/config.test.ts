import assert from "node:assert/strict";
import test from "node:test";
import { checkRoute, loadFleetConfig, ConfigError } from "../src/config.ts";
import {
  parseActions,
  parseAction,
  actionPrompt,
  attributionPrefix,
  completionNotification,
} from "../src/actions.ts";

const fixtureFleet = new URL("./fixtures/fleet/", import.meta.url).pathname;

test("loadFleetConfig parses the fixture fleet with defaults", () => {
  const fleet = loadFleetConfig(fixtureFleet, { port: 4599 });
  assert.equal(fleet.bots.length, 2);
  assert.equal(fleet.port, 4599, "override wins over manifest");
  const atlas = fleet.bots[0];
  assert.equal(atlas.name, "atlas");
  assert.deepEqual(atlas.routes, ["forge"], "manifest routes load");
  assert.ok(atlas.approve, "approve defaults true");
});

test("loadFleetConfig fails fast naming bot and field", () => {
  assert.throws(() => loadFleetConfig("/nonexistent-fleet"), /no bots\.toml/);
});

test("checkRoute enforces routing table with typed reasons", () => {
  const bots = loadFleetConfig(fixtureFleet).bots;
  const route = checkRoute("atlas", "forge", bots);
  assert.ok(route.ok, "atlas → forge allowed by default");
  if (route.ok) assert.equal(route.target.name, "forge");
  assert.deepEqual(checkRoute("atlas", "ghost", bots), {
    ok: false,
    reason: "unknown_target",
  });
  const restricted = bots.map((bot) =>
    bot.name === "atlas" ? { ...bot, routes: ["watcher"] } : bot
  );
  assert.deepEqual(checkRoute("atlas", "forge", restricted), {
    ok: false,
    reason: "route_forbidden",
  });
});

test("parseActions strips trailing action markers into buttons", () => {
  const parsed = parseActions(
    "Not stable.\n\nGPU0 99% / 20GB\n[[action: Fix it]]\n[[action: Deep diagnostics]]\n"
  );
  assert.equal(parsed.text, "Not stable.\n\nGPU0 99% / 20GB");
  assert.deepEqual(parsed.actions, [
    { id: "fix it", label: "Fix it" },
    { id: "deep diagnostics", label: "Deep diagnostics" },
  ]);
});

test("action ids are stable and independent of display wording", () => {
  assert.deepEqual(parseAction("fix | Fix it"), { id: "fix", label: "Fix it" });
  assert.deepEqual(parseAction("Fix it"), { id: "fix it", label: "Fix it" });
});

test("parseActions keeps text without markers intact", () => {
  assert.deepEqual(parseActions("All green."), {
    text: "All green.",
    actions: [],
  });
});

test("action and notification formatting follow the wire contracts", () => {
  assert.equal(
    actionPrompt({ id: "fix", label: "Fix it" }),
    'Operator triggered action "Fix it" (action: fix).'
  );
  assert.match(
    attributionPrefix("atlas"),
    /^Message from 🤖 atlas \(@atlas\):$/
  );
  assert.ok(
    completionNotification("forge", "Bounced. Back on :9090.").startsWith(
      "[completion from 🤖 forge (@forge)]\nBounced."
    )
  );
  assert.match(
    completionNotification("forge", "offline", "runtime_offline"),
    /\[reason: runtime_offline\]$/
  );
  const long = "x".repeat(2000);
  assert.ok(completionNotification("forge", long).length < 2000);
});
