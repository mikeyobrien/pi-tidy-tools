import assert from "node:assert/strict";
import test from "node:test";
import {
  createHindsightFactory,
  HindsightBackend,
} from "../backends/hindsight.js";

const config = {
  type: "hindsight" as const,
  baseUrl: "https://memory.example.test/",
  bankId: "bank",
  recallBudget: "low" as const,
  recallTypes: ["world"],
  asyncRetain: false,
};

function client(fetch: typeof globalThis.fetch, timeoutMs = 30) {
  return new HindsightBackend({ config, fetch, env: {}, timeoutMs });
}

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });

test("normalizes optional memory fields and explicit request options", async () => {
  const bodies: any[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    if (url.endsWith("/memories/recall"))
      return json({
        results: [
          null,
          {
            text: "x".repeat(9_000),
            context: "ctx",
            occurred_start: "2026-01-01",
            tags: ["x", 2],
            metadata: { ok: "yes", bad: 2 },
          },
        ],
      });
    if (url.endsWith("/memories"))
      return json({
        success: true,
        bank_id: "bank",
        items_count: 1,
        async: false,
        operation_ids: ["op2"],
      });
    return json({ text: "answer", based_on: null });
  }) as typeof globalThis.fetch;
  const backend = client(fake);
  const recalled = await backend.recall({
    query: "q",
    budget: "high",
    types: ["experience"],
    tags: ["tag"],
  });
  assert.equal(recalled.memories.length, 1);
  assert.equal(recalled.memories[0].id, "unknown");
  assert.equal(recalled.memories[0].text.length, 8_000);
  assert.deepEqual(recalled.memories[0].tags, ["x"]);
  assert.deepEqual(recalled.memories[0].metadata, { ok: "yes" });
  const retained = await backend.retain({
    content: "c",
    context: "ctx",
    occurredAt: "2026",
    tags: ["tag"],
    metadata: { x: "y" },
  });
  assert.equal(retained.operationId, "op2");
  assert.equal(retained.deferred, false);
  assert.deepEqual(bodies[0], {
    query: "q",
    budget: "high",
    types: ["experience"],
    prefer_observations: true,
    tags: ["tag"],
  });
  assert.deepEqual(bodies[1].items[0], {
    content: "c",
    context: "ctx",
    timestamp: "2026",
    tags: ["tag"],
    metadata: { x: "y" },
  });
  assert.equal(
    (await backend.reflect({ query: "q", tags: ["tag"] })).text,
    "answer"
  );
});

test("normalizes unhealthy, endpoint, JSON, size, and timeout failures", async () => {
  assert.deepEqual(
    await client((async () =>
      json({
        status: "unhealthy",
        database: "error",
      })) as typeof globalThis.fetch).health(),
    { ok: false, message: "unhealthy" }
  );
  await assert.rejects(
    () =>
      client(
        (async () => new Response("oops")) as typeof globalThis.fetch
      ).health(),
    /invalid JSON/
  );
  await assert.rejects(
    () =>
      client((async () => json({}, 404)) as typeof globalThis.fetch).health(),
    /not found/
  );
  await assert.rejects(
    () =>
      client((async () => json({}, 500)) as typeof globalThis.fetch).health(),
    /HTTP 500/
  );
  await assert.rejects(
    () =>
      client(
        (async () =>
          new Response("{}", {
            headers: { "content-length": "3000000" },
          })) as typeof globalThis.fetch
      ).health(),
    /response exceeded/
  );
  await assert.rejects(
    () =>
      client(
        (async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason)
            );
          })) as typeof globalThis.fetch,
        5
      ).health(),
    /timed out after 5ms/
  );
  await assert.rejects(
    () =>
      client((async () =>
        json({ status: 1 })) as typeof globalThis.fetch).health(),
    /invalid response/
  );
});

test("factory constructs a working unauthenticated client", async () => {
  const factory = createHindsightFactory(100);
  const backend = factory.create(config, {
    env: {},
    fetch: (async () => json({ status: "healthy" })) as typeof globalThis.fetch,
  });
  assert.equal(factory.type, "hindsight");
  assert.equal((await backend.health()).ok, true);
});
