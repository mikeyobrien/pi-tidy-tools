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

test("defaults direct Hindsight retains to synchronous processing", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const backend = new HindsightBackend({
    config: {
      type: "hindsight",
      baseUrl: "https://memory.example.test",
      bankId: "bank",
    },
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return json({
        success: true,
        bank_id: "bank",
        items_count: 1,
        async: false,
      });
    },
    env: {},
    timeoutMs: 30,
  });

  await backend.retain({ content: "durable fact" });

  assert.equal(requestBody?.async, false);
});

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
  assert.deepEqual(recalled.memories, [
    {
      id: "unknown",
      text: "x".repeat(8_000),
      context: "ctx",
      occurredAt: "2026-01-01",
      tags: ["x"],
      metadata: { ok: "yes" },
    },
  ]);
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
    tags_match: "all_strict",
  });
  assert.deepEqual(bodies[1], {
    items: [
      {
        content: "c",
        context: "ctx",
        timestamp: "2026",
        tags: ["tag"],
        metadata: { x: "y" },
      },
    ],
    async: false,
  });
  assert.equal(
    (await backend.reflect({ query: "q", tags: ["tag"] })).text,
    "answer"
  );
  assert.deepEqual(bodies[2], {
    query: "q",
    budget: "low",
    tags: ["tag"],
    tags_match: "all_strict",
    include: { facts: {} },
  });
});

test("normalizes bank endpoint, JSON, size, and timeout failures", async () => {
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

test("response normalization enforces result and synthesis bounds", async () => {
  const requests: string[] = [];
  const backend = client((async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/memories/recall")) {
      return json({
        results: Array.from({ length: 101 }, (_, index) => ({
          id: String(index),
          text: index === 0 ? "" : `memory-${index}`,
        })),
      });
    }
    return json({
      text: "r".repeat(33_000),
      based_on: {
        memories: [
          { id: "m1", text: "fact", type: "world" },
          { id: "empty", text: "" },
        ],
      },
    });
  }) as typeof globalThis.fetch);
  const recalled = await backend.recall({ query: "q" });
  assert.equal(recalled.memories.length, 99);
  assert.equal(recalled.memories[0].id, "1");
  assert.equal(recalled.memories.at(-1)?.id, "99");
  const reflected = await backend.reflect({ query: "q" });
  assert.equal(reflected.text, "r".repeat(32_000));
  assert.deepEqual(reflected.memories, [
    { id: "m1", text: "fact", kind: "world" },
  ]);
  assert.equal(requests.length, 2);
});

test("response streams stop at the byte limit and release cancellation", async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2_000_001));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    () =>
      client(
        (async () => new Response(oversized)) as typeof globalThis.fetch
      ).health(),
    /response exceeded 2000000 bytes/
  );
  assert.equal(cancelled, true);

  const atLimit = client(
    (async () =>
      new Response('{"items":[],"total":0,"limit":0,"offset":0}', {
        headers: { "content-length": "2000000" },
      })) as typeof globalThis.fetch
  );
  assert.deepEqual(await atLimit.health(), {
    ok: true,
    message: "bank readable; 0 memories",
  });

  await assert.rejects(
    () =>
      client(
        (async () => new Response(null)) as typeof globalThis.fetch
      ).health(),
    /invalid response/
  );
});

test("bank access check and retain validate every required response field", async () => {
  for (const response of [
    null,
    {},
    { items: null, total: 0, limit: 0, offset: 0 },
    { items: [], total: "0", limit: 0, offset: 0 },
    { items: [], total: 0, limit: "0", offset: 0 },
    { items: [], total: 0, limit: 0, offset: "0" },
  ]) {
    await assert.rejects(
      () =>
        client((async () =>
          json(response)) as typeof globalThis.fetch).health(),
      /bank access check returned an invalid response/
    );
  }

  for (const response of [
    null,
    {},
    { success: false, bank_id: "bank", items_count: 1, async: false },
    { success: true, bank_id: 2, items_count: 1, async: false },
    { success: true, bank_id: "bank", items_count: "1", async: false },
    { success: true, bank_id: "bank", items_count: 1, async: "false" },
  ]) {
    await assert.rejects(
      () =>
        client((async () => json(response)) as typeof globalThis.fetch).retain({
          content: "x",
        }),
      /retain returned an invalid response/
    );
  }
});

test("factory constructs a working unauthenticated client", async () => {
  const factory = createHindsightFactory(100);
  const backend = factory.create(config, {
    env: {},
    fetch: (async () =>
      json({
        items: [],
        total: 0,
        limit: 0,
        offset: 0,
      })) as typeof globalThis.fetch,
  });
  assert.equal(factory.type, "hindsight");
  assert.equal((await backend.health()).ok, true);
});
