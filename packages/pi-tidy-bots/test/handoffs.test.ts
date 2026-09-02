import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 58 (grok-style handoffs, daemon half): a settled teammate's report
// lands on the dispatcher as a transcript fact (kind=completion) — the
// dispatcher's session is NEVER prompted, so no ping-pong turn pollution. A
// successful bus send leaves a structured receipt (kind=handoff-receipt) on
// the sender; the receiver keeps the full brief (kind=handoff).

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

interface Entry {
  role: string;
  kind?: string;
  originFrom?: string;
  text: string;
  receipt?: { name: string; avatar?: string; title?: string };
}

test(
  "handoff images pass through uncapped (issue 75)",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-handoff-img-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    const tracePath = join(fleetDir, "stub-trace.jsonl");
    try {
      for (const bot of ["aa", "bb"]) {
        mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
        writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
      }
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n[[bot]]\nname = "bb"\ndir = "bots/bb"\n`
      );
      const wrapper = join(fleetDir, "streaming-pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);
      process.env.PTB_STUB_TRACE = tracePath;

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
      const fleet = async () =>
        (await (await fetch(`${base}/api/fleet`)).json()) as {
          bots: { name: string; online: boolean }[];
        };
      await waitFor(async () => (await fleet()).bots.every((b) => b.online));

      // TWO images (the old cap-of-one would have dropped one) in the
      // composer wire shape the bridge now forwards.
      const images = [
        {
          mediaType: "image/png",
          data: Buffer.from("png-bytes-1").toString("base64"),
        },
        {
          mediaType: "image/png",
          data: Buffer.from("png-bytes-2").toString("base64"),
        },
      ];
      const bus = await fetch(`${base}/bus/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-child": handle.childSecret,
        },
        body: JSON.stringify({
          from: "aa",
          target: "bb",
          message: "match these pixels",
          images,
        }),
      });
      const result = (await bus.json()) as { delivered?: boolean };
      assert.equal(result.delivered, true, "image handoff delivered");

      // The target's prompt carried BOTH images.
      await waitFor(() => {
        if (!existsSync(tracePath)) return false;
        const records = readFileSync(tracePath, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map(
            (line) =>
              JSON.parse(line) as {
                name?: string;
                kind?: string;
                images?: number;
              }
          );
        return records.some(
          (record) =>
            record.name === "bb" &&
            record.kind === "prompt" &&
            record.images === 2
        );
      });

      // Malformed images are rejected at the route, not silently dropped.
      const bad = await fetch(`${base}/bus/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-child": handle.childSecret,
        },
        body: JSON.stringify({
          from: "aa",
          target: "bb",
          message: "bad images",
          images: [{ mediaType: "image/png" }],
        }),
      });
      assert.equal(bad.status, 400);
      assert.equal(
        ((await bad.json()) as { reason?: string }).reason,
        "invalid_images"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test(
  "handoff round-trip: no dispatcher prompt, completion + receipt entries",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-handoffs-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    const tracePath = join(fleetDir, "stub-trace.jsonl");
    try {
      for (const bot of ["aa", "bb"]) {
        mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
        writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
      }
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ntitle = "Sender"\navatar = "A"\ndir = "bots/aa"\n` +
          `[[bot]]\nname = "bb"\ntitle = "Worker"\navatar = "B"\ndir = "bots/bb"\n`
      );
      const wrapper = join(fleetDir, "streaming-pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);
      // Stub children inherit this: every inbound request is traced.
      process.env.PTB_STUB_TRACE = tracePath;

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

      const fleet = async () =>
        (await (await fetch(`${base}/api/fleet`)).json()) as {
          bots: { name: string; online: boolean }[];
        };
      await waitFor(async () => (await fleet()).bots.every((b) => b.online));

      const transcript = async (bot: string): Promise<Entry[]> =>
        (
          (await (
            await fetch(`${base}/api/bots/${bot}/transcript`)
          ).json()) as { transcript: Entry[] }
        ).transcript;

      // Bus handoff aa → bb (child secret is exposed for exactly this).
      const bus = await fetch(`${base}/bus/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-child": handle.childSecret,
        },
        body: JSON.stringify({
          from: "aa",
          target: "bb",
          message: "do the thing",
        }),
      });
      assert.equal(
        ((await bus.json()) as { delivered?: boolean }).delivered,
        true,
        "handoff delivered"
      );

      // Receiver keeps the full brief as kind=handoff.
      await waitFor(async () =>
        (await transcript("bb")).some(
          (e) => e.kind === "handoff" && e.originFrom === "aa"
        )
      );

      // Issue 128: NO standalone receipt entry — the chip lives on the
      // message_agent tool part (asserted in the dispatch test below);
      // legacy entries in existing history stay renderable.
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(
        (await transcript("aa")).some((e) => e.kind === "handoff-receipt"),
        false,
        "no standalone receipt entry (single surface)"
      );

      // bb's turn settles → the completion lands on aa as a transcript fact.
      await waitFor(async () =>
        (await transcript("aa")).some(
          (e) => e.kind === "completion" && e.originFrom === "bb"
        )
      );

      // THE point: aa's session was never prompted — no prompt/follow_up
      // ever reached the sender child. The trace records every inbound
      // request for every stub child in this fleet.
      await new Promise((r) => setTimeout(r, 1500));
      const trace = existsSync(tracePath)
        ? readFileSync(tracePath, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line))
        : [];
      const senderPrompts = trace.filter(
        (record: { name?: string; kind?: string }) =>
          record.name === "aa" &&
          (record.kind === "prompt" || record.kind === "follow_up")
      );
      assert.equal(
        senderPrompts.length,
        0,
        `dispatcher must not be prompted on completion — saw: ${JSON.stringify(senderPrompts)}`
      );
      assert.ok(
        trace.some(
          (record: { name?: string; kind?: string }) =>
            record.name === "bb" && record.kind === "prompt"
        ),
        "the target did get the brief"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test(
  "dispatch chip on the message_agent tool part: receipt + bounded reason (issue 128)",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-dispatch-chip-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    try {
      for (const bot of ["aa", "bb"]) {
        mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
        writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
      }
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ntitle = "Sender"\navatar = "A"\ndir = "bots/aa"\n` +
          `[[bot]]\nname = "bb"\ntitle = "Worker"\navatar = "B"\ndir = "bots/bb"\n`
      );
      const wrapper = join(fleetDir, "streaming-pi.sh");
      writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
      spawnSync("chmod", ["+x", wrapper]);
      process.env.PTB_STUB_DISPATCH = "1";
      delete process.env.PTB_STUB_MULTI;
      // Earlier tests leave a PTB_STUB_TRACE pointing at deleted dirs.
      process.env.PTB_STUB_TRACE = join(fleetDir, "trace.jsonl");

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

      await fetch(`${base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "dispatch please" }),
      });
      const entries = async () =>
        (
          (await (await fetch(`${base}/api/bots/aa/transcript`)).json()) as {
            transcript: {
              role: string;
              parts?: {
                type: string;
                tool?: string;
                reason?: string;
                receipt?: { name: string; avatar?: string; title?: string };
              }[];
            }[];
          }
        ).transcript;
      await waitFor(
        async () =>
          (await entries()).some(
            (e) =>
              e.role === "assistant" &&
              (e.parts ?? []).some((part) => part.receipt?.name === "bb")
          ),
        30000
      );
      const turn = (await entries()).find(
        (e) =>
          e.role === "assistant" &&
          (e.parts ?? []).some((part) => part.receipt?.name === "bb")
      );
      const part = turn?.parts?.find((p) => p.receipt?.name === "bb");
      assert.equal(part?.tool, "message_agent");
      assert.deepEqual(part?.receipt, {
        name: "bb",
        avatar: "B",
        title: "Worker",
      }, "structured receipt from bot config");
      assert.ok(
        (part?.reason ?? "").length <= 60,
        `reason bounded — got ${part?.reason?.length} chars`
      );
      assert.ok(
        !(part?.reason ?? "").includes("report hashes"),
        "reason is a gist, not the full brief"
      );
    } finally {
      delete process.env.PTB_STUB_DISPATCH;
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
