import assert from "node:assert/strict";
import test from "node:test";
import { checkRoute, loadFleetConfig, ConfigError } from "../src/config.ts";
import {
  stripActionMarkers,
  attributionPrefix,
  completionNotification,
} from "../src/actions.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("loadFleetConfig rejects a manifest still carrying an actions row", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-actions-"));
  try {
    const botDir = join(dir, "atlas");
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, "AGENTS.md"), "# atlas\n");
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "atlas"\ndir = "atlas"\nactions = ["fix"]\n`
    );
    assert.throws(
      () => loadFleetConfig(dir),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes("atlas") &&
        error.message.includes("actions")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("stripActionMarkers removes [[action:]] lines from transcript text", () => {
  assert.equal(
    stripActionMarkers(
      "Not stable.\n\nGPU0 99% / 20GB\n[[action: Fix it]]\n[[action: Deep diagnostics]]\n"
    ),
    "Not stable.\n\nGPU0 99% / 20GB",
    "markers stay invisible after the pill removal"
  );
});

test("stripActionMarkers keeps text without markers intact", () => {
  assert.equal(stripActionMarkers("All green."), "All green.");
});

test("attribution and notification formatting follow the wire contracts", () => {
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
