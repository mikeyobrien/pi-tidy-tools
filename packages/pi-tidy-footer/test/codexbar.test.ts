import assert from "node:assert/strict";
import test from "node:test";
import { CodexBarPoller, parseCodexBarJson, runCodexBar } from "../codexbar.js";

const payload = (used = 28) =>
  JSON.stringify({
    provider: "codex",
    source: "cli",
    usage: {
      primary: {
        usedPercent: used,
        windowMinutes: 300,
        resetsAt: "2026-07-17T20:00:00Z",
      },
      secondary: { usedPercent: 59, windowMinutes: 10_080 },
      updatedAt: "2026-07-17T18:00:00Z",
    },
  });

test("parses documented CodexBar object and array payloads", () => {
  const direct = parseCodexBarJson(payload());
  const array = parseCodexBarJson(`[${payload(140)}]`);
  assert.deepEqual(direct, {
    primary: {
      usedPercent: 28,
      windowMinutes: 300,
      resetsAt: "2026-07-17T20:00:00Z",
    },
    secondary: { usedPercent: 59, windowMinutes: 10_080 },
    updatedAt: "2026-07-17T18:00:00Z",
  });
  assert.equal(array.primary.usedPercent, 100);
});

test("rejects malformed and provider-error payloads", () => {
  assert.throws(() => parseCodexBarJson("{}"), /no Codex provider/);
  assert.throws(
    () => parseCodexBarJson('{"provider":"codex","error":{}}'),
    /provider error/
  );
  assert.throws(
    () => parseCodexBarJson('{"provider":"codex","usage":{}}'),
    /primary quota/
  );
  assert.throws(() => parseCodexBarJson("not json"), SyntaxError);
});

test("poller caches the last good snapshot and deduplicates refreshes", async () => {
  let calls = 0;
  let release!: (value: string) => void;
  const runner = () => {
    calls += 1;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };
  const poller = new CodexBarPoller(runner, 60_000);
  const first = poller.refresh();
  const second = poller.refresh();
  assert.equal(calls, 1);
  release(payload());
  await Promise.all([first, second]);
  assert.equal(poller.snapshot?.primary.usedPercent, 28);

  const failing = new CodexBarPoller(async () => {
    throw new Error("offline");
  });
  failing.snapshot = poller.snapshot;
  await failing.refresh();
  assert.equal(failing.snapshot?.primary.usedPercent, 28);
  assert.equal(failing.lastError, "offline");
});

test("stop followed by start launches a fresh request without a false error", async () => {
  let calls = 0;
  const runner = (signal: AbortSignal) => {
    calls += 1;
    if (calls === 2) return Promise.resolve(payload(12));
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  const poller = new CodexBarPoller(runner, 60_000);
  poller.start(() => {});
  assert.equal(calls, 1);
  poller.stop();
  poller.start(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  assert.equal(poller.snapshot?.primary.usedPercent, 12);
  assert.equal(poller.lastError, undefined);
  poller.stop();
});

test("parsing accepts a primary-only window and clamps negative usage", () => {
  const parsed = parseCodexBarJson(
    JSON.stringify({
      provider: "codex",
      usage: { primary: { usedPercent: -4 } },
    })
  );
  assert.deepEqual(parsed, { primary: { usedPercent: 0 } });
});

test("pre-aborted CodexBar requests do not spawn a process", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(() => runCodexBar(controller.signal), /stop/);
});
