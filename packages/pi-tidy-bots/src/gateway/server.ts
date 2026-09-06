import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { FleetConfig } from "../config.ts";
import type { FleetHandle, StartFleetOptions } from "../daemon.ts";
import { DAEMON_VERSION } from "../contract.ts";
import { acquireFleetLock } from "../lock.ts";
import {
  GatewayApplication,
  GatewayStartupOwnershipError,
  GATEWAY_CAPABILITIES,
} from "./application.ts";
import { GatewayJournalError, type JsonObject } from "./journal.ts";
import { DEFAULT_LIMITS, object, ProtocolError } from "./protocol.ts";

function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const left = Buffer.from(supplied),
    right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function authorized(
  request: IncomingMessage,
  url: URL,
  token: string | undefined,
  websocket = false
): boolean {
  if (!token) return false;
  const header = request.headers.authorization;
  return (
    tokenMatches(
      header?.startsWith("Bearer ") ? header.slice(7) : undefined,
      token
    ) ||
    (websocket &&
      tokenMatches(url.searchParams.get("token") ?? undefined, token))
  );
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}
async function body(
  request: IncomingMessage
): Promise<Record<string, unknown>> {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !== "application/json"
  )
    throw new ProtocolError("invalid_payload", "JSON content type is required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > DEFAULT_LIMITS.maxFrameBytes)
      throw new ProtocolError(
        "resource_limit",
        "Request exceeds the complete message byte limit"
      );
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
    );
  } catch {
    throw new ProtocolError("invalid_payload", "Malformed JSON request");
  }
  if (!object(value))
    throw new ProtocolError("invalid_payload", "Request must be a JSON object");
  return value;
}
const statuses: Record<string, number> = {
  bot_not_found: 404,
  operation_not_found: 404,
  invalid_payload: 400,
  invalid_permission: 400,
  permission_not_found: 404,
  permission_conflict: 409,
  interaction_expired: 410,
  invalid_identity: 400,
  invalid_cursor: 400,
  client_upgrade_required: 426,
  capabilities_changed: 409,
  operation_conflict: 409,
  binding_conflict: 409,
  stale_binding: 409,
  operation_expired: 410,
  conversation_deleted: 410,
  resource_limit: 413,
  capability_unavailable: 422,
  session_unavailable: 503,
  writer_busy: 503,
  stale_writer: 503,
};
function sendError(response: ServerResponse, error: unknown): void {
  const code =
    error instanceof ProtocolError || error instanceof GatewayJournalError
      ? error.code
      : "gateway_unavailable";
  json(response, statuses[code] ?? 503, {
    error: code,
    ...(code === "client_upgrade_required" ? { requiredContract: 2 } : {}),
  });
}
const assets = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/app"
);
async function serveApp(
  pathname: string,
  response: ServerResponse
): Promise<boolean> {
  if (pathname !== "/" && pathname !== "/app" && !pathname.startsWith("/app/"))
    return false;
  if (pathname === "/" || pathname === "/app") {
    response.writeHead(302, { Location: "/app/" });
    response.end();
    return true;
  }
  try {
    const root = await realpath(assets);
    const requested = decodeURIComponent(pathname.slice(5)) || "index.html";
    const path = await realpath(join(root, requested));
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      json(response, 404, { error: "not_found" });
      return true;
    }
    const content = await readFile(path);
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".json": "application/json",
      ".wasm": "application/wasm",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".woff2": "font/woff2",
    };
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch {
    json(response, 404, { error: "app_asset_not_found" });
  }
  return true;
}

/** Real CLI/startFleet gateway entry, separate from the legacy native runtime. */
export async function startGatewayFleet(
  options: StartFleetOptions,
  fleet: FleetConfig
): Promise<FleetHandle> {
  if (!options.token?.trim())
    throw new ProtocolError(
      "invalid_config",
      "Gateway mode requires a fleet token, including loopback listeners"
    );
  if (!Number.isSafeInteger(fleet.port) || fleet.port < 0 || fleet.port > 65535)
    throw new ProtocolError(
      "invalid_config",
      "Gateway port must be an integer between 0 and 65535"
    );
  if (typeof fleet.host !== "string" || !fleet.host.trim())
    throw new ProtocolError("invalid_config", "Gateway host must be nonempty");
  // Legacy mode shares this guard. SQLite alone cannot fence a legacy daemon
  // started against the same directory after a manifest change or on another port.
  const ownership = acquireFleetLock(fleet.dir);
  if (!ownership.ok)
    throw new ProtocolError(
      "writer_busy",
      `Fleet lock held by pid ${ownership.holder.pid}; only one daemon may own a fleet directory`
    );
  let application: GatewayApplication | undefined;
  let ownedApplication: GatewayApplication | undefined;
  let recoveryUnconfirmed = false;
  const sockets = new Set<WebSocket>();
  const replaying = new Set<WebSocket>();
  let stopping = false;
  const http = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Tidy-Client-Contract, X-Tidy-Binding-Revision"
    );
    response.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, OPTIONS"
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(request.url ?? "/", "http://gateway.invalid");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET" && (await serveApp(url.pathname, response)))
        return;
      if (!authorized(request, url, options.token)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (stopping) {
        json(response, 503, { error: "gateway_stopping" });
        return;
      }
      if (!application) {
        json(response, 503, { error: "gateway_starting" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/version") {
        json(response, 200, {
          version: DAEMON_VERSION,
          capabilities: GATEWAY_CAPABILITIES,
          fleetDir: fleet.dir,
          ...(options.fleetName ? { fleetName: options.fleetName } : {}),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/fleet") {
        json(response, 200, application.roster());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        json(response, 200, { toolOutput: "off" });
        return;
      }
      const match = /^\/api\/bots\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (!match) {
        json(response, 404, { error: "not_found" });
        return;
      }
      const name = decodeURIComponent(match[1]),
        action = match[2];
      if (request.method === "GET") {
        if (action === "capabilities") {
          json(response, 200, application.binding(name));
          return;
        }
        if (action === "transcript") {
          const before = url.searchParams.get("before"),
            rawLimit = url.searchParams.get("limit");
          const limit = rawLimit === null ? 500 : Number(rawLimit);
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 1000 ||
            (before !== null && !Number.isFinite(Date.parse(before)))
          )
            throw new ProtocolError(
              "invalid_cursor",
              "Invalid transcript page"
            );
          const entries = application
            .transcript(name)
            .filter((entry) => !before || String(entry.ts) < before);
          json(response, 200, {
            transcript: entries.slice(-limit),
            hasMore: entries.length > limit,
          });
          return;
        }
        const operation = /^operations\/([^/]+)$/.exec(action);
        if (operation) {
          const receipt = application.inspect(
            name,
            decodeURIComponent(operation[1]),
            url.searchParams.get("conversationId") ?? undefined
          );
          json(
            response,
            receipt ? 200 : 404,
            receipt ?? { error: "operation_not_found" }
          );
          return;
        }
      }
      if (request.method === "POST" || request.method === "PUT") {
        const binding = application.binding(name);
        if (request.headers["x-tidy-client-contract"] !== "2")
          throw new ProtocolError(
            "client_upgrade_required",
            "Client contract 2 required"
          );
        if (
          request.headers["x-tidy-binding-revision"] !== binding.bindingRevision
        )
          throw new ProtocolError(
            "capabilities_changed",
            "Refresh binding capabilities"
          );
        if (request.method === "POST" && action === "message") {
          const receipt = application.admit(
            name,
            await body(request),
            "2",
            String(request.headers["x-tidy-binding-revision"])
          );
          json(response, 202, receipt);
          return;
        }
        const permission = /^permissions\/([^/]+)$/.exec(action);
        if (request.method === "POST" && permission) {
          json(
            response,
            202,
            application.admitPermission(
              name,
              decodeURIComponent(permission[1]),
              await body(request)
            )
          );
          return;
        }
        throw new ProtocolError(
          "capability_unavailable",
          "This control is unavailable for the effective binding"
        );
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    }
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: DEFAULT_LIMITS.maxFrameBytes,
  });
  const send = (socket: WebSocket, event: JsonObject): boolean => {
    if (socket.readyState !== socket.OPEN) return false;
    if (socket.bufferedAmount > DEFAULT_LIMITS.maxFrameBytes) {
      socket.terminate();
      return false;
    }
    socket.send(JSON.stringify(event));
    return true;
  };
  let unsubscribe = (): void => {};
  http.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", "http://gateway.invalid");
      if (
        url.pathname !== "/api/ws" ||
        !authorized(request, url, options.token, true)
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const app = application;
      if (!app || stopping) {
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"
        );
        return;
      }
      const since = Number(url.searchParams.get("since") ?? 0);
      if (sockets.size >= 256 || !Number.isSafeInteger(since) || since < 0) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.add(ws);
        replaying.add(ws);
        ws.on("error", () => ws.terminate());
        ws.on("close", () => {
          sockets.delete(ws);
          replaying.delete(ws);
        });
        // A replacement fleet can have a lower cursor. Deliver hello so the
        // client can observe bootId and refetch, rather than rejecting forever.
        const helloSeq = app.journal.publicSequence;
        send(ws, {
          type: "hello",
          fleet: fleet.dir,
          bootId: app.bootId,
          seq: helloSeq,
          ...(since > helloSeq ? { replayReset: true } : {}),
        });
        let cursor = Math.min(since, helloSeq);
        void (async () => {
          for (;;) {
            if (stopping || ws.readyState !== ws.OPEN) return;
            const events = app.journal.readEvents(cursor, 64);
            if (!events.length) break;
            for (const { seq, event } of events) {
              cursor = seq;
              if (event.type !== "bubble" && !send(ws, event)) return;
            }
            // Large replay must allow socket draining and writer-lease renewal.
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          // No event-loop yield between catching up and joining live delivery.
          replaying.delete(ws);
          app.refreshLiveSnapshots();
        })().catch(() => ws.terminate());
      });
    } catch {
      socket.destroy();
    }
  });
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopPromise ??= (async () => {
      stopping = true;
      unsubscribe();
      for (const socket of sockets) socket.terminate();
      wss.close();
      const closed = new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeIdleConnections();
      });
      let shutdownConfirmed =
        ownedApplication === undefined && !recoveryUnconfirmed;
      try {
        if (ownedApplication) {
          await ownedApplication.stop();
          shutdownConfirmed = true;
        }
      } finally {
        http.closeAllConnections();
        await closed;
        // Owned plugin shutdown is awaited before cross-mode ownership is released.
        if (shutdownConfirmed) ownership.lock.release();
      }
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(fleet.port, fleet.host, () => {
        http.removeListener("error", reject);
        resolve();
      });
    });
    // Reserve the actual listener before any plugin/session creation. A failed
    // bind must not leave a durable native session in a fleet that never started.
    application = await GatewayApplication.start(
      fleet,
      options.log,
      (created) => {
        ownedApplication = created;
      }
    );
    unsubscribe = application.subscribe((event) => {
      for (const socket of sockets)
        if (!replaying.has(socket)) send(socket, event);
    });
  } catch (error) {
    if (error instanceof GatewayStartupOwnershipError)
      recoveryUnconfirmed = true;
    await stop();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === "string") {
    await stop();
    throw new Error("Gateway listener did not bind a TCP port");
  }
  const hostname = fleet.host.includes(":") ? `[${fleet.host}]` : fleet.host;
  return {
    url: `http://${hostname}:${address.port}`,
    port: address.port,
    token: options.token,
    childSecret: randomUUID(),
    fleetDir: fleet.dir,
    stop,
  };
}
