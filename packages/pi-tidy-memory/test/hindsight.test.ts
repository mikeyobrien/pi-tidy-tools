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
    if (url.endsWith("/health"))
      return json({ status: "healthy", database: "connected" });
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
  assert.deepEqual(await client.health(), {
    ok: true,
    message: "healthy; database connected",
  });
  assert.deepEqual(
    (await client.recall({ query: "package manager", maxTokens: 512 }))
      .memories[0],
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
    (await client.reflect({ query: "Why migrate?", maxTokens: 800 })).text,
    "The migration followed two failures."
  );

  assert.equal(
    requests[1].url,
    "https://memory.example.test/v1/default/banks/pi%2Fcoding/memories/recall"
  );
  assert.deepEqual(requests[1].body, {
    query: "package manager",
    max_tokens: 512,
    budget: "mid",
    types: ["observation"],
    prefer_observations: true,
  });
  assert.deepEqual(requests[2].body, {
    items: [{ content: "Use pnpm", document_id: "doc1" }],
    async: true,
  });
  for (const request of requests) {
    assert.equal(
      new Headers(request.init.headers).get("Authorization"),
      "Bearer secret"
    );
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
