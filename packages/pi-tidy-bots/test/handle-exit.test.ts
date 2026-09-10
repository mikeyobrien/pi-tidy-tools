import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// handleExit used to null runtime.turnId before the mid-turn interrupt
// check, so a child death (model-swap respawn, crash) never emitted
// bubble phase:final. The UI last bubble then stayed stuck. This
// lifecycle test is the regression: live turnId → SIGKILL → final
// with that same dying turnId. The stub never settles, so the only
// legal final is handleExit's.

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 20000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met in time");
}

function ledgerPid(fleetDir: string, bot: string): number {
  const raw = readFileSync(
    join(fleetDir, ".fleet", "children", `${bot}.pid`),
    "utf8"
  ).trim();
  return Number(
    raw.startsWith("{") ? (JSON.parse(raw) as { pid: number }).pid : raw
  );
}

test(
  "handleExit lifecycle: mid-turn child death emits bubble phase:final with dying turnId",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-handle-exit-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    const hangStub = join(fleetDir, "hang-pi.mjs");
    writeFileSync(
      hangStub,
      `import { createInterface } from "node:readline";
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.type === "get_state") {
    send({ type: "response", id: request.id, success: true, data: { model: { contextWindow: 128000 } } });
    return;
  }
  if (request.type === "get_messages") {
    send({ type: "response", id: request.id, success: true, data: { messages: [] } });
    return;
  }
  if (request.type === "prompt") {
    send({ type: "turn_start" });
    send({ type: "agent_start" });
    // Hang mid-turn. No agent_settled — the only phase:final must come
    // from handleExit capturing turnId before it is nulled.
  }
  if (request.id !== undefined && request.type) {
    send({ type: "response", id: request.id, success: true });
  }
});
setInterval(() => {}, 1 << 30);
`
    );
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      const wrapper = join(fleetDir, "pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${hangStub}\n`);
      spawnSync("chmod", ["+x", wrapper]);

      const { startFleet } = await import("../src/daemon.ts");
      const handle = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        piBin: wrapper,
        log: () => {},
      });
      handles.push(handle);
      const base = `http://127.0.0.1:${handle.port}`;
      await waitFor(async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );

      const bubbles: {
        type: string;
        phase?: string;
        turnId?: string | null;
        bot?: string;
      }[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/ws`);
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as (typeof bubbles)[number];
        if (frame.type === "bubble") bubbles.push(frame);
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });

      void fetch(`${base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "stay mid-turn" }),
      });

      await waitFor(() =>
        bubbles.some(
          (frame) =>
            frame.phase === "working" &&
            typeof frame.turnId === "string" &&
            frame.turnId.length > 0
        )
      );
      const dyingTurnId = bubbles.find(
        (frame) => frame.phase === "working" && typeof frame.turnId === "string"
      )?.turnId;
      assert.equal(typeof dyingTurnId, "string");
      assert.ok(dyingTurnId && dyingTurnId.length > 0);

      const pid = ledgerPid(fleetDir, "aa");
      assert.ok(Number.isFinite(pid) && pid > 0, "child ledger pid");
      process.kill(pid, "SIGKILL");

      await waitFor(() =>
        bubbles.some(
          (frame) =>
            frame.phase === "final" &&
            frame.turnId === dyingTurnId &&
            frame.bot === "aa"
        )
      );
      const finals = bubbles.filter(
        (frame) => frame.phase === "final" && frame.turnId === dyingTurnId
      );
      assert.equal(
        finals.length,
        1,
        "exactly one handleExit final for the dying turn"
      );

      const transcript = async () =>
        (
          (await (await fetch(`${base}/api/bots/aa/transcript`)).json()) as {
            transcript: { role: string; text: string }[];
          }
        ).transcript;
      await waitFor(async () =>
        (await transcript()).some(
          (entry) =>
            entry.role === "system" &&
            entry.text.includes("Turn interrupted by a restart")
        )
      );

      ws.close();
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
