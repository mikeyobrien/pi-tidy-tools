import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 104 (P1): transcript DEPTH — the API served only the RAM slice(-50)
// and `before=` walks died on page one. Paging params now paginate the JSONL
// journal (the complete synchronous history); the no-param hot path stays
// the RAM list.

const runner = new URL(
  "./fixtures/rpc/streaming-pi.mjs",
  import.meta.url
).pathname;

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

test("journal-backed paging: before= walks reach pre-RAM history (issue 104)", async () => {
  const fleetDir = mkdtempSync(join(tmpdir(), "ptb-depth-"));
  const handles: Array<{ stop(): Promise<void> }> = [];
  try {
    mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
    writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
    writeFileSync(
      join(fleetDir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
    );
    const wrapper = join(fleetDir, "pi.sh");
    writeFileSync(wrapper, "#!/bin/sh\nexec node " + runner + "\n");
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

    // Seed deep history directly into the journal (60 user rows — the
    // operator-hit shape: far beyond the RAM slice).
    const transcriptsDir = join(fleetDir, ".fleet", "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    const journal = join(transcriptsDir, "aa.jsonl");
    const seeded = Array.from({ length: 60 }, (_, i) => ({
      id: `seed-${i}`,
      role: "user",
      origin: "operator",
      text: `history row ${i}`,
      ts: new Date(2026, 0, 1, 0, i).toISOString(),
    }));
    writeFileSync(journal, seeded.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const fetchPage = (query: string, base = base2) =>
      fetch(`${base}/api/bots/aa/transcript${query}`).then(
        (res) => res.json() as Promise<{ transcript: { text: string; ts: string }[] }>
      );

    // Restart so the RAM merge slices to the LAST 50 (the 104 condition).
    await handle.stop();
    const second = await startFleet({
      dir: fleetDir,
      port: 0,
      host: "127.0.0.1",
      piBin: wrapper,
      log: () => {},
    });
    handles.push(second);
    const base2 = `http://127.0.0.1:${second.port}`;
    await waitFor(async () => {
      const res = await fetch(`${base2}/api/bots/aa/transcript`);
      const page = (await res.json()) as { transcript: unknown[] };
      return page.transcript.length > 0;
    }, 15000);

    // No-param: the RAM list (50 rows).
    const hot = await fetchPage("");
    assert.ok(
      hot.transcript.length > 0 && hot.transcript.length <= 50,
      `hot path serves the RAM slice (got ${hot.transcript.length})`
    );

    // limit=10: journal-backed page — 10 rows INCLUDING pre-RAM history.
    const deep = await fetchPage("?limit=10");
    assert.equal(deep.transcript.length, 10);
    assert.ok(
      deep.transcript.some((e) => e.text.startsWith("history row")),
      "depth reached"
    );

    // before= walk: page one, then a second page with rows OLDER than the
    // first page's oldest — the walk that died at HEAD.
    const page1 = await fetchPage("?limit=20");
    assert.equal(page1.transcript.length, 20);
    const oldest1 = page1.transcript[0]?.ts;
    assert.ok(oldest1, "page one has an oldest row");
    const page2 = await fetchPage(`?limit=20&before=${encodeURIComponent(oldest1!)}`);
    assert.ok(
      page2.transcript.length > 0,
      "the walk continues past page one"
    );
    assert.ok(
      page2.transcript.every(
        (e) => Date.parse(e.ts) < Date.parse(oldest1!)
      ),
      "page two is strictly older"
    );

    // The full walk reaches row 0 — depth exists end to end.
    let cursor: string | undefined;
    let total = 0;
    let sawZero = false;
    for (let i = 0; i < 10; i++) {
      const page = await fetchPage(
        `?limit=50${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`
      );
      if (page.transcript.length === 0) break;
      total += page.transcript.length;
      sawZero ||= page.transcript.some((e) => e.text === "history row 0");
      cursor = page.transcript[0]?.ts;
    }
    assert.equal(total, 60, "the whole journal is walkable");
    assert.ok(sawZero, "row 0 reached");
  } finally {
    await Promise.all(handles.map((h) => h.stop().catch(() => {})));
    rmSync(fleetDir, { recursive: true, force: true });
  }
});
