import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpcSpawnArgs } from "../src/rpc.ts";
import {
  installWrap,
  isMcpTool,
  stripReasoning,
  withOptionalReasoning,
} from "../src/mcp-wrap.ts";

// Issue 85: bot-scoped MCP wrap. Every MCP tool gains an OPTIONAL reasoning
// param (never required — issue 61 lesson), stripped before the JSON-RPC
// call so servers don't 400. The wrap is a fleet hard dependency: every bot
// spawn carries it (-e after bridge), and it loads the bundled
// pi-mcp-adapter after installing the patch.

const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
  .pathname;

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met in time");
}

test("isMcpTool detects adapter label/promptSnippet contract", () => {
  assert.equal(isMcpTool({ name: "x", label: "MCP: search" }), true);
  assert.equal(
    isMcpTool({ name: "x", promptSnippet: "MCP tool from notion" }),
    true
  );
  assert.equal(
    isMcpTool({ name: "x", description: "MCP tool from notion" }),
    true
  );
  assert.equal(isMcpTool({ name: "x", label: "Edit file" }), false);
  assert.equal(isMcpTool({ name: "x" }), false);
});

test("withOptionalReasoning: optional in both dialects, never required", () => {
  const jsonSchema = withOptionalReasoning({
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query", "reasoning"],
  }) as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(jsonSchema.properties.reasoning, "reasoning added");
  assert.deepEqual(jsonSchema.required, ["query"], "removed from required");

  // This typebox build encodes optionality via the object's required array
  // (standard JSON Schema) — the reasoning property is added and never
  // enters required.
  const typeBox = withOptionalReasoning({
    properties: { query: { type: "string" } },
    required: ["query"],
  }) as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(typeBox.properties.reasoning, "reasoning added");
  assert.deepEqual(typeBox.required, ["query"], "never required");

  const fromNothing = withOptionalReasoning(undefined) as {
    properties: Record<string, unknown>;
  };
  assert.ok(fromNothing.properties.reasoning, "schema built from nothing");
});

test("stripReasoning removes only reasoning", () => {
  assert.deepEqual(
    stripReasoning({ reasoning: "why", query: "x", pageId: 1 }),
    { query: "x", pageId: 1 }
  );
  assert.deepEqual(stripReasoning({ query: "x" }), { query: "x" });
  assert.equal(stripReasoning(null), null);
  assert.deepEqual(stripReasoning([1, 2]), [1, 2]);
});

test("installWrap patches MCP tools only, executor strips reasoning", async () => {
  // Fresh guard state for this test process.
  (globalThis as { __PTB_MCP_WRAP__?: boolean }).__PTB_MCP_WRAP__ = false;
  const registered: Array<{
    name: string;
    parameters?: unknown;
    execute?: (id: string, params: unknown) => Promise<unknown>;
  }> = [];
  const pi = {
    registerTool: (tool: unknown) => {
      registered.push(tool as (typeof registered)[number]);
    },
  };
  installWrap(pi);

  pi.registerTool({
    name: "notion__search",
    label: "MCP: search",
    description: "Search pages",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async (_id: string, params: unknown) => ({ saw: params }),
  });
  pi.registerTool({
    name: "bash",
    label: "Run command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    execute: async (_id: string, params: unknown) => ({ saw: params }),
  });

  assert.equal(registered.length, 2);
  const mcp = registered[0];
  const plain = registered[1];
  assert.ok(
    JSON.stringify(mcp?.parameters).includes("reasoning"),
    "MCP tool carries reasoning"
  );
  assert.ok(
    !JSON.stringify(plain?.parameters).includes("reasoning"),
    "non-MCP untouched"
  );
  assert.deepEqual(
    (await (mcp?.execute as NonNullable<typeof mcp.execute>)("t1", {
      reasoning: "find the page",
      query: "recipes",
    })) as { saw: unknown },
    { saw: { query: "recipes" } },
    "executor strips reasoning before the call"
  );

  // Idempotent: a second install is a no-op (single patch per process) —
  // a re-registered MCP tool is still wrapped exactly once.
  installWrap(pi);
  pi.registerTool({
    name: "notion__get",
    label: "MCP: get",
    execute: async () => "ok",
  });
  const re = registered.at(-1);
  assert.ok(
    JSON.stringify(re?.parameters).includes("reasoning"),
    "still wrapped"
  );
});

test("rpcSpawnArgs carries extra extensions after bridge", () => {
  const args = rpcSpawnArgs({
    name: "aa",
    sessionDir: "/s",
    resume: false,
    approve: false,
    bridgePath: "/bridge.ts",
    extensions: ["/mcp-wrap.ts"],
  });
  const flags = args.filter((_, index) => args[index - 1] === "-e");
  assert.deepEqual(
    flags,
    ["/bridge.ts", "/mcp-wrap.ts"],
    "order: bridge then wrap"
  );
});

test(
  "every bot spawn carries the MCP wrap (issue 85 hard dep)",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-mcpwrap-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    const argvLog = join(fleetDir, "argv.log");
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
      );
      const wrapper = join(fleetDir, "pi.sh");
      writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          `echo "$PI_TIDY_BOTS_NAME $@" >> "${argvLog}"`,
          `exec node ${runner}`,
        ].join("\n")
      );
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

      const argvAll = existsSync(argvLog)
        ? readFileSync(argvLog, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
        : [];
      assert.ok(
        argvAll.some(
          (line) => line.includes("--mode rpc") && line.includes("mcp-wrap.ts")
        ),
        "bot child argv carries the MCP wrap extension"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
