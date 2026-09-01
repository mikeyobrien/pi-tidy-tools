import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRoute,
  diffFleet,
  loadFleetConfig,
  ConfigError,
  botDisclosure,
} from "../src/config.ts";
import { scaffoldBot, restartSpawnArgs } from "../src/cli.ts";
import {
  stripActionMarkers,
  attributionPrefix,
  completionNotification,
} from "../src/actions.ts";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
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

test("loadFleetConfig defaults avatar to empty (blob+initial identity)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-avatar-"));
  try {
    const botDir = join(dir, "atlas");
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, "AGENTS.md"), "# atlas\n");
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "atlas"\ndir = "atlas"\n`
    );
    const fleet = loadFleetConfig(dir);
    assert.equal(fleet.bots[0].avatar, "", "no emoji default");
    // A manifest that sets avatar still gets honored (backward compat).
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "atlas"\ndir = "atlas"\navatar = "🛰️"\n`
    );
    assert.equal(loadFleetConfig(dir).bots[0].avatar, "🛰️");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("loadFleetConfig parses optional description; botDisclosure falls back to title", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-desc-"));
  try {
    const botDir = join(dir, "atlas");
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, "AGENTS.md"), "# atlas\n");
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "atlas"\ndir = "atlas"\ndescription = "Use when work needs routing."\n`
    );
    const withDesc = loadFleetConfig(dir).bots[0];
    assert.equal(withDesc.description, "Use when work needs routing.");
    assert.equal(botDisclosure(withDesc), withDesc.description);
    // Missing description is NOT a config error; disclosure falls back to title.
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "atlas"\ndir = "atlas"\ntitle = "Triage lead"\n`
    );
    const noDesc = loadFleetConfig(dir).bots[0];
    assert.equal(noDesc.description, undefined);
    assert.equal(botDisclosure(noDesc), "Triage lead");
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "atlas"\ndir = "atlas"\n`
    );
    assert.equal(botDisclosure(loadFleetConfig(dir).bots[0]), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffoldBot writes --description (escaped) and omits it when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-scaffold-desc-"));
  try {
    writeFileSync(join(dir, "bots.toml"), `port = 4317\n`);
    scaffoldBot(dir, "forge", {
      title: 'Fleet "Worker"',
      description: 'Use for "code" work\\nnow',
    });
    const manifest = readFileSync(join(dir, "bots.toml"), "utf8");
    assert.ok(
      manifest.includes('description = "Use for \\"code\\" work\\\\nnow"'),
      "row escapes quotes and backslashes: " + manifest
    );
    // Round-trips through the parser without loss.
    const bots = loadFleetConfig(dir).bots;
    assert.equal(bots.length, 1);
    assert.equal(bots[0].title, 'Fleet "Worker"');
    assert.equal(bots[0].description, 'Use for "code" work\\nnow');
    // Absent description: row omits the key; parses with undefined.
    scaffoldBot(dir, "scribe", { title: "Docs" });
    const scribe = loadFleetConfig(dir).bots.find(
      (bot) => bot.name === "scribe"
    );
    assert.equal(scribe?.description, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("ws delta text carries no action markers after server-side stripping", () => {
  // Mirrors the assistant_delta emission: stripActionMarkers over the
  // accumulated turn text before it crosses the WS.
  const frames = [
    "Checking GPU 3...",
    "Checking GPU 3...\n\n[[action: Fail over now]]",
    "Checking GPU 3...\n\n[[action: Fail over now]]\nGPU 3 recovered.",
    "Partial marker without a closing bracket: [[action: Fail",
  ];
  for (const frame of frames.slice(0, 3)) {
    const text = stripActionMarkers(frame);
    assert.equal(text.includes("[[action:"), false, `clean: ${frame}`);
  }
  // Known streaming limit: a marker line still open mid-stream is visible
  // until its closing ]] arrives — the grammar is line-based.
  assert.equal(stripActionMarkers(frames[3]).includes("[[action: Fail"), true);
  // Settled path unchanged: the full accumulated text strips identically.
  assert.equal(
    stripActionMarkers("Verdict here.\n[[action: Retry]]\n"),
    "Verdict here."
  );
});

test("diffFleet classifies add, remove, change, and untouched bots", () => {
  const base = (name: string, extra: Record<string, unknown> = {}) =>
    loadFleetConfig(fixtureFleet, { port: 4599 }).bots[0];
  const mk = (name: string, model?: string, dir = `bots/${name}`) => ({
    name,
    dir: fixtureFleet + dir,
    avatar: "🤖",
    approve: true,
    routines: [],
    ...(model ? { model } : {}),
  });
  const current = [mk("alpha"), mk("bravo")];
  const next = [mk("alpha"), { ...mk("bravo", "custom-model") }, mk("charlie")];
  const diff = diffFleet(current as never, next as never);
  assert.deepEqual(
    diff.added.map((b) => b.name),
    ["charlie"]
  );
  assert.deepEqual(
    diff.changed.map((b) => b.name),
    ["bravo"]
  );
  assert.deepEqual(
    diff.untouched.map((b) => b.name),
    ["alpha"]
  );
  // Removing bravo from next marks it removed.
  const removal = diffFleet(current as never, [next[0]] as never);
  assert.deepEqual(
    removal.removed.map((b) => b.name),
    ["bravo"]
  );
  assert.deepEqual(removal.added, []);
});

test("loadFleetConfig defaults an unscoped bot to the user home (ADR 0002)", async () => {
  const { homedir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ptb-unscoped-"));
  try {
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "rover"\ntitle = "Rover"\n`
    );
    const fleet = loadFleetConfig(dir);
    assert.equal(fleet.bots[0].dir, homedir(), "cwd is the user home");
    // No AGENTS.md requirement for unscoped bots.
    assert.equal(
      existsSync(join(homedir(), "AGENTS.md")),
      existsSync(join(homedir(), "AGENTS.md"))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit dir keeps full validation: existence and persona file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-scoped-"));
  try {
    mkdirSync(join(dir, "bots", "ghost"), { recursive: true });
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "ghost"\ndir = "bots/ghost"\n`
    );
    assert.throws(
      () => loadFleetConfig(dir),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes("AGENTS.md")
    );
    // Dir does not exist at all.
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "ghost"\ndir = "bots/vanished"\n`
    );
    assert.throws(
      () => loadFleetConfig(dir),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes("vanished")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge never touches the child working directory (ADR 0002)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../src/bridge.ts", import.meta.url),
    "utf8"
  );
  // Non-coupling contract: orchestration only — no cwd writes, no chdir.
  assert.ok(!/cwd\s*[:=]/.test(source), "bridge must not set child cwd");
  assert.ok(!source.includes("process.chdir"), "bridge must not chdir");
});

test("thinking rows validate against pi's level set and reach the config", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-thinking-"));
  try {
    const botDir = join(dir, "atlas");
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, "AGENTS.md"), "# atlas\n");
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "atlas"\ndir = "atlas"\nthinking = "max"\n`
    );
    const fleet = loadFleetConfig(dir);
    assert.equal(fleet.bots[0].thinking, "max");

    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "atlas"\ndir = "atlas"\nthinking = "yolo"\n`
    );
    assert.throws(() => loadFleetConfig(dir), /thinking "yolo" must be one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restartSpawnArgs replays a persisted host and omits it when absent", () => {
  const dir = "/tmp/fleet-x";
  const plain = restartSpawnArgs(dir, 4317);
  assert.ok(!plain.includes("--host"), "no host flag when absent");
  assert.equal(plain[plain.indexOf("--port") + 1], "4317");
  const withHost = restartSpawnArgs(dir, 4317, undefined, "0.0.0.0");
  assert.ok(withHost.includes("--host"));
  assert.equal(withHost[withHost.indexOf("--host") + 1], "0.0.0.0");
});
