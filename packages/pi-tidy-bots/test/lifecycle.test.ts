import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Script coverage for the lifecycle commands (issue 29 item 3): a real
// daemonized start (detached child, pidfile), status over HTTP, and a
// graceful stop — all against a temp fleet with a stub pi binary.

const PORT = 4694;
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const stubDir = mkdtempSync(join(tmpdir(), "ptb-lifecycle-"));
const stub = join(stubDir, "stub-pi.sh");
writeFileSync(stub, "#!/bin/sh\nexit 1\n");
spawnSync("chmod", ["+x", stub]);

const fleetDir = mkdtempSync(join(tmpdir(), "ptb-lifecycle-fleet-"));
mkdirSync(join(fleetDir, "bots", "alpha"), { recursive: true });
writeFileSync(join(fleetDir, "bots", "alpha", "AGENTS.md"), "# alpha\n");
writeFileSync(
  join(fleetDir, "bots.toml"),
  `[fleet]\nport = ${PORT}\n[[bot]]\nname = "alpha"\ndir = "bots/alpha"\n`
);

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PI_TIDY_BOTS_PI_BIN: stub, ...env },
  });
}

test(
  "start --daemon, status, and stop lifecycle",
  { timeout: 45000 },
  async () => {
    // 1. Daemonized start: one JSON readiness line, pidfile written.
    const start = runCli(["start", fleetDir, "--daemon", "--json"]);
    assert.equal(start.status, 0, `start stderr: ${start.stderr}`);
    const ready = JSON.parse(start.stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(ready.port, PORT);
    assert.equal(typeof ready.pid, "number");
    assert.equal(
      existsSync(join(fleetDir, ".fleet", "daemon.pid")),
      true,
      "daemon pidfile written"
    );

    // 2. Status reports pid, port, and per-bot state.
    const status = runCli(["status", fleetDir, "--json"]);
    assert.equal(status.status, 0, `status stderr: ${status.stderr}`);
    const state = JSON.parse(status.stdout.trim());
    assert.equal(state.pid, ready.pid);
    assert.equal(state.port, PORT);
    assert.ok(
      state.bots.some((b: { name: string }) => b.name === "alpha"),
      "alpha listed"
    );

    // 3. Stop: SIGTERM via pidfile, waits for release, exits 0.
    const stop = runCli(["stop", fleetDir, "--json"]);
    assert.equal(stop.status, 0, `stop stderr: ${stop.stderr}`);
    assert.equal(JSON.parse(stop.stdout.trim()).stopped, true);
    assert.equal(
      existsSync(join(fleetDir, ".fleet", "daemon.pid")),
      false,
      "pidfile cleared"
    );

    // 4. Status after stop: fleet is not running (exit 4).
    const gone = runCli(["status", fleetDir, "--json"]);
    assert.equal(gone.status, 4);
    assert.match(gone.stderr, /fleet is not running/);

    // 5. Stop with nothing running also fails cleanly.
    const stopAgain = runCli(["stop", fleetDir]);
    assert.equal(stopAgain.status, 1);
    assert.match(stopAgain.stderr, /fleet is not running/);
  }
);

test("cleanup", () => {
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(fleetDir, { recursive: true, force: true });
});
