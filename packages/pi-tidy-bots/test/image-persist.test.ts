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

// Issue 176: image payloads persist as fleet-side blob refs — the entry
// (echo, journal, refetch, restart rehydration) carries
// {mediaType, name?, path}; GET /api/images/:bot/:file serves the bytes
// (authed); the console renders the app's twin from the same ref. The
// journal never carries megabyte payloads (146's uncapped requests can't
// blow transcript rotation).

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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
).toString("base64");

test("image send persists blob refs; refetch/restart carry them (issue 176)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-img176-"));
  const handles: Array<{ stop(): Promise<void> }> = [];
  try {
    mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
    writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
    );
    const wrapper = join(fleetDir, "pi.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec node ${runner}\n`);
    spawnSync("chmod", ["+x", wrapper]);
    delete process.env.PTB_STUB_TRACE;

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
    await waitFor(async () =>
      (
        (await (await fetch(`${base}/api/fleet?token=sekrit`)).json()) as {
          bots: { online: boolean }[];
        }
      ).bots.every((b) => b.online)
    );

    // Send with an image.
    const sent = await fetch(`${base}/api/bots/aa/message?token=sekrit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "the screenshot",
        images: [{ mediaType: "image/png", data: PNG, name: "shot.png" }],
      }),
    });
    assert.equal(sent.status, 200);

    const transcript = async () =>
      (
        (await (
          await fetch(`${base}/api/bots/aa/transcript?token=sekrit`)
        ).json()) as {
          transcript: {
            role: string;
            text: string;
            images?: { mediaType: string; name?: string; path: string }[];
          }[];
        }
      ).transcript;
    await waitFor(async () =>
      (await transcript()).some(
        (e) => e.role === "user" && (e.images?.length ?? 0) > 0
      )
    );
    const entry = (await transcript()).find(
      (e) => e.role === "user" && (e.images?.length ?? 0) > 0
    );
    const ref = entry?.images?.[0];
    assert.equal(ref?.mediaType, "image/png");
    const file = ref?.path.split("/").pop() ?? "";
    assert.match(file, /^[0-9a-f]{16}\.png$/);
    assert.ok(
      existsSync(join(fleetDir, ".fleet", "images", "aa", file)),
      "blob on disk"
    );
    // The journal row carries the REF, not the payload.
    const journal = readFileSync(
      join(fleetDir, ".fleet", "transcripts", "aa.jsonl"),
      "utf8"
    );
    assert.ok(journal.includes(file), "journal carries the ref");
    assert.ok(
      !journal.includes(PNG.slice(0, 40)),
      "journal carries no payload"
    );

    // Serve endpoint: authed fetch returns the bytes; unauthed 401s.
    const served = await fetch(`${base}/api/images/aa/${file}?token=sekrit`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(
      Buffer.from(await served.arrayBuffer()).toString("base64"),
      PNG,
      "bytes round-trip"
    );
    const unauth = await fetch(`${base}/api/images/aa/${file}`);
    assert.equal(unauth.status, 401);
    const traversal = await fetch(
      `${base}/api/images/aa/..%2F..%2Ftoken?token=sekrit`
    );
    assert.ok(traversal.status >= 400, "traversal blocked");

    // Restart rehydration: refs survive.
    await handle.stop();
    const second = await startFleet({
      dir: fleetDir,
      port: 0,
      host: "127.0.0.1",
      token: "sekrit",
      piBin: wrapper,
      log: () => {},
    });
    handles.push(second);
    const base2 = `http://127.0.0.1:${second.port}`;
    await waitFor(
      async () => await (await fetch(`${base2}/api/fleet?token=sekrit`)).ok
    );
    await waitFor(async () => {
      const entries = (
        (await (
          await fetch(`${base2}/api/bots/aa/transcript?token=sekrit`)
        ).json()) as {
          transcript: { images?: unknown[] }[];
        }
      ).transcript;
      return entries.length > 0;
    });
    const after = (
      (await (
        await fetch(`${base2}/api/bots/aa/transcript?token=sekrit`)
      ).json()) as {
        transcript: { images?: unknown[] }[];
      }
    ).transcript;
    assert.ok(
      after.some((e) => (e.images?.length ?? 0) > 0),
      "image refs survive restart"
    );
    const reserved = await fetch(`${base2}/api/images/aa/${file}?token=sekrit`);
    assert.equal(reserved.status, 200, "blob still served after restart");
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
