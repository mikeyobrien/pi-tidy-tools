// pi-tidy-bots MCP wrap (issue 85).
//
// Loaded by the fleet runtime into EVERY bot session (spawn args carry this
// file after bridge.ts). Two jobs:
//
// 1. WRAP: every MCP tool registered with this pi API gains an OPTIONAL
//    string parameter `reasoning` (the why, like bash/read) — NEVER required
//    (issue 61: schema-required reasoning wedges glm/spark). The executor
//    strips `reasoning` before invoking the original, so the JSON-RPC call to
//    the MCP server never carries the unknown field (servers 400 on those).
//    The daemon's step rows already surface args.reasoning via stepReason.
//
// 2. HARD DEPENDENCY: pi-tidy-bots ships pi-mcp-adapter itself. The wrap
//    loads the bundled adapter AFTER installing the registerTool patch, so
//    bot children always have MCP support with the wrap applied — no global
//    adapter fork needed. If the operator's global settings also load the
//    adapter, remove the global copy; the fleet-owned one wins here.
//
// Non-MCP tools pass through untouched. The patch stays installed for the
// session so MCP tools registered later (by any source) are wrapped too.
import { Type } from "typebox";

interface WrappedTool {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  parameters?: unknown;
  execute?: (
    toolCallId: string,
    params: unknown,
    ...rest: unknown[]
  ) => unknown;
}

const REASONING_PARAM = Type.Optional(
  Type.String({
    description: "Why this call is being made (the operator-facing why)",
  })
);

/** MCP tools, as declared by pi-mcp-adapter (label/promptSnippet contract). */
export function isMcpTool(tool: WrappedTool): boolean {
  if (typeof tool.label === "string" && /^mcp:/i.test(tool.label.trim()))
    return true;
  if (
    typeof tool.promptSnippet === "string" &&
    tool.promptSnippet.includes("MCP tool from")
  )
    return true;
  return (
    typeof tool.description === "string" &&
    /^mcp tool from /i.test(tool.description.trim())
  );
}

/**
 * Add `reasoning` as optional. Handles both schema dialects pi sees: plain
 * JSON Schema (adapter's Type.Unsafe passthrough — drive `required`) and
 * TypeBox objects (the Optional modifier drives it; the JSON-Schema
 * `required` filter is harmless there).
 */
export function withOptionalReasoning(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      type: "object",
      properties: { reasoning: REASONING_PARAM },
    };
  }
  const record = schema as Record<string, unknown> & { required?: unknown };
  const next: Record<string, unknown> = { ...record };
  next.properties = {
    ...(record.properties as Record<string, unknown> | undefined),
    reasoning: REASONING_PARAM,
  };
  if (Array.isArray(record.required)) {
    next.required = record.required.filter(
      (key) => key !== "reasoning"
    ) as unknown[];
  }
  return next;
}

/** Executor wrapper: strip `reasoning` before the MCP server sees params. */
export function stripReasoning(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return params;
  const { reasoning: _why, ...serverArgs } = params as Record<string, unknown>;
  return serverArgs;
}

/** Install the registerTool patch (idempotent per process). */
export function installWrap(pi: any): void {
  const guard = globalThis as { __PTB_MCP_WRAP__?: boolean };
  if (guard.__PTB_MCP_WRAP__) return;
  guard.__PTB_MCP_WRAP__ = true;

  const original = pi.registerTool.bind(pi);
  pi.registerTool = (tool: WrappedTool) => {
    if (!isMcpTool(tool) || typeof tool.execute !== "function") {
      return original(tool);
    }
    const execute = tool.execute;
    return original({
      ...tool,
      parameters: withOptionalReasoning(tool.parameters),
      execute: async (
        toolCallId: string,
        params: unknown,
        ...rest: unknown[]
      ) => execute.call(tool, toolCallId, stripReasoning(params), ...rest),
    });
  };
}

/** Load the bundled pi-mcp-adapter against this pi API (best-effort). */
export async function loadBundledAdapter(pi: any): Promise<void> {
  try {
    // Non-literal specifier: resolved at RUNTIME from pi-tidy-bots's own
    // dependency — tsc must not type-check the adapter's TS sources.
    const specifier = "pi-mcp-adapter";
    const adapter = (await import(specifier)) as {
      default?: (p: unknown) => unknown;
    };
    const factory = adapter.default;
    if (typeof factory === "function") {
      await factory(pi);
    }
  } catch (error) {
    console.error(
      `[mcp-wrap] bundled pi-mcp-adapter failed to load: ${
        (error as Error).message
      } — MCP still available via any globally configured adapter`
    );
  }
}

export default async function mcpWrap(pi: any): Promise<void> {
  // Patch first so the bundled adapter's registrations are wrapped.
  installWrap(pi);
  await loadBundledAdapter(pi);
}
