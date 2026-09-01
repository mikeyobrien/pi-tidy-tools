import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 82 (corrected): fleet-wide rules persist at {fleet}/.fleet/rules.md,
// edit via GET/PUT /api/rules ({text}; missing/empty reads "", never 404),
// and apply on the NEXT delivered prompt/followUp per bot — no respawn, no
// steer, AGENTS.md untouched. One preamble per rules version; transcripts
// keep the clean operator text.

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

test(
  "rules apply on the next delivered prompt, once per version (issue 82)",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-rules-turn-"));
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
      await waitFor(async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );

      const traced = () =>
        existsSync(tracePath)
          ? readFileSync(tracePath, "utf8")
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .map(
                (line) =>
                  JSON.parse(line) as {
                    name?: string;
                    kind?: string;
                    text?: string;
                  }
              )
          : [];
      const send = (text: string) =>
        fetch(`${base}/api/bots/aa/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });

      // 1. No rules yet: the first prompt carries the plain text.
      await send("hello");
      await waitFor(() =>
        traced().some((r) => r.name === "aa" && r.text === "hello")
      );

      // 2. PUT rules; the NEXT prompt carries the preamble exactly once.
      const put = await fetch(`${base}/api/rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Reply in haiku." }),
      });
      assert.equal(put.status, 200);
      await send("second");
      await waitFor(() =>
        traced().some(
          (r) =>
            r.name === "aa" &&
            r.text !== undefined &&
            r.text.startsWith("[fleet rules — effective this turn onward]") &&
            r.text.includes("Reply in haiku.") &&
            r.text.endsWith("second")
        )
      );

      // 3. Steady state: the following prompt is clean again.
      await send("third");
      await waitFor(() =>
        traced().some((r) => r.name === "aa" && r.text === "third")
      );

      // 4. Transcript entries keep the clean operator text.
      const transcript = await (
        await fetch(`${base}/api/bots/aa/transcript`)
      ).json();
      const texts = transcript.transcript
        .filter((e: { role: string }) => e.role === "user")
        .map((e: { text: string }) => e.text);
      assert.deepEqual(texts, ["hello", "second", "third"]);

      // 5. A NEW rules version rides the next delivery — including a bus
      //    handoff to a different bot.
      await fetch(`${base}/api/rules`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Always cite file paths." }),
      });
      await fetch(`${base}/bus/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fleet-child": handle.childSecret,
        },
        body: JSON.stringify({
          from: "aa",
          target: "bb",
          message: "the brief",
        }),
      });
      await waitFor(() =>
        traced().some(
          (r) =>
            r.name === "bb" &&
            r.text !== undefined &&
            r.text.includes("[fleet rules") &&
            r.text.includes("Always cite file paths.")
        )
      );

      // 6. Missing rules file: GET is "" (never 404); emptying stops
      //    future injections (bb's next prompt would be clean).
      assert.deepEqual(await (await fetch(`${base}/api/rules`)).json(), {
        text: "Always cite file paths.",
      });
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test("rules API round-trip: empty by default, PUT persists (issue 82)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-rules-api-"));
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
      piBin: wrapper,
      log: () => {},
    });
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    await waitFor(async () => (await fetch(`${base}/api/fleet`)).ok);

    // Missing rules file: empty text, 200 — never 404.
    const empty = await fetch(`${base}/api/rules`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { text: "" });

    // PUT persists; GET reads back; the file lands at .fleet/rules.md.
    const put = await fetch(`${base}/api/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "# Fleet rules\n\nReply tersely." }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      (await (await fetch(`${base}/api/rules`)).json()).text,
      "# Fleet rules\n\nReply tersely."
    );
    assert.equal(
      existsSync(join(fleetDir, ".fleet", "rules.md")),
      true,
      "persisted on disk"
    );

    // Clearing via empty string is valid too.
    await fetch(`${base}/api/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    assert.deepEqual(await (await fetch(`${base}/api/rules`)).json(), {
      text: "",
    });

    // Non-string body: 400.
    const bad = await fetch(`${base}/api/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: 42 }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
