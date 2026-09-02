import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 110: POST /message accepts video and files. pi's rpc prompt takes
// ImageContent ONLY (rpc.md: the images field is image content) — so
// non-image media is JOURNALED ON THE TRANSCRIPT ENTRY as
// {name?, mediaType} (no base64 bloat) and the bytes are deliberately NOT
// delivered to the model. Clients (Flutter) render the file chip from the
// record. Image attachments still ride the child prompt as before.

const runner = new URL(
  "./fixtures/rpc/streaming-pi.mjs",
  import.meta.url
).pathname;

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

test("empty caption is valid with media, invalid without (issue 114)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-caption-"));
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
    await waitFor(async () =>
      (
        (await (await fetch(`${base}/api/fleet`)).json()) as {
          bots: { online: boolean }[];
        }
      ).bots.every((b) => b.online)
    );

    const post = (payload: unknown) =>
      fetch(`${base}/api/bots/aa/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    // Flutter 86 flow: empty caption + image — accepted.
    const image = await post({
      text: "",
      images: [{ mediaType: "image/png", data: "aGk=" }],
    });
    assert.equal(image.status, 200, "empty caption with image accepted");

    // Empty caption + video attachment (issue 110 media) — accepted.
    const video = await post({
      text: "",
      images: [{ mediaType: "video/mp4", data: "AAAA", name: "c.mp4" }],
    });
    assert.equal(video.status, 200, "empty caption with video accepted");

    // Empty text with NO media — still the 400 the API contract promises.
    const bare = await post({ text: "" });
    assert.equal(bare.status, 400);
    assert.deepEqual(await bare.json(), { error: "text required" });
    const blank = await post({ text: "   ", images: [] });
    assert.equal(blank.status, 400, "whitespace text, empty images array");
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});

test("video message journals a file chip on the entry (issue 110)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-attach-"));
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
    await waitFor(async () =>
      (
        (await (await fetch(`${base}/api/fleet`)).json()) as {
          bots: { online: boolean }[];
        }
      ).bots.every((b) => b.online)
    );

    // Video attachment: accepted, journaled on the entry, no base64 anywhere.
    const sent = await fetch(`${base}/api/bots/aa/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "look at this clip",
        images: [
          { mediaType: "video/mp4", data: "AAAAIGZ0bXA=", name: "demo.mp4" },
        ],
      }),
    });
    assert.equal(sent.status, 200);

    const entries = async () =>
      (
        (await (
          await fetch(`${base}/api/bots/aa/transcript`)
        ).json()) as {
          transcript: {
            role: string;
            text: string;
            attachments?: { name?: string; mediaType: string }[];
          }[];
        }
      ).transcript;
    await waitFor(async () =>
      (await entries()).some(
        (e) => e.role === "user" && e.attachments?.length === 1
      )
    );
    const entry = (await entries()).find(
      (e) => e.role === "user" && e.attachments?.length === 1
    );
    assert.deepEqual(entry?.attachments, [
      { mediaType: "video/mp4", name: "demo.mp4" },
    ]);
    assert.ok(
      !JSON.stringify(entry).includes("AAAA"),
      "no base64 journaled on the transcript"
    );
    assert.equal(entry?.text, "look at this clip", "text unchanged");

    // PDF without a name: record carries the media type alone.
    await fetch(`${base}/api/bots/aa/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "the report",
        images: [{ mediaType: "application/pdf", data: "JVBERiA=" }],
      }),
    });
    await waitFor(async () =>
      (await entries()).some(
        (e) => e.role === "user" && e.text === "the report"
      )
    );
    const pdf = (await entries()).find(
      (e) => e.role === "user" && e.text === "the report"
    );
    assert.deepEqual(pdf?.attachments, [{ mediaType: "application/pdf" }]);
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
