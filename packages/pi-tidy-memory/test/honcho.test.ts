import assert from "node:assert/strict";
import test from "node:test";
import { honchoSessionId, HonchoBackend } from "../backends/honcho.js";

function backend(
  fetch: typeof globalThis.fetch,
  overrides: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {}
) {
  return new HonchoBackend({
    config: {
      type: "honcho",
      baseUrl: "https://honcho.example.test",
      workspace: "hermes",
      userPeer: "rook",
      aiPeer: "pi",
      ...overrides,
    },
    fetch,
    env,
    timeoutMs: 100,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("honchoSessionId maps bank id characters onto honcho session pattern", () => {
  assert.equal(honchoSessionId("pi::pi-tidy-tools"), "pi-pi-tidy-tools");
  assert.equal(honchoSessionId("pi.code"), "pi-code");
  assert.equal(honchoSessionId("---"), "default");
  const long = honchoSessionId(`${"a".repeat(200)}::suffix`);
  assert.equal(long.length, 128);
  assert.match(long, /^[a-zA-Z0-9_-]+$/);
});

test("constructor requires baseUrl when config and configFile are empty", () => {
  assert.throws(
    () =>
      new HonchoBackend({
        config: { type: "honcho" },
        fetch: (async () => json({})) as typeof globalThis.fetch,
        env: {},
        timeoutMs: 100,
      }),
    /requires baseUrl/
  );
});

test("health checks the server root and reports workspace and peers", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = backend((async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return json({ status: "ok" });
  }) as typeof globalThis.fetch);

  const health = await client.health();
  assert.equal(health.ok, true);
  assert.match(health.message, /workspace hermes reachable/);
  assert.equal(requests[0].url, "https://honcho.example.test/health");
  assert.equal(requests[0].init.method, "GET");
});

test("hybrid recall merges dialectic synthesis with search hits and degrades", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = backend((async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
    requests.push({ url, body });
    if (url.endsWith("/chat"))
      return json({ content: "rook is building a honcho backend" });
    if (url.endsWith("/search"))
      return json([
        {
          id: "m1",
          content: "older message",
          peer_id: "hermes",
          session_id: "autoloop",
          created_at: "2026-06-21T21:32:20Z",
        },
        { id: "m2" },
      ]);
    return json({});
  }) as typeof globalThis.fetch);

  const result = await client.recall({ query: "what is rook doing?" });
  assert.equal(result.memories.length, 2);
  assert.equal(result.memories[0].kind, "dialectic");
  assert.equal(result.memories[0].text, "rook is building a honcho backend");
  assert.equal(result.memories[1].id, "m1");
  assert.equal(result.memories[1].kind, "message");
  assert.equal(result.memories[1].context, "peer hermes");
  assert.equal(result.memories[1].occurredAt, "2026-06-21T21:32:20Z");
  assert.equal(result.memories[1].metadata?.session, "autoloop");

  const chat = requests.find((request) => request.url.endsWith("/chat"));
  assert.deepEqual(chat?.body, {
    query: "what is rook doing?",
    target: "rook",
    reasoning_level: "low",
  });
  const search = requests.find((request) => request.url.endsWith("/search"));
  assert.deepEqual(search?.body, { query: "what is rook doing?", limit: 8 });
});

test("hybrid recall degrades to search when the deriver is down", async () => {
  const client = backend((async (input) => {
    if (String(input).endsWith("/chat"))
      return json({ detail: "An unexpected error occurred" }, 500);
    if (String(input).endsWith("/search"))
      return json([
        { id: "m1", content: "kept", peer_id: "pi" },
      ]);
    return json({});
  }) as typeof globalThis.fetch);

  const result = await client.recall({ query: "q" });
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].text, "kept");
});

test("hybrid recall throws both failures when both legs fail", async () => {
  const client = backend((async () =>
    json({ detail: "boom" }, 500)) as typeof globalThis.fetch);
  await assert.rejects(client.recall({ query: "q" }), /Honcho recall failed/);
});

test("dialectic-only recall maps chat content and empty content", async () => {
  const client = backend(
    (async (input) => {
      if (String(input).endsWith("/chat")) return json({ content: "answer" });
      throw new Error("unexpected route");
    }) as typeof globalThis.fetch,
    { recallMode: "dialectic" }
  );
  const result = await client.recall({ query: "q" });
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].text, "answer");

  const empty = backend(
    (async (input) => {
      if (String(input).endsWith("/chat")) return json({ content: null });
      throw new Error("unexpected route");
    }) as typeof globalThis.fetch,
    { recallMode: "dialectic" }
  );
  const emptyResult = await empty.recall({ query: "q" });
  assert.deepEqual(emptyResult.memories, []);
});

test("reflect returns dialectic text and rejects empty content", async () => {
  const client = backend((async (input) => {
    if (String(input).endsWith("/chat")) return json({ content: "insight" });
    throw new Error("unexpected route");
  }) as typeof globalThis.fetch);
  assert.deepEqual(await client.reflect({ query: "q" }), {
    text: "insight",
  });

  const empty = backend((async (input) => {
    if (String(input).endsWith("/chat")) return json({ content: "" });
    throw new Error("unexpected route");
  }) as typeof globalThis.fetch);
  await assert.rejects(empty.reflect({ query: "q" }), /returned no content/);
});

test("retain creates the session once and posts attributed messages", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = backend((async (input, init) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    if (url.endsWith("/sessions")) return json({ id: "pi-default" }, 201);
    if (url.endsWith("/messages"))
      return json(
        [{ id: "m1", content: "note", peer_id: "pi", session_id: "pi-default" }],
        201
      );
    throw new Error(`unexpected route ${url}`);
  }) as typeof globalThis.fetch);

  const first = await client.retain({
    content: "remember this",
    context: "testing",
    tags: ["a", "b"],
    metadata: { mode: "manual" },
  });
  assert.deepEqual(first, { accepted: 1, deferred: false });

  await client.retain({ content: "again" });
  const sessionPosts = requests.filter((request) =>
    request.url.endsWith("/sessions")
  );
  assert.equal(sessionPosts.length, 1);
  assert.deepEqual(sessionPosts[0].body, {
    id: "pi-default",
    peers: { rook: {}, pi: {} },
  });
  const messagePost = requests.find((request) =>
    request.url.endsWith("/messages")
  );
  const messages = (
    messagePost?.body as { messages: Array<Record<string, unknown>> }
  ).messages;
  assert.equal(messages[0].peer_id, "pi");
  assert.equal(messages[0].content, "remember this");
  assert.deepEqual(messages[0].metadata, {
    context: "testing",
    tags: "a,b",
    mode: "manual",
  });
});

test("retain uses a sanitized dynamic bank id as the session id", async () => {
  const requests: Array<{ url: string }> = [];
  const client = backend(
    (async (input, init) => {
      const url = String(input);
      requests.push({ url });
      if (url.endsWith("/sessions")) return json({ id: "x" }, 201);
      if (url.endsWith("/messages")) return json([{ id: "m1" }], 201);
      throw new Error(`unexpected route ${url}`);
    }) as typeof globalThis.fetch,
    {},
    {}
  );
  (client as unknown as { config: { bankId?: string } }).config.bankId =
    "pi::pi-tidy-tools";
  await client.retain({ content: "note" });
  assert.ok(
    requests.some((request) =>
      request.url.endsWith("/sessions/pi-pi-tidy-tools/messages")
    )
  );
});

test("retain falls back to a suffixed session when the id is tombstoned", async () => {
  const requests: Array<{ url: string }> = [];
  const client = backend(
    (async (input, init) => {
      const url = String(input);
      requests.push({ url });
      if (url.endsWith("/sessions")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id: string };
        if (body.id === "pi-default")
          return json(
            { detail: "Session pi-default not found in workspace hermes" },
            404
          );
        return json({ id: body.id }, 201);
      }
      if (url.endsWith("/messages")) return json([{ id: "m1" }], 201);
      throw new Error(`unexpected route ${url}`);
    }) as typeof globalThis.fetch
  );
  const result = await client.retain({ content: "note" });
  assert.deepEqual(result, { accepted: 1, deferred: false });
  const created = requests.filter((request) =>
    request.url.endsWith("/sessions")
  );
  assert.equal(created.length, 3);
  const messages = requests.find((request) =>
    request.url.endsWith("/messages")
  );
  assert.match(messages?.url ?? "", /\/sessions\/pi-default-[a-z0-9]+\/messages$/);
});

test("authenticated honcho requires https off loopback", () => {
  assert.throws(
    () =>
      new HonchoBackend({
        config: {
          type: "honcho",
          baseUrl: "http://honcho.example.test",
          workspace: "hermes",
          apiKeyEnv: "HONCHO_API_KEY",
        },
        fetch: (async () => json({})) as typeof globalThis.fetch,
        env: { HONCHO_API_KEY: "secret" },
        timeoutMs: 100,
      }),
    /requires HTTPS/
  );
});

test("apiKeyEnv takes precedence over configFile credentials", async () => {
  const requests: Array<{ init: RequestInit }> = [];
  const client = new HonchoBackend({
    config: {
      type: "honcho",
      baseUrl: "https://honcho.example.test",
      workspace: "hermes",
      apiKeyEnv: "HONCHO_API_KEY",
    },
    fetch: (async (input, init) => {
      requests.push({ init: init ?? {} });
      return json({});
    }) as typeof globalThis.fetch,
    env: { HONCHO_API_KEY: "env-key" },
    timeoutMs: 100,
  });
  await client.health();
  assert.equal(
    new Headers(requests[0].init.headers).get("Authorization"),
    "Bearer env-key"
  );
});
