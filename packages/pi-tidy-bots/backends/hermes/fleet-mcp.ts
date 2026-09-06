import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  object,
  nonempty,
  ProtocolError,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";
import type { PluginContext } from "@mobrienv/pi-tidy-bots/plugin-sdk";

export interface FleetScope {
  operationId: string;
  turnId: string;
}

const payloadDigest = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

const tools = [
  {
    name: "fleet_discover",
    description: "List the fleet peers this bot may contact.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "fleet_send",
    description:
      "Admit a task for a permitted peer. Admission is not task completion; completion arrives separately.",
    inputSchema: {
      type: "object" as const,
      properties: { target: { type: "string" }, text: { type: "string" } },
      required: ["target", "text"],
      additionalProperties: false,
    },
  },
];

/** One private credential per adapter lifetime. Never publish it in model input.
 * Stateless MCP requests may reconnect; only native identity determines actions.
 */
export async function openFleetMcp(
  ctx: Pick<PluginContext, "hostCall" | "initialization" | "signal">,
  scope: (sessionId: string, promptId: string) => FleetScope
) {
  const bearer = `Bearer ${randomBytes(32).toString("hex")}`;
  const pending = new Set<Server>();
  let closed = false;
  let authority = "";
  const limit = ctx.initialization.limits.maxFrameBytes;
  const http = createServer(async (req, res) => {
    const refuse = (code: number) => {
      res.writeHead(code);
      res.end();
    };
    if (closed || ctx.signal.aborted) return refuse(503);
    // Exact Host and no browser origin: this endpoint is only for the owned ACP
    // child, not a browser-facing proxy. Authentication happens before parsing.
    if (
      req.headers.host !== authority ||
      req.headers.origin !== undefined ||
      req.headers.authorization !== bearer
    )
      return refuse(403);
    if (req.url !== "/mcp") return refuse(404);
    if (req.method !== "POST") return refuse(405);
    if (pending.size >= ctx.initialization.limits.maxPendingRequests)
      return refuse(429);
    const server = new Server(
      { name: "tidy-fleet", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    pending.add(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const cleanup = () => {
      pending.delete(server);
      void server.close();
    };
    res.once("close", cleanup);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const identity = params._meta?.tidy;
        if (
          closed ||
          ctx.signal.aborted ||
          !object(identity) ||
          Object.keys(identity).some(
            (key) =>
              ![
                "sessionId",
                "promptId",
                "nativeToolCallId",
                "toolName",
              ].includes(key)
          ) ||
          ![
            identity.sessionId,
            identity.promptId,
            identity.nativeToolCallId,
          ].every(
            (value) =>
              nonempty(value) &&
              value.trim() &&
              value.length <= 256 &&
              !value.includes("\0")
          ) ||
          identity.toolName !== params.name ||
          !tools.some((tool) => tool.name === params.name)
        )
          throw new ProtocolError(
            "invalid_request",
            "Uncorrelated fleet tool call"
          );
        const args = params.arguments ?? {};
        if (
          params.name === "fleet_discover"
            ? Object.keys(args).length !== 0
            : Object.keys(args).length !== 2 ||
              !nonempty(args.target) ||
              !nonempty(args.text) ||
              !args.target.trim() ||
              !args.text.trim() ||
              Buffer.byteLength(args.text) > 65536
        )
          throw new ProtocolError(
            "invalid_request",
            "Invalid fleet tool arguments"
          );
        const turn = scope(
          identity.sessionId as string,
          identity.promptId as string
        );
        const arguments_: JsonObject =
          params.name === "fleet_send"
            ? { target: args.target, text: args.text }
            : {};
        const name =
          params.name === "fleet_discover" ? "fleet.discover" : "fleet.send";
        const actionId = `hermes-fleet-${payloadDigest({
          bindingId: ctx.initialization.bindingId,
          operationId: turn.operationId,
          toolCallId: identity.nativeToolCallId,
        }).slice(7)}`;
        const result = await ctx.hostCall({
          name,
          // SDK reservations fingerprint the entire call. Keep this identity
          // stable too; the SDK assigns a fresh outer JSON-RPC ID per dispatch.
          callId: name === "fleet.send" ? actionId : randomUUID(),
          arguments: arguments_,
          operationId: turn.operationId,
          toolCallId: identity.nativeToolCallId,
          ...(name === "fleet.send"
            ? {
                actionId,
                payloadDigest: payloadDigest({
                  name,
                  arguments: arguments_,
                  operationId: turn.operationId,
                  toolCallId: identity.nativeToolCallId,
                }),
              }
            : {}),
        });
        const text = JSON.stringify(result ?? { status: "unknown" });
        if (Buffer.byteLength(text) > limit / 2) throw new Error();
        return { content: [{ type: "text" as const, text }] };
      } catch {
        // Host/native exception messages may contain private paths or arguments.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Fleet tool unavailable. No task completion is confirmed.",
            },
          ],
        };
      }
    });
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > limit) {
          refuse(413);
          return;
        }
        chunks.push(buffer);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) refuse(400);
      else res.end();
    }
  });
  http.requestTimeout = Math.max(
    1000,
    ctx.initialization.limits.commandTimeoutMs
  );
  http.headersTimeout = Math.min(http.requestTimeout, 10000);
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("MCP listener unavailable");
  authority = `127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      ctx.signal.removeEventListener("abort", abort);
      await Promise.allSettled([...pending].map((server) => server.close()));
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    })());
  const abort = () => {
    void close();
  };
  ctx.signal.addEventListener("abort", abort, { once: true });
  if (ctx.signal.aborted) await close();
  return {
    descriptor: {
      type: "http",
      name: "tidy-fleet",
      url: `http://${authority}/mcp`,
      headers: [{ name: "Authorization", value: bearer }],
    },
    close,
  };
}
