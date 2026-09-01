import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { tailscaleUserLogin, wsUpgradeAuthorized } from "../src/daemon.ts";

// Issue 103: Tailscale Serve identity (OpenClaw allowTailscale model). A
// non-empty Tailscale-User-Login header — injected by `tailscale serve` with
// tailnet user login, stripped from clients by the proxy — authenticates
// HTTP /api/* and WS upgrades without the token. Header absent + no token →
// 401. Token still works. Source IP alone is never trusted.

const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
  .pathname;

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met in time");
}

test("tailscaleUserLogin reads the identity header", () => {
  const headers = (login: string | null) => ({
    get: (name: string) => (name === "Tailscale-User-Login" ? login : null),
  });
  assert.equal(
    tailscaleUserLogin({ headers: headers("alice@tailnet") }),
    "alice@tailnet"
  );
  assert.equal(
    tailscaleUserLogin({ headers: headers("  ") }),
    null,
    "blank is no identity"
  );
  assert.equal(tailscaleUserLogin({ headers: headers(null) }), null);
  assert.equal(
    wsUpgradeAuthorized(
      {
        headers: {
          authorization: undefined,
          "tailscale-user-login": "bob@tailnet",
        },
      } as never,
      new URL("ws://x/api/ws"),
      "sekrit"
    ),
    true,
    "WS upgrade authorizes on Tailscale identity"
  );
});

test(
  "tailscale identity: 200 without token, 401 without either, token still works",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-tsauth-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      const wrapper = join(fleetDir, "streaming-pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);

      const { startFleet } = await import("../src/daemon.ts");
      const handle = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        token: "sekrit",
        piBin: wrapper,
        log: () => {},
      });
      handles.push(handle);
      const base = `http://127.0.0.1:${handle.port}`;
      const fleetUrl = `${base}/api/fleet`;

      // Header present → 200 without token (tailscale serve in front).
      const viaTailscale = await fetch(fleetUrl, {
        headers: { "Tailscale-User-Login": "alice@tailnet" },
      });
      assert.equal(viaTailscale.status, 200, "identity header authenticates");

      // Header absent + no token → 401 (phone on LTE / direct bind).
      const bare = await fetch(fleetUrl);
      assert.equal(bare.status, 401, "no identity, no token → rejected");

      // Token still works.
      const withToken = await fetch(`${fleetUrl}?token=sekrit`);
      assert.equal(withToken.status, 200, "token still authenticates");

      // Blank header is not an identity.
      const blank = await fetch(fleetUrl, {
        headers: { "Tailscale-User-Login": "   " },
      });
      assert.equal(blank.status, 401, "blank identity rejected");

      // WS upgrade: identity header authorizes without token.
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/ws`, {
          headers: { "Tailscale-User-Login": "alice@tailnet" },
        });
        const fail = setTimeout(() => reject(new Error("ws not open")), 10000);
        ws.once("open", () => {
          clearTimeout(fail);
          ws.close();
          resolve();
        });
        ws.once("error", (error) => {
          clearTimeout(fail);
          reject(error);
        });
      });

      // WS upgrade without either → the handshake is rejected (never opens).
      const bareOutcome = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/ws`);
        ws.once("error", () => resolve("error"));
        ws.once("open", () => {
          ws.close();
          resolve("open");
        });
      });
      assert.equal(bareOutcome, "error", "no identity WS is rejected");
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
