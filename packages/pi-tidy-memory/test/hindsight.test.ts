import assert from "node:assert/strict";
import test from "node:test";
import { HindsightBackend } from "../backends/hindsight.js";

function backend(
  fetch: typeof globalThis.fetch,
  overrides: Record<string, unknown> = {}
) {
  return new HindsightBackend({
    config: {
      type: "hindsight",
      baseUrl: "https://memory.example.test",
      bankId: "pi/coding",
      apiKeyEnv: "HINDSIGHT_API_KEY",
      recallBudget: "mid",
      recallTypes: ["observation"],
      asyncRetain: true,
      ...overrides,
    },
    fetch,
    env: { HINDSIGHT_API_KEY: "secret" },
    timeoutMs: 100,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("diagnostic performs an authenticated bank-scoped read without writing", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = backend((async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return json({ items: [], total: 0, limit: 0, offset: 0 });
  }) as typeof globalThis.fetch);

  assert.deepEqual(await client.health(), {
    ok: true,
    message: "bank readable; 0 memories",
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://memory.example.test/v1/default/banks/pi%2Fcoding/memories/list?limit=0"
  );
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.body, undefined);
  assert.equal(
    new Headers(requests[0].init.headers).get("Authorization"),
    "Bearer secret"
  );
});

test("maps health recall retain and reflect to Hindsight 0.8 paths", async () => {
  const requests: Array<{ url: string; init: RequestInit; body?: any }> = [];
  const fake = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, init: init ?? {}, body });
    if (url.endsWith("/memories/list?limit=0"))
      return json({ items: [], total: 1, limit: 0, offset: 0 });
    if (url.endsWith("/memories/recall"))
      return json({
        results: [
          { id: "m1", text: "Use pnpm", type: "world", tags: ["project:pi"] },
        ],
      });
    if (url.endsWith("/memories"))
      return json({
        success: true,
        bank_id: "pi/coding",
        items_count: 1,
        async: true,
        operation_id: "op1",
      });
    if (url.endsWith("/reflect"))
      return json({
        text: "The migration followed two failures.",
        based_on: { memories: [{ id: "m1", text: "Failure one" }] },
      });
    return json({}, 404);
  };
  const client = backend(fake as typeof globalThis.fetch);
  assert.equal(client.type, "hindsight");
  assert.equal(client.label, "Hindsight");
  assert.deepEqual(
    [...client.capabilities],
    ["health", "recall", "retain", "reflect"]
  );
  assert.deepEqual(await client.health(), {
    ok: true,
    message: "bank readable; 1 memory",
  });
  assert.deepEqual(
    (
      await client.recall({
        query: "package manager",
        maxTokens: 512,
        tags: ["project:pi"],
      })
    ).memories[0],
    {
      id: "m1",
      text: "Use pnpm",
      kind: "world",
      tags: ["project:pi"],
    }
  );
  assert.deepEqual(
    await client.retain({ content: "Use pnpm", documentId: "doc1" }),
    {
      accepted: 1,
      deferred: true,
      operationId: "op1",
    }
  );
  assert.equal(
    (
      await client.reflect({
        query: "Why migrate?",
        maxTokens: 800,
        tags: ["project:pi"],
      })
    ).text,
    "The migration followed two failures."
  );

  assert.equal(
    requests[0].url,
    "https://memory.example.test/v1/default/banks/pi%2Fcoding/memories/list?limit=0"
  );
  assert.equal(requests[0].init.method, "GET");
  assert.equal(
    requests[1].url,
    "https://memory.example.test/v1/default/banks/pi%2Fcoding/memories/recall"
  );
  assert.equal(requests[1].init.method, "POST");
  assert.deepEqual(requests[1].body, {
    query: "package manager",
    max_tokens: 512,
    budget: "mid",
    types: ["observation"],
    prefer_observations: true,
    tags: ["project:pi"],
    tags_match: "all_strict",
  });
  assert.equal(
    requests[2].url,
    "https://memory.example.test/v1/default/banks/pi%2Fcoding/memories"
  );
  assert.equal(requests[2].init.method, "POST");
  assert.deepEqual(requests[2].body, {
    items: [{ content: "Use pnpm", document_id: "doc1" }],
    async: true,
  });
  assert.equal(
    requests[3].url,
    "https://memory.example.test/v1/default/banks/pi%2Fcoding/reflect"
  );
  assert.equal(requests[3].init.method, "POST");
  assert.deepEqual(requests[3].body, {
    query: "Why migrate?",
    budget: "low",
    max_tokens: 800,
    tags: ["project:pi"],
    tags_match: "all_strict",
    include: { facts: {} },
  });
  for (const [index, request] of requests.entries()) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Authorization"), "Bearer secret");
    assert.equal(
      headers.get("Content-Type"),
      index === 0 ? null : "application/json"
    );
    assert.equal(request.init.signal instanceof AbortSignal, true);
  }
});

test("sanitizes HTTP and credential errors", async () => {
  const unauthorized = backend((async () =>
    json({ detail: "secret server detail" }, 401)) as typeof globalThis.fetch);
  await assert.rejects(
    () => unauthorized.recall({ query: "x" }),
    /authentication failed \(401\)/
  );
  await assert.rejects(
    () => unauthorized.recall({ query: "x" }),
    (error: Error) => !error.message.includes("server detail")
  );
  const missing = backend((async () => json({})) as typeof globalThis.fetch);
  (missing as any).options.env = {};
  await assert.rejects(
    () => missing.health(),
    /credential HINDSIGHT_API_KEY is unavailable/
  );
});

test("normalizes every HTTP error family without response-body leakage", async () => {
  for (const [status, message] of [
    [401, "Hindsight recall authentication failed (401)"],
    [403, "Hindsight recall authentication failed (403)"],
    [404, "Hindsight recall endpoint or bank was not found (404)"],
    [429, "Hindsight recall failed with HTTP 429"],
    [500, "Hindsight recall failed with HTTP 500"],
  ] as const) {
    const client = backend((async () =>
      json({ secret: "must not leak" }, status)) as typeof globalThis.fetch);
    await assert.rejects(() => client.recall({ query: "x" }), {
      name: "Error",
      message,
    });
  }
});

test("rejects invalid responses and respects cancellation", async () => {
  let preAbortedFetches = 0;
  const preAborted = backend((async () => {
    preAbortedFetches++;
    return json({ success: true, bank_id: "x", items_count: 1, async: false });
  }) as typeof globalThis.fetch);
  const stopped = new AbortController();
  stopped.abort(new Error("already stopped"));
  await assert.rejects(
    () => preAborted.retain({ content: "must not write" }, stopped.signal),
    /already stopped/
  );
  assert.equal(preAbortedFetches, 0);

  const invalid = backend((async () =>
    json({ nope: true })) as typeof globalThis.fetch);
  await assert.rejects(
    () => invalid.recall({ query: "x" }),
    /invalid response/
  );
  await assert.rejects(
    () => invalid.retain({ content: "x" }),
    /invalid response/
  );
  await assert.rejects(
    () => invalid.reflect({ query: "x" }),
    /invalid response/
  );

  const hanging = backend(
    (async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        );
      })) as typeof globalThis.fetch
  );
  const controller = new AbortController();
  const request = hanging.recall({ query: "x" }, controller.signal);
  controller.abort(new Error("stop"));
  await assert.rejects(() => request, /stop/);
});
