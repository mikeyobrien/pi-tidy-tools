// Wire layer of the fleet daemon (issue 93). Pure move out of daemon.ts:
// route set, auth checks, and asset helpers are byte-identical. daemon.ts
// re-exports the moved symbols so imports/tests are unchanged.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  botDisclosure,
  type FleetConfig,
  type ToolOutputMode,
} from "./config.ts";
import { DEFAULT_COMPACT_FALLBACK_MODEL } from "./daemon.ts";
import { paginateTranscript } from "./transcripts.ts";
import { versionPayload } from "./contract.ts";
import type { BotRuntime } from "./daemon.ts";

// Mirrors daemon.ts ACTIVE_WINDOW_MS (presence staleness window).
const ACTIVE_WINDOW_MS = 90_000;

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const APP_DIR = join(PUBLIC_DIR, "app");

// Issue 60: /app/ mounts the Flutter web build (synced via
// scripts/sync-flutter-web.mjs). Hashed assets cache immutably; entry
// documents revalidate. Traversal outside the mount is refused.
const APP_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export function appAssetMimeType(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1
    ? "application/octet-stream"
    : (APP_MIME[path.slice(dot)] ?? "application/octet-stream");
}

const HASHED_ASSET = /(?:[\\/.\-]|^)[0-9a-f_-]{8,}\./i;

export function isHashedAsset(path: string): boolean {
  return HASHED_ASSET.test(path);
}

export function appAssetCacheControl(path: string): string {
  if (path.endsWith(".html") || path.endsWith(".json")) return "no-store";
  return isHashedAsset(path)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300";
}

export function safeAppAssetPath(
  urlPath: string,
  root: string = APP_DIR
): string | undefined {
  const relative = urlPath.replace(/^\/app\/?/, "");
  // Directory mount points serve the entry document, matching `app.get("/")`
  // behavior for the vanilla console. Files under /app/ pass through.
  const resolved = join(root, relative || "index.html");
  if (!resolved.startsWith(root)) return undefined;
  return resolved;
}

/**
 * Public-asset bypass (issue 60): the /app/ tree and the vanilla console's
 * no-store assets carry no fleet data, so subresources load without the
 * document's ?token=. Everything else (/, /api/*, /bus/send) stays gated.
 */
export function isPublicAssetPath(pathname: string): boolean {
  return (
    pathname === "/app.js" ||
    pathname === "/style.css" ||
    pathname === "/md.js" ||
    pathname === "/parts.js" ||
    pathname === "/app" ||
    pathname.startsWith("/app/")
  );
}

export type BusBehavior = "steer" | "followUp";

/**
 * Validate the optional /bus/send behavior field. Omitted = auto delivery;
 * anything outside the two-value enum fails the request with a 400 naming
 * the field.
 */
export function coerceBusBehavior(
  value: unknown
): { ok: true; behavior?: BusBehavior } | { ok: false } {
  if (value === undefined) return { ok: true, behavior: undefined };
  return value === "steer" || value === "followUp"
    ? { ok: true, behavior: value }
    : { ok: false };
}

/**
 * Validate optional composer images for POST /message: at most one, each with
 * string mediaType + base64 data. Forwarded to the child as pi ImageContent.
 * Shared item validation with the bus handoff path (issue 75), which has NO
 * cap — pixel-faithful dispatch forwards every image the sender attaches.
 */
export type ChildImages = { type: "image"; data: string; mimeType: string }[];

const coerceImageItem = (
  image: unknown
): { mediaType: string; data: string; name?: string } | null => {
  if (
    typeof image !== "object" ||
    image === null ||
    typeof (image as { mediaType?: unknown }).mediaType !== "string" ||
    (image as { mediaType: string }).mediaType.length === 0 ||
    typeof (image as { data?: unknown }).data !== "string" ||
    (image as { data: string }).data.length === 0
  )
    return null;
  const { mediaType, data } = image as { mediaType: string; data: string };
  const rawName = (image as { name?: unknown }).name;
  const name =
    typeof rawName === "string" && rawName.length > 0 ? rawName : undefined;
  // Issue 115: tolerate dataURL-prefixed payloads from device clients
  // ("data:image/png;base64,....") — strip to bare base64.
  const bare = data.replace(/^data:[^;]+;base64,/, "");
  if (bare.length === 0) return null;
  return { mediaType, data: bare, ...(name ? { name } : {}) };
};

const coerceImageArray = (
  value: unknown,
  max: number | undefined
):
  | { ok: true; images?: { type: "image"; data: string; mimeType: string }[] }
  | { ok: false } => {
  if (value === undefined) return { ok: true, images: undefined };
  if (!Array.isArray(value)) return { ok: false };
  if (max !== undefined && value.length > max) return { ok: false };
  if (value.length === 0) return { ok: true, images: undefined };
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  for (const item of value) {
    const coerced = coerceImageItem(item);
    if (!coerced) return { ok: false };
    images.push({
      type: "image",
      data: coerced.data,
      mimeType: coerced.mediaType,
    });
  }
  return { ok: true, images };
};

export function coerceMessageImages(
  value: unknown
):
  | { ok: true; images?: { type: "image"; data: string; mimeType: string }[] }
  | { ok: false } {
  return coerceImageArray(value, 1);
}

/** Journal record for non-image media (issue 110): no base64 — just what a
 * client needs to render a file chip. */
export interface MessageAttachment {
  name?: string;
  mediaType: string;
}

/**
 * Issue 110: POST /message accepts video and files, not only images.
 * Composer contract stays one attachment; image/* routes to the child
 * prompt (pi's ImageContent); any other media (video/*, application/*, …)
 * is JOURNALED ON THE TRANSCRIPT ENTRY — pi's rpc prompt takes images only,
 * so the bytes are not deliverable to the model. Clients render the chip
 * from {name, mediaType}.
 */
export function coerceMessageMedia(value: unknown):
  | {
      ok: true;
      images?: { type: "image"; data: string; mimeType: string }[];
      attachments?: MessageAttachment[];
    }
  | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value) || value.length > 1) return { ok: false };
  if (value.length === 0) return { ok: true };
  const item = coerceImageItem(value[0]);
  if (!item) return { ok: false };
  if (item.mediaType.startsWith("image/")) {
    return {
      ok: true,
      images: [{ type: "image", data: item.data, mimeType: item.mediaType }],
    };
  }
  return {
    ok: true,
    attachments: [
      {
        mediaType: item.mediaType,
        ...(item.name ? { name: item.name } : {}),
      },
    ],
  };
}

/**
 * Issue 75: bus handoff images — same wire shape as the composer
 * ({mediaType, data}), NO cap. Every image the sender attaches rides the
 * handoff prompt; completion notifications stay text-only by construction.
 */
export function coerceHandoffImages(
  value: unknown
):
  | { ok: true; images?: { type: "image"; data: string; mimeType: string }[] }
  | { ok: false } {
  return coerceImageArray(value, undefined);
}

/**
 * WS upgrade auth: `Authorization: Bearer <token>` or `?token=` — mirrors the
 * HTTP authorized() check so native clients can authenticate like browsers.
 */
/**
 * Issue 103: Tailscale Serve identity. When the console is fronted by
 * `tailscale serve` with tailnet user login, the proxy authenticates the
 * tailnet user and injects Tailscale-User-* headers — a non-empty
 * Tailscale-User-Login authenticates like the token (OpenClaw allowTailscale
 * model). Trust basis: the daemon stays bound to loopback/tailnet and
 * tailscale serve is the only ingress — it strips client-supplied
 * Tailscale-User-* headers. Source 100.64.0.0/10 alone is NOT trusted.
 */
export function tailscaleUserLogin(request: {
  headers: { get(name: string): string | null };
}): string | null {
  const read = request.headers.get("Tailscale-User-Login");
  return typeof read === "string" && read.trim().length > 0 ? read : null;
}

export function wsUpgradeAuthorized(
  request: { headers: { authorization?: string | undefined } },
  url: URL,
  token: string | undefined
): boolean {
  if (!token) return true;
  if (url.searchParams.get("token") === token) return true;
  if ((request.headers.authorization ?? "") === `Bearer ${token}`) return true;
  // Issue 103: Tailscale Serve identity headers authenticate the upgrade.
  return (
    tailscaleUserLogin({
      headers: {
        get: (name: string) =>
          name === "Tailscale-User-Login"
            ? (((request.headers as Record<string, unknown>)[
                "tailscale-user-login"
              ] as string | null) ?? null)
            : null,
      },
    }) !== null
  );
}

/** HTTP 401 frame completed onto a rejected WS upgrade socket. */
export const WS_AUTH_FAILURE_RESPONSE =
  "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** Bad WS token: answer with HTTP 401 (so clients see auth failure, not a dead socket). */
export function writeWsAuthFailure(socket: {
  write: (chunk: string) => void;
  destroy: () => void;
}): void {
  socket.write(WS_AUTH_FAILURE_RESPONSE);
  socket.destroy();
}

type RpcEvent2 = import("./rpc.ts").RpcEvent;

interface RoutineRuntimeView {
  bot: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
}

interface ServerDeps {
  fleet: FleetConfig;
  fleetName?: string;
  runtimes: Map<string, BotRuntime>;
  routines: RoutineRuntimeView[];
  onRoster: () => void;
  onToolOutput: (mode: ToolOutputMode) => void;
  persistToolOutput: (mode: ToolOutputMode) => void;
  getToolOutput(): ToolOutputMode;
  token?: string;
  childSecret: string;
  log: (line: string) => void;
  handlers: {
    message(
      name: string,
      text: string,
      images?: { type: "image"; data: string; mimeType: string }[],
      clientMessageId?: string,
      attachments?: { name?: string; mediaType: string }[]
    ): Promise<{ status: number; body: unknown }>;
    compact(name: string): Promise<{ status: number; body: unknown }>;
    stop(name: string): Promise<{ status: number; body: unknown }>;
    queue(
      name: string
    ): { id: string; text: string; hasImage: boolean; filename?: string }[];
    unqueue(name: string, id: string): { status: 200 | 404 };
    loadTranscript(name: string): unknown[];
    setModel(name: string, model: string): { status: 200 | 404 };
    operatorEnqueue(input: {
      title: string;
      receipts?: { ref: string; detail?: string }[];
      source: string;
    }): unknown;
    operatorQueueView(): unknown;
    operatorQueueClear(id: string): unknown;
    attachCompletionSummary(
      name: string,
      summary: string
    ): { status: 200 | 404; error?: string; entry?: unknown };
    steer(
      name: string,
      text: string
    ): Promise<{ status: number; body: unknown }>;
    toggleRoutine(
      botName: string,
      routineName: string
    ): { status: number; body: unknown };
    runRoutine(
      botName: string,
      routineName: string
    ): { status: number; body: unknown };
    answerUi(
      name: string,
      uiId: string,
      body: { value?: string; confirmed?: boolean; cancel?: boolean }
    ): { status: number; body: unknown };
    busSend(
      from: string,
      target: string,
      message: string,
      behavior?: "steer" | "followUp",
      images?: { type: "image"; data: string; mimeType: string }[]
    ): Promise<{ status: number; body: unknown }>;
  };
}

export function buildHttpServer(deps: ServerDeps): Hono {
  const app = new Hono();
  const authorized = (url: URL, request: Request): boolean =>
    !deps.token ||
    url.searchParams.get("token") === deps.token ||
    (request.headers.get("authorization") ?? "") === `Bearer ${deps.token}` ||
    // Issue 103: Tailscale Serve identity headers authenticate like the token.
    tailscaleUserLogin(request) !== null;

  const tokenPage = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>pi-tidy-bots — access</title><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e8ecf3;font:14px/1.5 -apple-system,'Inter',sans-serif}main{background:#12161f;border:1px solid #232a38;border-radius:14px;padding:28px;width:min(420px,90vw)}h1{font-size:16px;margin:0 0 6px}p{color:#8a93a6;margin:0 0 16px;font-size:13px}input{width:100%;background:#171c27;border:1px solid #232a38;color:#e8ecf3;border-radius:10px;padding:11px 12px;font:inherit;outline:none}input:focus{border-color:#2dd4bf}button{margin-top:10px;width:100%;border:none;border-radius:10px;padding:11px;background:#2dd4bf;color:#06251f;font-weight:700;cursor:pointer}</style></head><body><main><h1>Fleet console access</h1><p>Paste the fleet token (printed by <code>pi-tidy-bots start</code>, or in <code>.fleet/token</code>).</p><form onsubmit="location.href='/?token='+encodeURIComponent(this.t.value.trim());return false"><input name="t" placeholder="fleet token" autofocus /><button>Enter console</button></form></main></body></html>`;

  app.use(async (context, next) => {
    const url = new URL(context.req.url);
    if (url.pathname === "/bus/send") {
      if (context.req.header("x-fleet-child") !== deps.childSecret) {
        return context.json({ delivered: false, reason: "unauthorized" }, 401);
      }
      await next();
      return;
    }
    // Issue 62: bots disclose peers by reading /api/fleet with their child
    // secret (bridge.ts enumerates message_agent targets from the live
    // roster). The secret is per-fleet and unguessable — allow it on any
    // route, not just the bus.
    if (context.req.header("x-fleet-child") === deps.childSecret) {
      await next();
      return;
    }
    // Public assets carry no fleet data; browsers fetch them without the document's query token.
    if (isPublicAssetPath(url.pathname)) {
      await next();
      return;
    }
    if (!authorized(url, context.req.raw)) {
      if (url.pathname.startsWith("/api/") || url.pathname === "/api/ws") {
        deps.log(
          `http ${context.req.method} ${url.pathname} -> 401 (unauthorized)`
        );
        return context.json({ error: "unauthorized" }, 401);
      }
      deps.log(
        `http ${context.req.method} ${url.pathname} -> 401 (token page)`
      );
      return context.html(tokenPage, 401);
    }
    await next();
    // Request telemetry (issue 51 ops): one line per API request with status
    // and source, so unreachable-vs-auth-vs-app-bug is answerable from the
    // log alone.
    if (url.pathname.startsWith("/api/")) {
      const peer =
        (context.env as any)?.incoming?.socket?.remoteAddress ?? "unknown";
      deps.log(
        `http ${context.req.method} ${url.pathname} -> ${context.res.status} from ${peer}`
      );
    }
  });

  const serveAsset = (file: string, type: string) => (context: any) => {
    const body = readFileSync(join(PUBLIC_DIR, file), "utf8");
    return context.body(body, 200, {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
    });
  };
  app.get("/", serveAsset("index.html", "text/html"));
  app.get("/console", serveAsset("index.html", "text/html"));
  app.get("/app.js", serveAsset("app.js", "text/javascript"));
  app.get("/md.js", serveAsset("md.js", "text/javascript"));
  app.get("/parts.js", serveAsset("parts.js", "text/javascript"));
  app.get("/app/*", (context) => {
    const asset = safeAppAssetPath(context.req.path);
    if (!asset || !existsSync(asset) || !statSync(asset).isFile())
      return context.json({ error: "not found" }, 404);
    return context.body(readFileSync(asset), 200, {
      "content-type": appAssetMimeType(asset),
      "cache-control": appAssetCacheControl(asset),
    });
  });
  app.get("/app", (context) =>
    context.redirect(`/app/${new URL(context.req.url).search}`)
  );
  app.get("/style.css", serveAsset("style.css", "text/css"));

  app.get("/api/fleet", (context) => {
    const bots = [...deps.runtimes.values()].map((runtime) => {
      const queue = deps.handlers.queue(runtime.config.name);
      return {
        name: runtime.config.name,
        title: runtime.config.title,
        description: botDisclosure(runtime.config),
        avatar: runtime.config.avatar,
        online: runtime.online,
        active: Date.now() - Date.parse(runtime.lastActive) < ACTIVE_WINDOW_MS,
        lastActive: runtime.lastActive,
        queued: queue.length,
        queue,
        latest: runtime.transcript.at(-1)?.text ?? "",
      };
    });
    return context.json({ dir: deps.fleet.dir, bots });
  });

  app.get("/api/bots/:name/context", (context) => {
    const runtime = deps.runtimes.get(context.req.param("name"));
    if (!runtime) return context.json({ error: "unknown bot" }, 404);
    // Amendment: fill always reads the LIVE window (recomputed on every
    // window learn); overWindow flags contexts exceeding the model window.
    return context.json({
      fill: runtime.fill ?? null,
      inputTokens: runtime.inputTokens ?? null,
      contextWindow: runtime.contextWindow ?? null,
      overWindow:
        runtime.inputTokens !== undefined &&
        runtime.contextWindow !== undefined &&
        runtime.inputTokens > runtime.contextWindow,
      ...(deps.fleet.compactFallbackModel || DEFAULT_COMPACT_FALLBACK_MODEL
        ? {
            compactFallbackModel:
              deps.fleet.compactFallbackModel ?? DEFAULT_COMPACT_FALLBACK_MODEL,
          }
        : {}),
      lastCompactAt: runtime.lastCompactAt ?? null,
      turnsSinceCompact: runtime.turnsSinceCompact,
    });
  });

  app.get("/api/version", (context) => {
    return context.json({
      ...versionPayload(),
      fleetName: deps.fleetName,
      fleetDir: deps.fleet.dir,
    });
  });

  app.get("/api/settings", (context) => {
    return context.json({ toolOutput: deps.getToolOutput() });
  });

  app.post("/api/settings", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      toolOutput?: string;
    };
    if (
      !body.toolOutput ||
      !["off", "counts", "reasons", "full"].includes(body.toolOutput)
    ) {
      return context.json(
        { error: "toolOutput must be off|counts|reasons|full" },
        400
      );
    }
    deps.onToolOutput(body.toolOutput as ToolOutputMode);
    return context.json({ toolOutput: body.toolOutput });
  });

  // Issue 82: fleet-wide rules — a single markdown file every bot receives
  // on its NEXT delivered prompt/followUp (per rules version; no respawn
  // needed, in-flight turns never steered). Missing/empty file is a normal
  // state (text: "", never 404). Mason's drawer edits via PUT.
  app.get("/api/rules", (context) => {
    let text = "";
    try {
      text = readFileSync(join(deps.fleet.dir, ".fleet", "rules.md"), "utf8");
    } catch {
      // No rules yet.
    }
    return context.json({ text });
  });

  app.put("/api/rules", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      text?: unknown;
    };
    if (typeof body.text !== "string")
      return context.json({ error: "text (string) required" }, 400);
    const rulesPath = join(deps.fleet.dir, ".fleet", "rules.md");
    mkdirSync(join(deps.fleet.dir, ".fleet"), { recursive: true });
    writeFileSync(rulesPath, body.text);
    return context.json({ text: body.text });
  });

  // Issue 159: operator attention queue — one-at-a-time, server-enforced.
  app.get("/api/operator/queue", (context) => {
    return context.json(deps.handlers.operatorQueueView());
  });

  app.post("/api/operator/queue", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      title?: unknown;
      receipts?: unknown;
      source?: unknown;
    };
    if (typeof body.title !== "string" || body.title.trim().length === 0)
      return context.json({ error: "title (non-empty string) required" }, 400);
    const receipts = Array.isArray(body.receipts)
      ? body.receipts
          .filter(
            (entry): entry is { ref: string; detail?: string } =>
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as { ref?: unknown }).ref === "string" &&
              (entry as { ref: string }).ref.length > 0
          )
          .map((entry) => ({
            ref: entry.ref,
            ...(typeof entry.detail === "string" && entry.detail.length > 0
              ? { detail: entry.detail }
              : {}),
          }))
      : [];
    const item = deps.handlers.operatorEnqueue({
      title: body.title.trim(),
      ...(receipts.length > 0 ? { receipts } : {}),
      source:
        typeof body.source === "string" && body.source.length > 0
          ? body.source
          : "operator",
    });
    return context.json({ item });
  });

  app.post("/api/operator/queue/:id/clear", (context) => {
    const result = deps.handlers.operatorQueueClear(context.req.param("id"));
    if (!result)
      return context.json({ error: "unknown or already-cleared id" }, 404);
    return context.json(result);
  });

  app.get("/api/routines", (context) => {
    return context.json({
      routines: deps.routines.map((routine) => ({
        bot: routine.bot,
        name: routine.name,
        schedule: routine.schedule,
        prompt: routine.prompt,
        enabled: routine.enabled,
      })),
    });
  });

  app.post("/api/bots/:name/routines/:routine/toggle", (context) => {
    const result = deps.handlers.toggleRoutine(
      context.req.param("name"),
      context.req.param("routine")
    );
    return context.json(result.body, result.status as 200 | 404);
  });

  app.post("/api/bots/:name/routines/:routine/run", (context) => {
    const result = deps.handlers.runRoutine(
      context.req.param("name"),
      context.req.param("routine")
    );
    return context.json(result.body, result.status as 200 | 404 | 503);
  });

  app.get("/api/bots/:name/transcript", (context) => {
    const runtime = deps.runtimes.get(context.req.param("name"));
    if (!runtime) return context.json({ error: "unknown bot" }, 404);
    // Issue 104 (P1, live-hit): the RAM transcript is a slice(-50) of the
    // merged history — the API served 54 of 968 real rows and `before=`
    // walks died on page one. appendTranscript persists synchronously, so
    // the JSONL journal IS the complete history: paginate from
    // deps.handlers.loadTranscript when paging params are present; the
    // no-param hot path stays the RAM list (identical content, zero disk
    // reads).
    const before = context.req.query("before");
    const limit = context.req.query("limit");
    const source =
      before === undefined && limit === undefined
        ? runtime.transcript
        : (deps.handlers.loadTranscript(
            context.req.param("name")
          ) as typeof runtime.transcript);
    const page = paginateTranscript(source, { before, limit });
    if (!page.ok) return context.json({ error: page.error }, 400);
    return context.json({ transcript: page.entries });
  });

  // Issue 115: captioned device photos exceed default body budgets — the
  // message route accepts an explicit ~15MB body (declared AND actual).
  const MAX_MESSAGE_BODY_BYTES = 15 * 1024 * 1024;
  const parseMessageBody = async (context: {
    req: {
      header: (name: string) => string | undefined;
      arrayBuffer: () => Promise<ArrayBuffer>;
    };
  }): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; status: 400 | 413; error: string }
  > => {
    const declared = Number(context.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_MESSAGE_BODY_BYTES)
      return { ok: false, status: 413, error: "body too large" };
    const raw = await context.req.arrayBuffer();
    if (raw.byteLength > MAX_MESSAGE_BODY_BYTES)
      return { ok: false, status: 413, error: "body too large" };
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return { ok: false, status: 400, error: "invalid JSON body" };
      return { ok: true, body: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, status: 400, error: "invalid JSON body" };
    }
  };

  app.post("/api/bots/:name/message", async (context) => {
    const parsedBody = await parseMessageBody(context);
    if (!parsedBody.ok)
      return context.json(
        { error: parsedBody.error },
        parsedBody.status as 400 | 413
      );
    const body = parsedBody.body as {
      text?: string;
      images?: unknown;
      attachments?: unknown;
      clientMessageId?: unknown;
    };
    // Issue 181: a standalone `attachments` key is silently ignored today
    // (200, attachments=null, "no clip came through") — honor it as an
    // alias of `images` (same composer wire shape) rather than rejecting:
    // callers already send it meaningfully.
    if (body.images === undefined && body.attachments !== undefined)
      body.images = body.attachments;
    if (
      body.clientMessageId !== undefined &&
      typeof body.clientMessageId !== "string"
    )
      return context.json({ error: "clientMessageId must be a string" }, 400);
    const media = coerceMessageMedia(body.images);
    if (!media.ok) {
      return context.json(
        {
          error:
            "images must be one { mediaType, data } object with non-empty strings",
        },
        400
      );
    }
    // Issue 114: an image/media send may carry an empty caption — text is
    // required only when nothing is attached. Empty text + no media is a 400.
    const hasMedia =
      (media.images?.length ?? 0) > 0 || (media.attachments?.length ?? 0) > 0;
    const hasText =
      typeof body.text === "string" && body.text.trim().length > 0;
    if (!hasText && !hasMedia)
      return context.json({ error: "text required" }, 400);
    const result = await deps.handlers.message(
      context.req.param("name"),
      typeof body.text === "string" ? body.text.trim() : "",
      media.images,
      body.clientMessageId,
      media.attachments
    );
    return context.json(
      result.body,
      result.status as 200 | 202 | 404 | 409 | 503
    );
  });

  app.post("/api/bots/:name/ui/:uiId", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      value?: string;
      confirmed?: boolean;
      cancel?: boolean;
    };
    const result = deps.handlers.answerUi(
      context.req.param("name"),
      context.req.param("uiId"),
      body
    );
    return context.json(result.body, result.status as 200 | 400 | 404 | 503);
  });

  app.post("/api/bots/:name/compact", async (context) => {
    const result = await deps.handlers.compact(context.req.param("name"));
    return context.json(result.body, result.status as 200 | 404 | 409 | 503);
  });

  app.post("/api/bots/:name/stop", async (context) => {
    const result = await deps.handlers.stop(context.req.param("name"));
    return context.json(result.body, result.status as 200 | 404 | 503);
  });

  // Issue 76: the follow-up queue as data — items (no base64) + dismiss.
  // Issue 83: per-bot instructions — the persona document, read/written as
  // opaque text. Applies on the bot's next turn via the existing persona
  // watcher (in-place reload when idle, queued when busy). The wire surface
  // stays abstract: no file names, no paths — a missing document is simply
  // empty text, never an error.
  // Issue 88: per-bot model — GET the effective model, PUT to change it.
  // Persisted in the fleet state store (survives restarts); applied by
  // respawning ONLY that bot (--model is spawn-time). The wire surface never
  // names the manifest.
  app.get("/api/bots/:name/model", (context) => {
    const runtime = deps.runtimes.get(context.req.param("name"));
    if (!runtime) return context.json({ error: "unknown bot" }, 404);
    return context.json({ model: runtime.config.model ?? "" });
  });

  app.put("/api/bots/:name/model", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      model?: unknown;
    };
    if (typeof body.model !== "string")
      return context.json({ error: "model (string) required" }, 400);
    const result = deps.handlers.setModel(
      context.req.param("name"),
      body.model
    );
    if (result.status === 404)
      return context.json({ error: "unknown bot" }, 404);
    return context.json({ model: body.model });
  });

  // Issue 122: summary attach for peer completions — authorized like any
  // console API; bots ride it with their child secret via the bridge tool.
  app.put("/api/bots/:name/completion-summary", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      summary?: unknown;
    };
    if (typeof body.summary !== "string" || body.summary.trim().length === 0)
      return context.json(
        { error: "summary (non-empty string) required" },
        400
      );
    const result = deps.handlers.attachCompletionSummary(
      context.req.param("name"),
      body.summary.trim()
    );
    if (result.status !== 200)
      return context.json({ error: result.error }, result.status);
    return context.json({ attached: true });
  });

  // Issue 176: serve persisted entry-image blobs (authed like every /api).
  app.get("/api/images/:bot/:file", (context) => {
    const bot = context.req.param("bot");
    const file = context.req.param("file");
    // Path traversal guard: flat names only.
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes(".."))
      return context.json({ error: "bad file" }, 400);
    const path = join(deps.fleet.dir, ".fleet", "images", bot, file);
    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch {
      return context.json({ error: "not found" }, 404);
    }
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    const media =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : "application/octet-stream";
    return context.body(body, 200, {
      "content-type": media,
      "cache-control": "no-store",
    });
  });

  app.get("/api/bots/:name/instructions", (context) => {
    const runtime = deps.runtimes.get(context.req.param("name"));
    if (!runtime) return context.json({ error: "unknown bot" }, 404);
    let text = "";
    try {
      text = readFileSync(join(runtime.config.dir, "AGENTS.md"), "utf8");
    } catch {
      // No instructions yet — empty text, not an error.
    }
    return context.json({ text });
  });

  app.put("/api/bots/:name/instructions", async (context) => {
    const runtime = deps.runtimes.get(context.req.param("name"));
    if (!runtime) return context.json({ error: "unknown bot" }, 404);
    const body = (await context.req.json().catch(() => ({}))) as {
      text?: unknown;
    };
    if (typeof body.text !== "string")
      return context.json({ error: "text (string) required" }, 400);
    try {
      writeFileSync(join(runtime.config.dir, "AGENTS.md"), body.text);
    } catch {
      return context.json({ error: "instructions not writable" }, 500);
    }
    return context.json({ text: body.text });
  });

  app.get("/api/bots/:name/queue", (context) => {
    const name = context.req.param("name");
    if (!deps.runtimes.has(name))
      return context.json({ error: "unknown bot" }, 404);
    return context.json({ queue: deps.handlers.queue(name) });
  });

  app.delete("/api/bots/:name/queue/:id", (context) => {
    const result = deps.handlers.unqueue(
      context.req.param("name"),
      context.req.param("id")
    );
    if (result.status === 404) return context.json({ removed: false }, 404);
    return context.json({ removed: true });
  });

  app.post("/api/bots/:name/steer", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      text?: string;
    };
    if (!body.text) return context.json({ error: "text required" }, 400);
    const result = await deps.handlers.steer(
      context.req.param("name"),
      body.text.trim()
    );
    return context.json(result.body, result.status as 200 | 404 | 503);
  });

  app.post("/bus/send", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      from?: string;
      target?: string;
      message?: string;
      behavior?: string;
    };
    if (!body.from || !body.target || !body.message) {
      return context.json({ delivered: false, reason: "missing_config" }, 400);
    }
    const behavior = coerceBusBehavior(body.behavior);
    if (!behavior.ok) {
      return context.json(
        {
          delivered: false,
          reason: "invalid_behavior",
          error: 'behavior must be "steer" or "followUp"',
        },
        400
      );
    }
    // Issue 75: handoff images — composer wire shape, uncapped.
    const images = coerceHandoffImages((body as { images?: unknown }).images);
    if (!images.ok) {
      return context.json(
        {
          delivered: false,
          reason: "invalid_images",
          error: "images must be {mediaType, data} objects",
        },
        400
      );
    }
    const result = await deps.handlers.busSend(
      body.from,
      body.target,
      body.message,
      behavior.behavior,
      images.images
    );
    return context.json(result.body, result.status as 200 | 404 | 503);
  });

  return app;
}
