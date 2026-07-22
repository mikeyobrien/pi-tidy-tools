import assert from "node:assert/strict";
import test from "node:test";
import { parseMemoryConfig } from "../config.js";
import { createMemoryExtension } from "../index.js";

test("static native retain combines synchronous completion with configured provenance", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        success: true,
        bank_id: "mobrienv",
        items_count: 1,
        async: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
  const config = parseMemoryConfig({
    version: 1,
    backend: {
      type: "hindsight",
      baseUrl: "https://memory.example.test",
      bankId: "mobrienv",
      dynamicBankId: false,
    },
    provenance: {
      user: "mikeyobrien",
      agent: "pi",
      repository: "mikeyobrien/pi-tidy-tools",
      source: "pi-tidy-memory/native",
    },
    lifecycle: { autoRecall: true, autoRetain: false },
  });
  const tools = new Map<string, any>();
  createMemoryExtension({
    configResult: { config, path: "/agent/pi-tidy-memory/config.json" },
    fetch,
    now: () => new Date("2026-07-22T04:05:06.789Z"),
    revision: {
      packageVersion: "0.1.0",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    },
  })({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
  } as any);

  const retained = await tools
    .get("retain")
    .execute(
      "tool-1",
      { content: "Prefer verified releases." },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-1" } }
    );

  assert.equal(retained.details.deferred, false);
  assert.deepEqual(requests, [
    {
      url: "https://memory.example.test/v1/default/banks/mobrienv/memories",
      body: {
        items: [
          {
            content: "Prefer verified releases.",
            timestamp: "2026-07-22T04:05:06.789Z",
            document_id: "pi-tool:session-1:tool-1",
            metadata: {
              user: "mikeyobrien",
              agent: "pi",
              repository: "mikeyobrien/pi-tidy-tools",
              source: "pi-tidy-memory/native",
              mode: "manual",
              session: "session-1",
            },
          },
        ],
        async: false,
      },
    },
  ]);
});
