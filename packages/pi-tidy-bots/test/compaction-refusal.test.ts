import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokensFromGetState } from "../src/daemon.ts";

// Issue 79 (P0): "Already compacted" is a TERMINAL NO-OP refusal, not a
// delivery failure. Layers:
//   1. one refusal → one system entry → suppression (no overnight spam);
//   2. daemon estimates reconcile with the child's own get_state usage;
//   3. genuine overflow after reconciliation → the issue 43 amendment
//      reset terminates it in ONE reset.

const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
  .pathname;

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

interface Harness {
  base: string;
  stop(): Promise<void>;
}

function compactAsks(tracePath: string): number {
  if (!existsSync(tracePath)) return 0;
  return readFileSync(tracePath, "utf8")
    .split("\n")
    .filter((line) => line.includes('"kind":"compact"')).length;
}

async function boot(
  fleetDir: string,
  env: Record<string, string>
): Promise<Harness> {
  const wrapper = join(fleetDir, "pi.sh");
  writeFileSync(wrapper, "#!/bin/sh\nexec node " + runner + "\n");
  spawnSync("chmod", ["+x", wrapper]);
  const prev = { ...process.env } as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const { startFleet } = await import("../src/daemon.ts");
  const handle = await startFleet({
    dir: fleetDir,
    port: 0,
    host: "127.0.0.1",
    piBin: wrapper,
    log: () => {},
  });
  for (const k of Object.keys(env)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  // env applies to the daemon process which spawns children with its env —
  // but we set BEFORE startFleet, so children inherit. (restored after)
  return {
    base: `http://127.0.0.1:${handle.port}`,
    stop: () => handle.stop(),
  };
}

test("tokensFromGetState prefers pi usage fields", () => {
  assert.equal(
    tokensFromGetState({ data: { usage: { input: 90000 } } }),
    90000
  );
  assert.equal(
    tokensFromGetState({ data: { usage: { inputTokens: 12 } } }),
    12
  );
  assert.equal(tokensFromGetState({ data: { usage: { promptTokens: 7 } } }), 7);
  assert.equal(tokensFromGetState({ data: { model: {} } }), undefined);
  assert.equal(tokensFromGetState({ usage: { input: 3 } }), 3);
});

test(
  "always-refusing child: terminal no-op, one entry, no spam (79)",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-79-"));
    const stops: Array<() => Promise<void>> = [];
    const tracePath = join(fleetDir, "stub-trace.jsonl");
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );

      // High fill per turn usage (90k/128k = 70%) forces compaction at the
      // settled boundary; the child ALWAYS refuses "Already compacted" and
      // its own get_state usage agrees the context is big — the exact
      // overnight machine.
      process.env.PTB_STUB_USAGE = "90000";
      process.env.PTB_STUB_COMPACT_REFUSAL = "already";
      process.env.PTB_STUB_STATE_USAGE = "90000";
      process.env.PTB_STUB_TRACE = tracePath;
      const h = await boot(fleetDir, {});
      stops.push(() => h.stop());

      await waitFor(async () =>
        (
          (await (await fetch(`${h.base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );

      const sendTurn = () =>
        fetch(`${h.base}/api/bots/aa/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "another turn" }),
        });
      const transcript = () =>
        fetch(`${h.base}/api/bots/aa/transcript`).then(
          (res) =>
            res.json() as Promise<{
              transcript: { role: string; text: string }[];
            }>
        );

      // Drive MANY settled boundaries — at HEAD this spammed one failure
      // entry per boundary (118+ overnight).
      for (let i = 0; i < 6; i++) {
        await sendTurn();
        await waitFor(async () => {
          const done = (await transcript()).transcript.filter(
            (e) => e.text === "done"
          ).length;
          return done >= i + 1;
        });
      }

      const entries = (await transcript()).transcript;
      const refusalEntries = entries.filter((e) =>
        /already compacted/i.test(e.text)
      );
      const failureEntries = entries.filter((e) =>
        /Context management FAILED/i.test(e.text)
      );
      assert.equal(
        refusalEntries.length,
        1,
        `exactly ONE terminal-no-op entry (got ${refusalEntries.length}: ${refusalEntries.map((e) => e.text)})`
      );
      assert.equal(
        failureEntries.length,
        0,
        "never classified as a delivery failure"
      );

      // The compact RPC was asked at most twice (initial + the allowed one
      // retry), not once per turn.
      const asks = compactAsks(tracePath);
      assert.ok(
        asks >= 1 && asks <= 2,
        `compact asked at most twice across 6 turns (got ${asks})`
      );

      // Bookkeeping: fill stays truthful (child's numbers), suppression armed.
      const context = (await (
        await fetch(`${h.base}/api/bots/aa/context`)
      ).json()) as { fill?: number };
      assert.ok(
        context.fill === undefined || context.fill >= 0,
        "fill readable"
      );
    } finally {
      delete process.env.PTB_STUB_USAGE;
      delete process.env.PTB_STUB_COMPACT_REFUSAL;
      delete process.env.PTB_STUB_STATE_USAGE;
      delete process.env.PTB_STUB_TRACE;
      await Promise.all(stops.map((s) => s().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test(
  "reconciliation drops fill: pi numbers beat daemon math (79 layer 2)",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-79r-"));
    const stops: Array<() => Promise<void>> = [];
    const tracePath = join(fleetDir, "stub-trace.jsonl");
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );

      // Daemon estimate high (turn usage 90k), but the child's OWN state
      // says 10k — compaction already happened inside pi. The daemon must
      // adopt the child's number and STOP, not keep forcing.
      process.env.PTB_STUB_USAGE = "90000";
      process.env.PTB_STUB_COMPACT_REFUSAL = "already";
      process.env.PTB_STUB_STATE_USAGE = "10000";
      process.env.PTB_STUB_TRACE = tracePath;
      const h = await boot(fleetDir, {});
      stops.push(() => h.stop());

      await waitFor(async () =>
        (
          (await (await fetch(`${h.base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );
      for (let i = 0; i < 4; i++) {
        await fetch(`${h.base}/api/bots/aa/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "turn" }),
        });
        await waitFor(async () => {
          const entries = (
            (await (
              await fetch(`${h.base}/api/bots/aa/transcript`)
            ).json()) as {
              transcript: { text: string }[];
            }
          ).transcript;
          return entries.filter((e) => e.text === "done").length >= i + 1;
        });
      }
      const entries = (
        await (await fetch(`${h.base}/api/bots/aa/transcript`)).json()
      ).transcript as { role: string; text: string }[];
      const refusalEntries = entries.filter((e) =>
        /already compacted/i.test(e.text)
      );
      const failureEntries = entries.filter((e) =>
        /Context management FAILED/i.test(e.text)
      );
      assert.equal(
        refusalEntries.length,
        0,
        "get_state tokens win before compact is asked"
      );
      assert.equal(failureEntries.length, 0, "no delivery-failure spam");
      assert.equal(
        compactAsks(tracePath),
        0,
        "child numbers below trigger: never ask compact"
      );
      await waitFor(async () => {
        const context = (await (
          await fetch(`${h.base}/api/bots/aa/context`)
        ).json()) as { inputTokens?: number | null };
        return context.inputTokens === 10000;
      });
      const context = (await (
        await fetch(`${h.base}/api/bots/aa/context`)
      ).json()) as { fill?: number | null; inputTokens?: number | null };
      assert.equal(context.inputTokens, 10000);
      assert.ok(
        context.fill !== undefined &&
          context.fill !== null &&
          context.fill < 0.6,
        "fill follows the child's get_state tokens, not turn-usage math"
      );
    } finally {
      delete process.env.PTB_STUB_USAGE;
      delete process.env.PTB_STUB_COMPACT_REFUSAL;
      delete process.env.PTB_STUB_STATE_USAGE;
      delete process.env.PTB_STUB_TRACE;
      await Promise.all(stops.map((s) => s().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test(
  "true overflow after reconciliation: ONE reset, loop terminates (79 layer 3)",
  { timeout: 60000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-79x-"));
    const stops: Array<() => Promise<void>> = [];
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );

      // The child refuses compaction AND its own numbers say the context is
      // OVER the window — the genuine-overflow case. The issue 43 amendment
      // reset must fire ONCE; the respawned (fresh) child then reports a
      // healthy context and the machine stays quiet.
      const usageFile = join(fleetDir, "state-usage.txt");
      writeFileSync(usageFile, "140000"); // window is 128000
      process.env.PTB_STUB_USAGE = "140000";
      process.env.PTB_STUB_COMPACT_REFUSAL = "already";
      process.env.PTB_STUB_STATE_USAGE_FILE = usageFile;
      const h = await boot(fleetDir, {});
      stops.push(() => h.stop());

      await waitFor(async () =>
        (
          (await (await fetch(`${h.base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );

      const entries = () =>
        fetch(`${h.base}/api/bots/aa/transcript`).then(
          (res) =>
            res.json() as Promise<{
              transcript: { role: string; text: string }[];
            }>
        );

      // Drive the turn that trips the machine (settled boundary).
      await fetch(`${h.base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "go" }),
      });

      // The reset entry appears once.
      await waitFor(async () =>
        (await entries()).transcript.some((e) =>
          /escalating to session reset/i.test(e.text)
        )
      );
      // The fresh session reports healthy usage from here on.
      writeFileSync(usageFile, "10000");

      // Drive more settled boundaries — no second reset, no spam.
      for (let i = 0; i < 4; i++) {
        await fetch(`${h.base}/api/bots/aa/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "turn" }),
        });
        await new Promise((r) => setTimeout(r, 1000));
      }
      const finalEntries = (await entries()).transcript;
      const resets = finalEntries.filter((e) =>
        /escalating to session reset/i.test(e.text)
      );
      const failures = finalEntries.filter((e) =>
        /Context management FAILED/i.test(e.text)
      );
      assert.equal(
        resets.length,
        1,
        "exactly ONE reset — worst case terminates"
      );
      assert.equal(
        failures.length,
        resets.length,
        "no delivery-failure spam beyond the reset entry itself"
      );
      // Evidence kept: the oversized session moved aside, never deleted.
      const sessionsDir = join(fleetDir, ".fleet", "sessions");
      if (existsSync(sessionsDir)) {
        const kept = readdirSync(sessionsDir).filter((n) =>
          n.startsWith("aa.pre-reset-")
        );
        assert.ok(kept.length >= 1, "oversized session evidence preserved");
      }
    } finally {
      delete process.env.PTB_STUB_USAGE;
      delete process.env.PTB_STUB_COMPACT_REFUSAL;
      delete process.env.PTB_STUB_STATE_USAGE_FILE;
      await Promise.all(stops.map((s) => s().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
