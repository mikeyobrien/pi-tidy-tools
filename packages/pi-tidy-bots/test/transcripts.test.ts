import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTranscriptStore,
  mergeTranscriptHistory,
  paginateTranscript,
} from "../src/transcripts.ts";

const entry = (text: string, ts: string) => ({
  id: `id-${text}`,
  role: "user" as const,
  origin: "operator" as const,
  text,
  ts,
});

test("pagination rejects fractional and non-numeric limits (issue 180)", () => {
  const entries = [1, 2, 3].map((n) => ({
    ts: new Date(2026, 0, n).toISOString(),
  }));
  assert.deepEqual(
    paginateTranscript(entries, { limit: "2.7" }),
    { ok: false, error: "limit must be a positive integer" },
    "fractional rejected, not silently floored"
  );
  assert.deepEqual(paginateTranscript(entries, { limit: "abc" }), {
    ok: false,
    error: "limit must be a positive integer",
  });
  assert.deepEqual(paginateTranscript(entries, { limit: "0" }), {
    ok: false,
    error: "limit must be a positive integer",
  });
  const ok = paginateTranscript(entries, { limit: "2" });
  assert.equal(ok.ok && ok.entries.length, 2, "integer limit works");
});

test("transcript store persists across a restart and rotates at the cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-transcripts-"));
  try {
    const first = createTranscriptStore(dir, 200);
    first.append("forge", entry("one", "2026-08-31T10:00:00Z"));
    first.append("forge", entry("two", "2026-08-31T10:01:00Z"));
    first.append("forge", entry("three", "2026-08-31T10:02:00Z"));
    first.append("forge", entry("four", "2026-08-31T10:03:00Z"));
    assert.equal(existsSync(join(dir, "forge.jsonl.1")), true, "rotated once");

    // Fresh store = fake restart: journal read returns both generations.
    const second = createTranscriptStore(dir, 200);
    const loaded = second.load("forge") as { text: string }[];
    assert.deepEqual(
      loaded.map((e) => e.text),
      ["one", "two", "three", "four"]
    );
    assert.equal(
      statSync(join(dir, "forge.jsonl")).size < 200,
      true,
      "current generation stays under the cap"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeTranscriptHistory dedupes across drift timestamps and sorts", () => {
  // Verifier reproduction (issue 20 item 7 FAIL): the journal ts (daemon
  // append time) and the child-mapped ts differ by milliseconds, so a
  // ts-aware dedupe key never matched — 4 seeded entries became 8 with
  // scrambled chronology after one restart.
  const journaled = [
    entry("one", "2026-08-31T10:00:00.100Z"),
    entry("two", "2026-08-31T10:01:00.097Z"),
    entry("three", "2026-08-31T10:02:00.102Z"),
    entry("four", "2026-08-31T10:03:00.099Z"),
  ];
  // Same four messages as the child reports them (ts drifted 1-9ms), plus a
  // genuinely new message.
  const incoming = [
    entry("one", "2026-08-31T10:00:00.104Z"),
    entry("two", "2026-08-31T10:01:00.095Z"),
    entry("three", "2026-08-31T10:02:00.103Z"),
    entry("four", "2026-08-31T10:03:00.101Z"),
    entry("five", "2026-08-31T10:04:00.000Z"),
  ];
  const merged = mergeTranscriptHistory(journaled, incoming);
  assert.deepEqual(
    merged.map((e) => e.text),
    ["one", "two", "three", "four", "five"],
    "4 seeded entries stay 4 after restart; new entry appended"
  );
  // Chronology: output is sorted by ts.
  const times = merged.map((e) => Date.parse(e.ts));
  for (let i = 1; i < times.length; i++)
    assert.ok(times[i - 1] <= times[i], "chronology sorted");
});

test("mergeTranscriptHistory keeps repeated identical messages (multiset)", () => {
  // Two genuine "ok" acks: dedupe must not collapse identical texts —
  // only count-balanced duplicates are skipped.
  const journaled = [
    entry("ok", "2026-08-31T10:00:00.000Z"),
    entry("ok", "2026-08-31T10:01:00.000Z"),
  ];
  const incoming = [
    entry("ok", "2026-08-31T10:00:00.003Z"),
    entry("ok", "2026-08-31T10:01:00.002Z"),
    entry("ok", "2026-08-31T10:02:00.000Z"),
  ];
  const merged = mergeTranscriptHistory(journaled, incoming);
  assert.deepEqual(
    merged.map((e) => e.ts),
    [
      "2026-08-31T10:00:00.000Z",
      "2026-08-31T10:01:00.000Z",
      "2026-08-31T10:02:00.000Z",
    ],
    "2 journalled + 1 new = 3; the drifted copies are skipped, not the repeats"
  );
});

test("paginateTranscript: defaults preserve behavior, before/limit page back", () => {
  const entries = Array.from({ length: 10 }, (_, i) =>
    entry(`m${i}`, new Date(Date.UTC(2026, 7, 31, 10, i)).toISOString())
  );
  // No query: full transcript (today's behavior).
  const all = paginateTranscript(entries, {});
  assert.equal(all.ok, true);
  if (all.ok) assert.equal(all.entries.length, 10);
  // limit alone: last N.
  const last3 = paginateTranscript(entries, { limit: "3" });
  assert.equal(last3.ok, true);
  if (last3.ok)
    assert.deepEqual(
      last3.entries.map((e) => e.text),
      ["m7", "m8", "m9"]
    );
  // before: entries older than the cursor, most recent 50 of what remains.
  const before = paginateTranscript(entries, { before: entries[8].ts });
  assert.equal(before.ok, true);
  if (before.ok)
    assert.deepEqual(
      before.entries.map((e) => e.text),
      ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]
    );
  // before + limit.
  const beforeLimit = paginateTranscript(entries, {
    before: entries[8].ts,
    limit: "2",
  });
  assert.equal(beforeLimit.ok, true);
  if (beforeLimit.ok)
    assert.deepEqual(
      beforeLimit.entries.map((e) => e.text),
      ["m6", "m7"]
    );
  // Invalid input fails loudly.
  assert.equal(paginateTranscript(entries, { before: "not-a-date" }).ok, false);
  assert.equal(paginateTranscript(entries, { limit: "0" }).ok, false);
});
