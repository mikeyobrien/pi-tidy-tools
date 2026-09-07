import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  evaluateFleetHealth,
  parseHealthProbeArgs,
  probeFleetHealth,
  runHealthProbeCli,
} from "../src/health-probe.ts";
import { DEFAULT_STALE_DELIVERING_MS } from "../src/delivering.ts";

const now = Date.parse("2026-09-07T20:00:00.000Z");
const staleTs = new Date(
  now - DEFAULT_STALE_DELIVERING_MS - 1000
).toISOString();
const freshTs = new Date(now - 30_000).toISOString();

test("probe fails closed on stale delivering", () => {
  const verdict = evaluateFleetHealth(
    [
      {
        name: "atlas",
        transcript: [
          {
            id: "op-1",
            ts: staleTs,
            delivering: true,
          },
        ],
        context: {
          inputTokens: 1000,
          contextWindow: 128000,
          overWindow: false,
        },
      },
    ],
    { now }
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.bots[0]?.staleDelivering.length, 1);
  assert.match(verdict.bots[0]?.reasons[0] ?? "", /delivering:true/);
});

test("probe fails closed on context over budget", () => {
  const overWindow = evaluateFleetHealth(
    [
      {
        name: "atlas",
        transcript: [],
        context: {
          inputTokens: 273000,
          contextWindow: 272000,
          overWindow: true,
        },
      },
    ],
    { now }
  );
  assert.equal(overWindow.ok, false);
  assert.equal(overWindow.bots[0]?.overBudget, true);

  const explicitBudget = evaluateFleetHealth(
    [
      {
        name: "atlas",
        transcript: [],
        context: {
          inputTokens: 273000,
          contextWindow: 1_000_000,
          overWindow: false,
        },
      },
    ],
    { now, tokenBudget: 200000 }
  );
  assert.equal(explicitBudget.ok, false);
});

test("fresh delivering and in-budget context pass", () => {
  const verdict = evaluateFleetHealth(
    [
      {
        name: "atlas",
        transcript: [{ id: "live", ts: freshTs, delivering: true }],
        context: {
          inputTokens: 12000,
          contextWindow: 128000,
          overWindow: false,
        },
      },
    ],
    { now }
  );
  assert.equal(verdict.ok, true);
});

test("probeFleetHealth composes transcript+context when /api/health is absent", async () => {
  const paths: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    paths.push(new URL(url).pathname);
    if (url.includes("/api/health")) return new Response("no", { status: 404 });
    if (url.includes("/api/fleet"))
      return Response.json({ bots: [{ name: "atlas" }] });
    if (url.includes("/transcript"))
      return Response.json({
        transcript: [{ id: "op-1", ts: staleTs, delivering: true, text: "x" }],
      });
    if (url.includes("/context"))
      return Response.json({
        inputTokens: 273000,
        contextWindow: 272000,
        overWindow: true,
      });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const verdict = await probeFleetHealth({
    url: "http://127.0.0.1:4317",
    now,
    fetchImpl,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.bots[0]?.staleDelivering.length === 1);
  assert.equal(verdict.bots[0]?.overBudget, true);
  assert.ok(paths.includes("/api/health"));
  assert.ok(paths.includes("/api/bots/atlas/transcript"));
});

test("runHealthProbeCli exits 1 on stale delivering (script contract)", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/health"))
      return Response.json({
        ok: false,
        staleDeliveringMs: DEFAULT_STALE_DELIVERING_MS,
        bots: [
          {
            name: "atlas",
            ok: false,
            staleDelivering: [{ id: "op-1", ts: staleTs, ageMs: 86_400_000 }],
            overBudget: false,
            inputTokens: 273000,
            contextWindow: 1_000_000,
            reasons: ["1 transcript delivering:true older than 600000ms"],
          },
        ],
      });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const lines: string[] = [];
  const code = await runHealthProbeCli(["http://127.0.0.1:4317"], {
    fetchImpl,
    error: (line) => lines.push(line),
    log: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /delivering:true/);
});

test("parseHealthProbeArgs reads url/bot/stale-min/token-budget", () => {
  assert.deepEqual(
    parseHealthProbeArgs([
      "--url",
      "http://127.0.0.1:9",
      "--bot",
      "atlas",
      "--stale-min",
      "5",
      "--token-budget",
      "200000",
    ]),
    {
      url: "http://127.0.0.1:9",
      bots: ["atlas"],
      staleDeliveringMs: 5 * 60_000,
      tokenBudget: 200000,
    }
  );
});

test("packaged health-probe.sh is executable and fail-closed", () => {
  const script = fileURLToPath(
    new URL("../scripts/health-probe.sh", import.meta.url)
  );
  const probe = spawnSync("bash", [script, "http://127.0.0.1:1"], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.notEqual(probe.status, 0, "unreachable daemon must not exit 0");
});
