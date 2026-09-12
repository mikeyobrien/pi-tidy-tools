import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompactingFromGetState } from "../src/daemon.ts";

// Abort mid-summarization left compacting latched and idle compact
// re-arming every 15s as delivery_failed. Failed compact must clear the
// latch, surface summarization_aborted, unblock prompts, and not loop.

const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
  .pathname;

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 20000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor: condition not met in time");
}

function compactAsks(tracePath: string): number {
  if (!existsSync(tracePath)) return 0;
  return readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((line) => line.includes('"kind":"compact"')).length;
}

function journal(fleetDir: string) {
  const path = join(fleetDir, ".fleet", "compactions.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function boot(fleetDir: string) {
  const wrapper = join(fleetDir, "pi.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
  spawnSync("chmod", ["+x", wrapper]);
  const { startFleet } = await import("../src/daemon.ts");
  const handle = await startFleet({
    dir: fleetDir,
    port: 0,
    host: "127.0.0.1",
    piBin: wrapper,
    log: () => {},
  });
  const base = `http://127.0.0.1:${handle.port}`;
  await waitFor(async () =>
    (
      (await (await fetch(`${base}/api/fleet`)).json()) as {
        bots: { online: boolean }[];
      }
    ).bots.every((b) => b.online)
  );
  return { handle, base };
}

test("isCompactingFromGetState reads the child latch", () => {
  assert.equal(
    isCompactingFromGetState({ data: { isCompacting: true } }),
    true
  );
  assert.equal(
    isCompactingFromGetState({ data: { isCompacting: false } }),
    false
  );
  assert.equal(isCompactingFromGetState({ isCompacting: true }), true);
  assert.equal(isCompactingFromGetState({ data: { model: {} } }), undefined);
});

test(
  "abort compact: clears latch, surfaces error, unblocks prompts, no loop",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-abort-"));
    const tracePath = join(fleetDir, "stub-trace.jsonl");
    const keys = [
      "PTB_STUB_USAGE",
      "PTB_STUB_COMPACT_ABORT",
      "PTB_STUB_COMPACT_ABORT_STICKY",
      "PTB_STUB_TRACE",
    ];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      process.env.PTB_STUB_USAGE = "90000";
      process.env.PTB_STUB_COMPACT_ABORT = "1";
      process.env.PTB_STUB_COMPACT_ABORT_STICKY = "1";
      process.env.PTB_STUB_TRACE = tracePath;
      const { handle, base } = await boot(fleetDir);
      try {
        const send = (text: string) =>
          fetch(`${base}/api/bots/aa/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
        const transcript = () =>
          fetch(`${base}/api/bots/aa/transcript`).then(
            (res) =>
              res.json() as Promise<{
                transcript: { role: string; text: string }[];
              }>
          );

        assert.equal((await send("fill")).status, 200);
        await waitFor(async () =>
          (await transcript()).transcript.some(
            (e) => e.role === "system" && /summarization_aborted/.test(e.text)
          )
        );

        const rows = journal(fleetDir);
        const failure = rows.find((r) => r.success === false);
        assert.ok(failure, "abort journaled");
        assert.equal(failure?.error, "summarization_aborted");
        assert.equal(
          rows.filter((r) => r.success === false).length,
          1,
          "exactly one abort journal row"
        );

        const entries = (await transcript()).transcript;
        assert.equal(
          entries.filter((e) => /summarization_aborted/.test(e.text)).length,
          1
        );
        assert.equal(
          entries.filter((e) =>
            /retrying at the next settled boundary/.test(e.text)
          ).length,
          0
        );
        assert.equal(
          entries.filter((e) =>
            /Context management FAILED \(delivery_failed\)/.test(e.text)
          ).length,
          0
        );

        const asksAfterAbort = compactAsks(tracePath);
        assert.ok(asksAfterAbort >= 1, "compact was asked");

        for (let i = 0; i < 3; i++) {
          const res = await send(`turn-${i}`);
          assert.equal(res.status, 200, "prompt unblocked after abort");
          await waitFor(async () => {
            const done = (await transcript()).transcript.filter(
              (e) => e.text === "done"
            ).length;
            return done >= i + 2;
          });
        }

        assert.equal(
          compactAsks(tracePath),
          asksAfterAbort,
          "auto-compact did not loop after abort"
        );
        assert.equal(
          journal(fleetDir).filter((r) => r.success === false).length,
          1,
          "no idle/threshold compact spam"
        );

        const forced = await fetch(`${base}/api/bots/aa/compact`, {
          method: "POST",
        });
        assert.equal(forced.status, 200);
        const body = (await forced.json()) as {
          compacted?: boolean;
          error?: string;
        };
        assert.equal(body.compacted, false);
        assert.equal(body.error, "summarization_aborted");
      } finally {
        await handle.stop().catch(() => {});
      }
    } finally {
      for (const key of keys) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test(
  "prompt during in-flight abort compact waits then delivers",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-abort-race-"));
    const tracePath = join(fleetDir, "stub-trace.jsonl");
    const keys = [
      "PTB_STUB_USAGE",
      "PTB_STUB_WINDOW",
      "PTB_STUB_COMPACT_ABORT",
      "PTB_STUB_COMPACT_ABORT_MS",
      "PTB_STUB_TRACE",
    ];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      process.env.PTB_STUB_USAGE = "5000";
      process.env.PTB_STUB_WINDOW = "100000";
      process.env.PTB_STUB_COMPACT_ABORT = "1";
      process.env.PTB_STUB_COMPACT_ABORT_MS = "400";
      process.env.PTB_STUB_TRACE = tracePath;
      const { handle, base } = await boot(fleetDir);
      try {
        const send = (text: string) =>
          fetch(`${base}/api/bots/aa/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
        const transcript = () =>
          fetch(`${base}/api/bots/aa/transcript`).then(
            (res) =>
              res.json() as Promise<{
                transcript: { role: string; text: string }[];
              }>
          );

        assert.equal((await send("warm")).status, 200);
        await waitFor(async () =>
          (await transcript()).transcript.some(
            (e) => e.role === "assistant" && e.text === "done"
          )
        );

        const compactP = fetch(`${base}/api/bots/aa/compact`, {
          method: "POST",
        });
        await new Promise((r) => setTimeout(r, 50));
        const messageP = send("during compact");
        const [compactRes, messageRes] = await Promise.all([
          compactP,
          messageP,
        ]);
        assert.equal(compactRes.status, 200);
        const compactBody = (await compactRes.json()) as {
          compacted?: boolean;
          error?: string;
        };
        assert.equal(compactBody.compacted, false);
        assert.equal(compactBody.error, "summarization_aborted");
        assert.equal(messageRes.status, 200, "message not delivery_failed");
        await waitFor(async () => {
          const entries = (await transcript()).transcript;
          return (
            entries.filter((e) => e.text === "done").length >= 2 &&
            entries.some((e) => /summarization_aborted/.test(e.text))
          );
        });
      } finally {
        await handle.stop().catch(() => {});
      }
    } finally {
      for (const key of keys) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
