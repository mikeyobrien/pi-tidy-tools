import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { acquireFleetLock } from "./lock.ts";
import {
  loadFleetConfig,
  checkRoute,
  diffFleet,
  ConfigError,
  normalizeToolOutput,
  type BotConfig,
  type FleetConfig,
  type ToolOutputMode,
} from "./config.ts";
import {
  RpcSession,
  autoUiAnswer,
  describeUiAnswer,
  isFireAndForgetUiMethod,
  isInteractiveUiMethod,
  type RpcEvent,
  type UiAnswer,
} from "./rpc.ts";
import { isDue, minuteKey, parseCron } from "./cron.ts";
import { createEventLog } from "./eventlog.ts";
import {
  attributionPrefix,
  completionNotification,
  stripActionMarkers,
} from "./actions.ts";
import { classifyFailure, isRetryable } from "./reasons.ts";
import {
  createTranscriptStore,
  mergeTranscriptHistory,
  paginateTranscript,
} from "./transcripts.ts";
import { createPendingStore, type PendingMessage } from "./pending.ts";
import { TurnPartsAccumulator, type TurnPart } from "./turnparts.ts";
import { versionPayload } from "./contract.ts";
import { describePortHolder } from "./cli-core.ts";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "system";
  /** Who produced this entry — replaces the old display-string `source`. */
  origin: "operator" | "bot" | "routine" | "system";
  /** Actor name for bot/routine origins (sending bot, routine name). */
  originFrom?: string;
  /** Issue 58: structured handoff lifecycle kinds (console renders these). */
  kind?: "handoff" | "handoff-receipt" | "completion";
  text: string;
  ts: string;
  steps?: { name: string; duration?: number }[];
  delivering?: boolean;
  /** Set when delivery failed for good — rendered as a visible failure. */
  deliveryError?: string;
  /** Issue 37: ordered text/tool parts for the settled turn. */
  parts?: TurnPart[];
  ui?: UiRequestView;
  uiResolved?: { id: string; value: string; auto: boolean };
}

/** A pending interactive question from the bot's session (ask_user_question and friends). */
export interface UiRequestView {
  id: string;
  method: string;
  title: string;
  options?: string[];
  message?: string;
  placeholder?: string;
}

interface BotRuntime {
  config: BotConfig;
  session: RpcSession | null;
  online: boolean;
  lastActive: string;
  transcript: TranscriptEntry[];
  pendingFrom: string[];
  restartTimes: number[];
  stopping: boolean;
  turnId: string | null;
  // Delta throttle state (issue 20 item 6): last WS delta emission for the
  // current turn — null until the first eligible emission.
  deltaSent: { at: number; chars: number } | null;
  turnText: string;
  /** Issue 37: ordered text/tool parts for the in-flight turn. */
  turnParts: TurnPartsAccumulator;
  // Known limit: covers daemon-issued prompts only (routing, composer,
  // routines). Follow-ups queued inside the child by extensions are invisible
  // to the daemon — acceptable; operator-visible cases are all daemon-issued.
  queuedCount: number;
  /** Claimed clientMessageIds (issue 33 idempotency). */
  clientMessageIds: Set<string>;
  pendingUi: Map<
    string,
    { view: UiRequestView; timer: ReturnType<typeof setTimeout> }
  >;
  steps: {
    toolCallId: string;
    name: string;
    reason: string;
    label?: string;
    started: number;
    duration?: number;
    output?: string;
    error?: boolean;
  }[];
}

export interface FleetHandle {
  url: string;
  port?: number;
  token?: string;
  fleetDir: string;
  stop(): Promise<void>;
}

export interface StartFleetOptions {
  dir: string;
  /** Registry name (issue 42) surfaced in /api/version for fleet identity. */
  fleetName?: string;
  port?: number;
  host?: string;
  token?: string;
  toolOutput?: ToolOutputMode;
  piBin?: string;
  log?: (line: string) => void;
}

const ACTIVE_WINDOW_MS = 90_000;
const MAX_RESTARTS_PER_WINDOW = 3;
const RESTART_WINDOW_MS = 60_000;

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;

/**
 * Boot-time routine validation. A schedule parseCron rejects can never fire —
 * every scheduler tick throws and the catch skips the row — so surface each
 * one as a warning naming bot, routine, schedule, and reason. Fail-soft: the
 * fleet still boots and valid routines keep firing.
 */
export function routineBootWarnings(
  routines: { bot: string; name: string; schedule: string }[]
): string[] {
  const warnings: string[] = [];
  for (const routine of routines) {
    try {
      parseCron(routine.schedule);
    } catch {
      warnings.push(
        `routine "${routine.name}" for bot "${routine.bot}": schedule "${routine.schedule}" will never fire [reason: invalid cron]`
      );
    }
  }
  return warnings;
}

/**
 * One scheduler tick. A routine that is due but cannot fire (bot session null
 * or dead) is journaled as `skipped` [reason: bot_offline] and does not consume
 * its minute key — the next tick within the same minute retries. Only a
 * successful fire consumes the key and journals `fired`.
 */
export function runSchedulerTick<
  R extends { bot: string; name: string; schedule: string; enabled: boolean },
>(
  now: Date,
  deps: {
    routines: R[];
    firedKeys: Set<string>;
    fireRoutine: (routine: R, manual: boolean) => boolean;
    journal: (record: Record<string, unknown>) => void;
  }
): void {
  const minute = minuteKey(now);
  for (const routine of deps.routines) {
    if (!routine.enabled) continue;
    const key = `${routine.bot}:${routine.name}:${minute}`;
    if (deps.firedKeys.has(key)) continue;
    try {
      if (!isDue(now, routine.schedule)) continue;
    } catch {
      continue;
    }
    if (!deps.fireRoutine(routine, false)) {
      deps.journal({
        key,
        bot: routine.bot,
        routine: routine.name,
        status: "skipped",
        reason: "bot_offline",
        schedule: routine.schedule,
      });
      continue;
    }
    deps.firedKeys.add(key);
    deps.journal({
      key,
      bot: routine.bot,
      routine: routine.name,
      status: "fired",
      schedule: routine.schedule,
    });
  }
}

export type BusBehavior = "steer" | "followUp";
/**
 * Idempotency guard (issue 33): a clientMessageId may be claimed once per
 * bot. Unknown/absent ids always claim. Returns false on duplicate.
 */
export function claimClientMessageId(
  seen: Set<string>,
  clientMessageId?: string
): boolean {
  if (clientMessageId === undefined) return true;
  if (seen.has(clientMessageId)) return false;
  seen.add(clientMessageId);
  return true;
}

/**
 * Delta throttle decision (issue 20 item 6): emit when nothing was sent yet,
 * when ≥300ms passed since the last emission, or when the cumulative text
 * grew by ≥256 bytes — whichever comes first.
 */
export function deltaThrottleDue(
  last: { at: number; chars: number } | null,
  nextLength: number,
  now: number
): boolean {
  if (!last) return true;
  return now - last.at >= 300 || nextLength - last.chars >= 256;
}

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
 */
export function coerceMessageImages(
  value: unknown
):
  | { ok: true; images?: { type: "image"; data: string; mimeType: string }[] }
  | { ok: false } {
  if (value === undefined) return { ok: true, images: undefined };
  if (!Array.isArray(value) || value.length > 1) return { ok: false };
  if (value.length === 0) return { ok: true, images: undefined };
  const [image] = value as unknown[];
  if (
    typeof image !== "object" ||
    image === null ||
    typeof (image as { mediaType?: unknown }).mediaType !== "string" ||
    (image as { mediaType: string }).mediaType.length === 0 ||
    typeof (image as { data?: unknown }).data !== "string" ||
    (image as { data: string }).data.length === 0
  )
    return { ok: false };
  const { mediaType, data } = image as { mediaType: string; data: string };
  return {
    ok: true,
    images: [{ type: "image", data, mimeType: mediaType }],
  };
}

/**
 * WS upgrade auth: `Authorization: Bearer <token>` or `?token=` — mirrors the
 * HTTP authorized() check so native clients can authenticate like browsers.
 */
export function wsUpgradeAuthorized(
  request: { headers: { authorization?: string | undefined } },
  url: URL,
  token: string | undefined
): boolean {
  if (!token) return true;
  if (url.searchParams.get("token") === token) return true;
  return (request.headers.authorization ?? "") === `Bearer ${token}`;
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

export function startFleet(options: StartFleetOptions): Promise<FleetHandle> {
  const log = options.log ?? ((line: string) => console.log(line));
  const fleetOverrides = { port: options.port, host: options.host };
  let fleet: FleetConfig = loadFleetConfig(options.dir, fleetOverrides);
  const childSecret = randomUUID();

  // Fleet state: routines toggles + console settings persist in .fleet/state.json;
  // fire/skip journal in .fleet/routines.jsonl (Flag B: missed fires are skipped + journaled).
  const statePath = join(fleet.dir, ".fleet", "state.json");
  let stored: {
    console?: { toolOutput?: unknown };
    routines?: Record<string, { enabled?: boolean }>;
  } = {};
  try {
    if (existsSync(statePath))
      stored = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    stored = {};
  }
  const journalPath = join(fleet.dir, ".fleet", "routines.jsonl");
  const transcripts = createTranscriptStore(
    join(fleet.dir, ".fleet", "transcripts")
  );
  const pendingStore = createPendingStore(join(fleet.dir, ".fleet", "pending"));
  let routineState: { routines?: Record<string, { enabled?: boolean }> } =
    stored;
  const persistStateFile = () =>
    writeFileSync(
      statePath,
      JSON.stringify({ ...stored, routines: routineState.routines }, null, 2)
    );
  const persistRoutineState = () => {
    stored.routines = routineState.routines;
    persistStateFile();
  };
  const journal = (record: Record<string, unknown>) => {
    try {
      mkdirSync(join(fleet.dir, ".fleet"), { recursive: true });
      appendFileSync(
        journalPath,
        `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`
      );
    } catch {
      /* journal is best-effort */
    }
  };

  const lockResult = acquireFleetLock(fleet.dir);
  if (!lockResult.ok) {
    const holder = lockResult.holder;
    throw new ConfigError(
      `fleet lock held by pid ${holder.pid} (acquired ${holder.acquiredAt}, heartbeat ${holder.heartbeatAt}). ` +
        `Only one daemon may own a fleet dir.`
    );
  }
  mkdirSync(join(fleet.dir, ".fleet"), { recursive: true, mode: 0o700 });
  mkdirSync(join(fleet.dir, ".fleet", "logs"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(join(fleet.dir, ".fleet", "sessions"), {
    recursive: true,
    mode: 0o700,
  });

  // Access token is opt-in via --token. By default the console is unauthenticated:
  // securing the network (loopback / tailnet / LAN) is the operator's responsibility.
  const token = options.token;

  // Tool-output visibility: CLI flag > persisted state > default "reasons".
  const toolOutput: ToolOutputMode = normalizeToolOutput(
    options.toolOutput ?? stored.console?.toolOutput ?? "reasons"
  );
  let persistToolOutputRef: (mode: ToolOutputMode) => void = () => {};
  const persistToolOutput = (mode: ToolOutputMode) => {
    const merged = {
      ...stored,
      console: { ...stored.console, toolOutput: mode },
    };
    stored = merged;
    persistStateFile();
  };
  persistToolOutputRef = persistToolOutput;

  const runtimes = new Map<string, BotRuntime>();
  const makeRuntime = (config: BotConfig): BotRuntime => ({
    config,
    session: null,
    online: false,
    lastActive: new Date().toISOString(),
    transcript: [],
    pendingFrom: [],
    restartTimes: [],
    stopping: false,
    turnId: null,
    deltaSent: null,
    turnText: "",
    turnParts: new TurnPartsAccumulator(),
    queuedCount: 0,
    clientMessageIds: new Set<string>(),
    steps: [],
    pendingUi: new Map(),
  });
  for (const config of fleet.bots) {
    runtimes.set(config.name, makeRuntime(config));
  }

  const sockets = new Set<WebSocket>();
  const daemonUrl = `http://127.0.0.1:${fleet.port}`;
  const bridgePath = new URL("./bridge.ts", import.meta.url).pathname;
  const piBin = options.piBin ?? process.env.PI_TIDY_BOTS_PI_BIN ?? "pi";

  const bootId = randomUUID();
  const eventLog = createEventLog(500);
  const emit = (event: Record<string, unknown>): void => {
    const sequenced = eventLog.publish(event);
    const payload = JSON.stringify(sequenced.payload);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };
  const viewSteps = (
    steps: {
      toolCallId: string;
      name: string;
      reason: string;
      label?: string;
      started: number;
      duration?: number;
      output?: string;
      error?: boolean;
    }[]
  ) =>
    steps.map((step) => ({
      toolCallId: step.toolCallId,
      name: step.name,
      reason: step.reason,
      ...(step.label ? { label: step.label } : {}),
      ...(activeToolOutput === "full" && step.output
        ? { output: step.output }
        : {}),
      ...(step.duration !== undefined ? { duration: step.duration } : {}),
      ...(step.error ? { error: true } : {}),
    }));

  const presence = (runtime: BotRuntime) => ({
    name: runtime.config.name,
    title: runtime.config.title,
    avatar: runtime.config.avatar,
    online: runtime.online,
    active: Date.now() - Date.parse(runtime.lastActive) < ACTIVE_WINDOW_MS,
    lastActive: runtime.lastActive,
    queued: runtime.queuedCount,
  });

  const emitRoster = (): void => {
    emit({
      type: "roster",
      bots: [...runtimes.values()].map(presence),
      counts: {
        total: runtimes.size,
        active: [...runtimes.values()].filter(
          (runtime) => presence(runtime).active
        ).length,
      },
    });
  };

  const touch = (runtime: BotRuntime): void => {
    runtime.lastActive = new Date().toISOString();
  };

  const appendTranscript = (
    runtime: BotRuntime,
    entry: TranscriptEntry
  ): void => {
    runtime.transcript.push(entry);
    if (runtime.transcript.length > 500)
      runtime.transcript.splice(0, runtime.transcript.length - 500);
    transcripts.append(runtime.config.name, entry);
    emit({ type: "append", bot: runtime.config.name, entry });
  };

  /** Answer a pending UI question in the child and record the resolution. */
  const resolveUi = (
    runtime: BotRuntime,
    view: UiRequestView,
    answer: UiAnswer,
    auto: boolean
  ): void => {
    try {
      runtime.session?.respondUi(view.id, answer);
    } catch {
      // Child died before the answer landed; still record the resolution.
    }
    const value = describeUiAnswer(view.method, answer);
    appendTranscript(runtime, {
      id: randomUUID(),
      role: "system",
      origin: "system",
      text: `${view.title} — ${value}${auto ? " (auto)" : ""}`,
      ts: new Date().toISOString(),
      uiResolved: { id: view.id, value, auto },
    });
  };

  /** How long a console question waits for the operator before auto-answering. */
  const UI_AUTO_ANSWER_MS = 120_000;

  interface RoutineRuntime {
    bot: string;
    name: string;
    schedule: string;
    prompt: string;
    enabled: boolean;
  }
  const routines: RoutineRuntime[] = [];
  for (const bot of fleet.bots) {
    for (const routine of bot.routines) {
      const key = `${bot.name}:${routine.name}`;
      routines.push({
        bot: bot.name,
        name: routine.name,
        schedule: routine.schedule,
        prompt: routine.prompt,
        enabled: routineState.routines?.[key]?.enabled ?? true,
      });
    }
  }
  for (const warning of routineBootWarnings(routines)) log(warning);

  const firedKeys = new Set<string>();
  const fireRoutine = (routine: RoutineRuntime, manual: boolean): boolean => {
    const runtime = runtimes.get(routine.bot);
    if (!runtime?.session || !runtime.session.alive) return false;
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      origin: "routine",
      originFrom: routine.name,
      text: stripActionMarkers(routine.prompt),
      ts: new Date().toISOString(),
    };
    const busy = runtime.session.streaming;
    if (busy) {
      // Queued behind the in-flight turn; turn_start decrements.
      journalPending(runtime, entry, undefined);
      runtime.queuedCount++;
      emitRoster();
    }
    appendTranscript(runtime, entry);
    void runtime.session
      .prompt(
        `[routine ${routine.name}] ${routine.prompt}`,
        busy ? "followUp" : undefined
      )
      .catch(() => {});
    touch(runtime);
    return true;
  };
  const schedulerTimer = setInterval(() => {
    runSchedulerTick(new Date(), { routines, firedKeys, fireRoutine, journal });
  }, 15_000);
  schedulerTimer.unref?.();

  const personaWatchers = new Map<string, import("node:fs").FSWatcher>();
  const watchPersona = (runtime: BotRuntime): void => {
    if (personaWatchers.has(runtime.config.name)) return;
    try {
      let timer: NodeJS.Timeout | null = null;
      const watcher = watch(join(runtime.config.dir, "AGENTS.md"), () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const session = runtime.session;
          if (!session || !session.alive) return;
          const send = session.streaming
            ? session.followUp("/bots-reload")
            : session.prompt("/bots-reload");
          void send
            .then(() =>
              log(`[${runtime.config.name}] persona reloaded in place`)
            )
            .catch(() =>
              log(
                `[${runtime.config.name}] persona reload failed [reason: runtime_offline]`
              )
            );
        }, 500);
      });
      watcher.on("error", () => watcher.close());
      personaWatchers.set(runtime.config.name, watcher);
    } catch {
      /* watcher is best-effort; /bots-reload stays available manually */
    }
  };

  const spawnBot = async (name: string): Promise<void> => {
    const runtime = runtimes.get(name);
    if (!runtime) return;
    // A respawn drops any queue the dead child was holding.
    runtime.queuedCount = 0;
    const sessionDir = join(fleet.dir, ".fleet", "sessions", name);
    mkdirSync(sessionDir, { recursive: true });
    const hasSession =
      existsSync(sessionDir) &&
      readdirSync(sessionDir).some((file) => file.endsWith(".jsonl"));
    const session = RpcSession.spawn({
      name,
      piBin,
      cwd: runtime.config.dir,
      sessionDir,
      resume: hasSession,
      model: runtime.config.model,
      approve: runtime.config.approve,
      bridgePath,
      daemonUrl,
      childSecret,
      onEvent: (event) => {
        // Reconcile respawns can supersede a session mid-flight — events from
        // a superseded child are stale and must not touch the runtime.
        if (runtime.session !== session) return;
        handleEvent(runtime, event);
      },
      onExit: (code, signal) => {
        if (runtime.session !== session) return;
        handleExit(runtime, code, signal);
      },
      onLine: (line) => {
        if (line.includes('"message_update"')) return;
        log(`[${name}] ${line.length > 500 ? `${line.slice(0, 500)}…` : line}`);
      },
    });
    runtime.session = session;
    watchPersona(runtime);
    touch(runtime);
    emitRoster();
    try {
      await session.getState();
      const messages = (await session.getMessages()) as {
        data?: { messages?: any[] };
      };
      const history = Array.isArray(messages?.data?.messages)
        ? messages.data.messages
        : [];
      const mapped = history
        .map((message): TranscriptEntry | null => {
          const role =
            message.role === "assistant"
              ? "assistant"
              : message.role === "user"
                ? "user"
                : null;
          if (!role) return null;
          const raw =
            typeof message.content === "string"
              ? message.content
              : (message.content ?? [])
                  .filter((part: any) => part?.type === "text")
                  .map((part: any) => String(part.text ?? ""))
                  .join("");
          if (raw.trim().length === 0) return null;
          let origin: TranscriptEntry["origin"] =
            role === "assistant" ? "bot" : "operator";
          let originFrom: string | undefined =
            role === "assistant" ? name : undefined;
          let body = raw;
          if (role === "user") {
            const completion = raw.match(/^\[completion from 🤖 ([^\]]+)\]\n?/);
            if (completion) {
              origin = "bot";
              originFrom = completion[1];
              body = raw.slice(completion[0].length);
            }
          }
          return {
            id: randomUUID(),
            role,
            origin,
            ...(originFrom ? { originFrom } : {}),
            text: stripActionMarkers(body),
            ts: new Date(Number(message.timestamp) || Date.now()).toISOString(),
          };
        })
        .filter((entry): entry is TranscriptEntry => entry !== null);
      runtime.transcript = mergeTranscriptHistory(
        transcripts.load(name) as TranscriptEntry[],
        mapped
      ).slice(-50);
      const lastEntry = runtime.transcript.at(-1);
      // A trailing user message while the agent is still streaming is a turn in
      // flight, not an interrupted one — resuming over it double-prompts.
      if (lastEntry && lastEntry.role === "user" && !session.streaming) {
        journal({ bot: name, status: "resumed-interrupted-turn" });
        void session
          .prompt(
            "[fleet runtime] Your previous turn was interrupted by a restart before you could respond. " +
              "Respond now to the latest message above — same style, terse."
          )
          .catch(() =>
            log(
              `[${name}] interrupted-turn resume failed [reason: runtime_offline]`
            )
          );
      }
      log(
        `[${name}] online (session ${hasSession ? "resumed" : "new"}, ${runtime.transcript.length} prior entries)`
      );
      // Issue 34: replay journalled pending messages, exactly once, in order.
      const pendingMsgs = pendingStore.load(name);
      for (const message of pendingMsgs) {
        const target = runtime.transcript.find(
          (candidate) => candidate.id === message.id
        );
        try {
          await session.prompt(message.text, undefined, message.images);
          pendingStore.remove(name, message.id);
          if (target) target.delivering = false;
          log(`[${name}] replayed pending message (id ${message.id})`);
        } catch {
          // Keep it journalled; the next spawn retries.
          log(`[${name}] pending replay deferred (id ${message.id})`);
        }
      }
    } catch (error) {
      log(
        `[${name}] booted but state probe failed: ${(error as Error).message}`
      );
    }
    // Truthful presence: online only once the boot probe completes — a bot that
    // is "online" but still booting invites prompts into a mid-boot agent.
    runtime.online = session.alive;
    emitRoster();
  };

  const handleEvent = (runtime: BotRuntime, event: RpcEvent): void => {
    touch(runtime);
    const botName = runtime.config.name;
    switch (event.kind) {
      case "turn_start": {
        // A queued follow-up turn starts with turn_start, not agent_start —
        // the oldest queued message is now streaming: mark it delivered.
        if (runtime.queuedCount > 0) {
          runtime.queuedCount--;
          const head = pendingStore.load(botName)[0];
          if (head) {
            pendingStore.remove(botName, head.id);
            const delivered = runtime.transcript.find(
              (candidate) => candidate.id === head.id
            );
            if (delivered) {
              delivered.delivering = false;
              emit({ type: "append", bot: botName, entry: delivered });
            }
          }
          emitRoster();
        }
        return;
      }
      case "agent_start": {
        runtime.turnId = randomUUID();
        runtime.turnText = "";
        runtime.steps = [];
        runtime.turnParts = new TurnPartsAccumulator();
        runtime.deltaSent = null;
        emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "working",
          steps: [],
        });
        return;
      }
      case "tool_start": {
        runtime.turnParts.startTool({
          toolCallId: event.toolCallId,
          tool: event.toolName,
          label: event.label,
          reason: event.reason,
        });
        runtime.steps.push({
          toolCallId: event.toolCallId,
          name: event.toolName,
          reason: event.reason,
          ...(event.label ? { label: event.label } : {}),
          started: Date.now(),
        });
        emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "parts",
          parts: runtime.turnParts.snapshot(),
        });
        if (activeToolOutput !== "off") {
          emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "steps",
            steps: viewSteps(runtime.steps),
          });
        }
        return;
      }
      case "tool_output": {
        runtime.turnParts.updateToolOutput(event.toolCallId, event.text);
        const step = [...runtime.steps]
          .reverse()
          .find((candidate) => candidate.toolCallId === event.toolCallId);
        if (step) step.output = event.text.slice(0, 1200);
        if (activeToolOutput === "full") {
          emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "steps",
            steps: viewSteps(runtime.steps),
          });
        }
        return;
      }
      case "tool_result": {
        const step = [...runtime.steps]
          .reverse()
          .find((candidate) => candidate.toolCallId === event.toolCallId);
        const duration = step ? Date.now() - step.started : undefined;
        runtime.turnParts.settleTool(event.toolCallId, {
          isError: event.isError,
          duration,
          output: event.text,
        });
        if (step) {
          step.output = event.text.slice(0, 1200);
          step.error = event.isError;
        }
        if (toolOutput === "full") {
          emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "steps",
            steps: viewSteps(runtime.steps),
          });
        }
        return;
      }
      case "assistant_delta": {
        runtime.turnText += event.delta;
        runtime.turnParts.appendText(event.delta);
        const text = stripActionMarkers(runtime.turnText);
        // Throttle: emit at most every ~300ms or ~256 bytes of growth. Frames
        // are cumulative, so dropped frames lose nothing; the settle path
        // always emits the final text.
        const now = Date.now();
        const last = runtime.deltaSent;
        if (deltaThrottleDue(last, text.length, now)) {
          runtime.deltaSent = { at: now, chars: text.length };
          emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "delta",
            // Server-side marker stripping: any WS client gets clean streaming
            // text. A marker line still open mid-stream becomes visible only
            // until its closing ]] arrives — the grammar is line-based.
            text,
          });
          emit({
            type: "bubble",
            bot: botName,
            turnId: runtime.turnId,
            phase: "parts",
            parts: runtime.turnParts.snapshot(),
          });
        }
        return;
      }
      case "assistant_message": {
        runtime.turnText = event.text;
        // Message boundary: force an emit so paragraph completions land promptly.
        runtime.deltaSent = {
          at: Date.now(),
          chars: stripActionMarkers(runtime.turnText).length,
        };
        emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "delta",
          text: stripActionMarkers(runtime.turnText),
        });
        emit({
          type: "bubble",
          bot: botName,
          turnId: runtime.turnId,
          phase: "parts",
          parts: runtime.turnParts.snapshot(),
        });
        return;
      }
      case "agent_settled": {
        const turnId = runtime.turnId;
        runtime.turnId = null;
        const text = stripActionMarkers(runtime.turnText);
        const entry: TranscriptEntry = {
          id: randomUUID(),
          role: "assistant",
          origin: "bot",
          originFrom: botName,
          text,
          ts: new Date().toISOString(),
          // Marker stripping applies to parts too: settled history never
          // carries [[action:]] lines in any surface.
          parts: runtime.turnParts.snapshot().map((part) => {
            if (part.type === "text")
              return { ...part, text: stripActionMarkers(part.text) };
            // Issue 49: "running" clears at settle — a turn cannot end
            // while a tool result is still owed.
            if (part.status === "running") part.status = "error";
            return part;
          }),
          ...(runtime.steps.length > 0
            ? {
                steps: runtime.steps.map((step) => ({
                  name: step.name,
                  duration: step.duration,
                })),
              }
            : {}),
        };
        appendTranscript(runtime, entry);
        if (turnId)
          emit({
            type: "bubble",
            bot: botName,
            turnId,
            phase: "final",
            text,
          });
        const pendingSources = runtime.pendingFrom;
        runtime.pendingFrom = [];
        for (const pendingFrom of pendingSources) {
          const source = runtimes.get(pendingFrom);
          if (!source?.session?.alive) continue;
          const notification = completionNotification(botName, text);
          // Idle source: prompt (follow_up on an idle agent never flushes). Busy: queue.
          // Retry once — a transient failure gets exactly one second chance.
          const send = source.session.streaming
            ? source.session.followUp(notification)
            : source.session.prompt(notification);
          void send
            .catch(() =>
              source.session?.alive
                ? source.session
                    .prompt(notification)
                    .catch(() =>
                      log(
                        `[${pendingFrom}] completion from ${botName} dropped [reason: runtime_offline]`
                      )
                    )
                : undefined
            )
            .finally(() => {
              appendTranscript(source, {
                id: randomUUID(),
                role: "assistant",
                origin: "bot",
                originFrom: botName,
                kind: "completion",
                text,
                ts: new Date().toISOString(),
              });
              touch(source);
            });
        }
        return;
      }
      case "ui_request": {
        if (!event.id) return;
        if (isFireAndForgetUiMethod(event.method)) return;
        if (!isInteractiveUiMethod(event.method)) {
          // Unknown method: defuse it immediately so a future interactive UI
          // request can never wedge a turn. The child ignores unmatched
          // responses, so a cancelled answer is safe for any method.
          resolveUi(
            runtime,
            { id: event.id, method: event.method, title: event.title },
            { cancel: true },
            true
          );
          return;
        }
        if (runtime.pendingUi.has(event.id)) return;
        const view: UiRequestView = {
          id: event.id,
          method: event.method,
          title: event.title,
          ...(event.options ? { options: event.options } : {}),
          ...(event.message ? { message: event.message } : {}),
          ...(event.placeholder ? { placeholder: event.placeholder } : {}),
        };
        appendTranscript(runtime, {
          id: randomUUID(),
          role: "system",
          origin: "system",
          text: view.message ? `${view.title} — ${view.message}` : view.title,
          ts: new Date().toISOString(),
          ui: view,
        });
        const timer = setTimeout(() => {
          if (!runtime.pendingUi.delete(view.id)) return;
          resolveUi(
            runtime,
            view,
            autoUiAnswer(view.method, view.options),
            true
          );
        }, UI_AUTO_ANSWER_MS);
        runtime.pendingUi.set(view.id, { view, timer });
        return;
      }
      default:
        return;
    }
  };

  const handleExit = (
    runtime: BotRuntime,
    code: number | null,
    signal: string | null
  ): void => {
    runtime.online = false;
    runtime.session = null;
    runtime.turnId = null;
    // Child death drops the queue.
    runtime.queuedCount = 0;
    for (const { timer } of runtime.pendingUi.values()) clearTimeout(timer);
    runtime.pendingUi.clear();
    const droppedSources = runtime.pendingFrom;
    runtime.pendingFrom = [];
    if (runtime.turnId) {
      appendTranscript(runtime, {
        id: randomUUID(),
        role: "system",
        origin: "system",
        text: "Turn interrupted by a restart — resend if it was mid-flight.",
        ts: new Date().toISOString(),
      });
      runtime.turnId = null;
    }
    for (const droppedFrom of droppedSources) {
      const source = runtimes.get(droppedFrom);
      if (source?.session?.alive) {
        void source.session
          .prompt(
            `[completion from 🤖 ${runtime.config.name} (@${runtime.config.name})] target went offline mid-task [reason: runtime_offline]`
          )
          .catch(() => {});
      }
    }
    emitRoster();
    log(`[${runtime.config.name}] exited (code=${code} signal=${signal})`);
    if (runtime.stopping) return;
    const now = Date.now();
    runtime.restartTimes = runtime.restartTimes.filter(
      (time) => now - time < RESTART_WINDOW_MS
    );
    runtime.restartTimes.push(now);
    if (runtime.restartTimes.length > MAX_RESTARTS_PER_WINDOW) {
      log(
        `[${runtime.config.name}] restart budget exhausted; bot offline [reason: runtime_offline]`
      );
      const waitingSources = runtime.pendingFrom;
      runtime.pendingFrom = [];
      for (const waitingFrom of waitingSources) {
        const source = runtimes.get(waitingFrom);
        source?.session?.alive &&
          void source.session
            .followUp(
              `[completion from 🤖 ${runtime.config.name} (@${runtime.config.name})] target offline [reason: runtime_offline]`
            )
            .catch(() => {});
      }
      return;
    }
    setTimeout(() => {
      if (!runtime.stopping) void spawnBot(runtime.config.name);
    }, 1_000);
  };

  /** Journal a queued follow-up so a restart can replay it (issue 34). */
  const journalPending = (
    runtime: BotRuntime,
    entry: TranscriptEntry,
    images?: { type: "image"; data: string; mimeType: string }[]
  ): void => {
    entry.delivering = true;
    pendingStore.append(runtime.config.name, {
      id: entry.id,
      text: entry.text,
      origin: entry.origin,
      ...(entry.originFrom ? { originFrom: entry.originFrom } : {}),
      ...(images ? { images } : {}),
      ts: entry.ts,
    });
  };

  const deliver = async (
    runtime: BotRuntime,
    text: string,
    entry: TranscriptEntry,
    behavior?: "followUp",
    images?: { type: "image"; data: string; mimeType: string }[]
  ): Promise<void> => {
    appendTranscript(runtime, entry);
    const session = runtime.session;
    if (!session || !session.alive) throw new Error("runtime_offline");
    // Issue 50: a streaming child queues the message behind its turn —
    // never bounced as runtime_offline (that is reserved for dead sessions).
    if (session.streaming && behavior === undefined) {
      await session.followUp(text, images);
      journalPending(runtime, entry, images);
      runtime.queuedCount++;
      emit({ type: "append", bot: runtime.config.name, entry });
      emitRoster();
      return;
    }
    try {
      await session.prompt(text, behavior, images);
      entry.delivering = false;
      emit({ type: "append", bot: runtime.config.name, entry });
    } catch (error) {
      // Fresh-bot boot race: the agent can reject plain prompts while its first
      // turn is still settling. One followUp queues behind it; genuine failures
      // (offline, provider errors) still throw to the caller.
      if (
        behavior === undefined &&
        session.alive &&
        classifyFailure(String(error)) === "turn_in_flight"
      ) {
        await session.followUp(text, images);
        // Queued behind the in-flight turn; turn_start decrements + pops the
        // pending journal (issue 34). Stays delivering until its turn streams.
        journalPending(runtime, entry, images);
        emit({ type: "append", bot: runtime.config.name, entry });
        runtime.queuedCount++;
        emitRoster();
        return;
      }
      throw error;
    }
  };

  const deliverHandoff = async (
    fromName: string,
    targetName: string,
    message: string,
    behavior?: "steer" | "followUp"
  ) => {
    const route = checkRoute(fromName, targetName, fleet.bots);
    if (!route.ok)
      return { status: 404, body: { delivered: false, reason: route.reason } };
    const runtime = runtimes.get(targetName);
    if (!runtime)
      return {
        status: 404,
        body: { delivered: false, reason: "unknown_target" },
      };
    const text = [
      attributionPrefix(fromName),
      message.trim(),
      `(Your final response will be delivered back to @${fromName} as a completion notification.)`,
    ].join("\n");
    const entry: TranscriptEntry = {
      id: randomUUID(),
      role: "user",
      origin: "bot",
      originFrom: fromName,
      kind: "handoff",
      text: stripActionMarkers(message.trim()),
      ts: new Date().toISOString(),
    };
    const attempt = async (): Promise<void> => {
      if (!runtime.session || !runtime.session.alive)
        throw new Error("runtime_offline");
      const busy = runtime.session.streaming;
      if (!busy) {
        // Idle target: every behavior degrades to a normal message — steer is
        // only meaningful mid-turn, and an idle-agent follow_up never flushes.
        await runtime.session.prompt(text);
        return;
      }
      if (behavior === "steer") {
        await runtime.session.steer(text);
        return;
      }
      // Queued behind the in-flight turn; turn_start decrements + pops the
      // pending journal (issue 34).
      journalPending(runtime, entry, undefined);
      runtime.queuedCount++;
      emitRoster();
      await runtime.session.prompt(text, behavior ?? "followUp");
    };

    // Transient unavailability: one emergency respawn so the retry can actually help.
    if (!runtime.session || !runtime.session.alive) {
      await spawnBot(targetName).catch(() => undefined);
    }

    runtime.pendingFrom = [...new Set([...runtime.pendingFrom, fromName])];
    appendTranscript(runtime, entry);
    touch(runtime);
    try {
      await attempt();
    } catch (firstError) {
      const reason = classifyFailure(String(firstError));
      runtime.pendingFrom = runtime.pendingFrom.filter(
        (source) => source !== fromName
      );
      if (!isRetryable(reason)) {
        return { status: 503, body: { delivered: false, reason } };
      }
      // Retryable: one emergency respawn, exactly one retry.
      await spawnBot(targetName).catch(() => undefined);
      runtime.pendingFrom = [...new Set([...runtime.pendingFrom, fromName])];
      try {
        await attempt();
      } catch (secondError) {
        const retryReason = classifyFailure(String(secondError));
        runtime.pendingFrom = runtime.pendingFrom.filter(
          (source) => source !== fromName
        );
        return { status: 503, body: { delivered: false, reason: retryReason } };
      }
    }
    return { status: 200, body: { delivered: true } };
  };

  let activeToolOutput = toolOutput;
  const server = buildHttpServer({
    fleet,
    fleetName: options.fleetName,
    runtimes,
    routines,
    token,
    childSecret,
    toolOutput,
    log,
    onRoster: emitRoster,
    onToolOutput: (mode) => {
      activeToolOutput = mode;
      persistToolOutput(mode);
      emit({ type: "config", toolOutput: mode });
    },
    persistToolOutput: (mode) => {
      persistToolOutputRef(mode);
    },
    handlers: {
      toggleRoutine(botName: string, routineName: string) {
        const routine = routines.find(
          (r) => r.bot === botName && r.name === routineName
        );
        if (!routine)
          return { status: 404, body: { error: "unknown routine" } };
        routine.enabled = !routine.enabled;
        const key = `${botName}:${routineName}`;
        routineState.routines = {
          ...(routineState.routines ?? {}),
          [key]: { enabled: routine.enabled },
        };
        persistRoutineState();
        journal({
          key,
          bot: botName,
          routine: routineName,
          status: routine.enabled ? "enabled" : "disabled",
        });
        return { status: 200, body: { enabled: routine.enabled } };
      },
      runRoutine(botName: string, routineName: string) {
        const routine = routines.find(
          (r) => r.bot === botName && r.name === routineName
        );
        if (!routine)
          return { status: 404, body: { error: "unknown routine" } };
        const fired = fireRoutine(routine, true);
        journal({
          key: `${botName}:${routineName}`,
          bot: botName,
          routine: routineName,
          status: fired ? "manual-run" : "skipped",
          reason: fired ? undefined : "runtime_offline",
        });
        return fired
          ? { status: 200, body: { accepted: true } }
          : { status: 503, body: { error: "runtime_offline" } };
      },
      answerUi(name, uiId, body) {
        const runtime = runtimes.get(name);
        if (!runtime) return { status: 404, body: { error: "unknown bot" } };
        const pending = runtime.pendingUi.get(uiId);
        if (!pending)
          return { status: 404, body: { error: "no such question" } };
        if (!runtime.session || !runtime.session.alive)
          return { status: 503, body: { error: "runtime_offline" } };
        const answer: UiAnswer =
          body.cancel === true
            ? { cancel: true }
            : body.confirmed !== undefined
              ? { confirmed: body.confirmed === true }
              : typeof body.value === "string"
                ? { value: body.value }
                : {};
        if (Object.keys(answer).length === 0)
          return {
            status: 400,
            body: { error: "value, confirmed, or cancel required" },
          };
        clearTimeout(pending.timer);
        runtime.pendingUi.delete(uiId);
        resolveUi(runtime, pending.view, answer, false);
        return { status: 200, body: { accepted: true } };
      },
      message: async (name, text, images, clientMessageId) => {
        const runtime = runtimes.get(name);
        if (!runtime) return { status: 404, body: { error: "unknown bot" } };
        if (clientMessageId !== undefined) {
          if (!claimClientMessageId(runtime.clientMessageIds, clientMessageId))
            return { status: 409, body: { error: "duplicate" } };
        }
        const entry: TranscriptEntry = {
          id: clientMessageId ?? randomUUID(),
          role: "user",
          origin: "operator",
          delivering: true,
          text: stripActionMarkers(text),
          ts: new Date().toISOString(),
        };
        try {
          await deliver(runtime, text, entry, undefined, images);
          return { status: 200, body: { accepted: true } };
        } catch (error) {
          const reason = classifyFailure(String(error));
          if (reason === "runtime_offline") {
            // Issue 33 item 3: offline sends queue for delivery on next spawn
            // instead of hard-failing — never a silent drop.
            journalPending(runtime, entry, images);
            emit({ type: "append", bot: name, entry });
            return { status: 202, body: { accepted: true, queued: true } };
          }
          if (reason === "turn_in_flight") {
            // Issue 50: busy is never runtime_offline — reject distinctly and
            // visibly (the entry is marked failed, not half-delivered).
            entry.delivering = false;
            entry.deliveryError = "turn_in_flight";
            emit({ type: "append", bot: name, entry });
            return { status: 409, body: { error: "turn_in_flight" } };
          }
          entry.delivering = false;
          entry.deliveryError = reason;
          emit({ type: "append", bot: name, entry });
          return { status: 503, body: { error: reason } };
        }
      },
      steer: async (name, text) => {
        const runtime = runtimes.get(name);
        if (!runtime?.session || !runtime.session.alive)
          return { status: 503, body: { error: "runtime_offline" } };
        await runtime.session.steer(text);
        touch(runtime);
        return { status: 200, body: { accepted: true } };
      },
      compact: async (name) => {
        const runtime = runtimes.get(name);
        if (!runtime) return { status: 404, body: { error: "unknown bot" } };
        if (!runtime.session || !runtime.session.alive)
          return { status: 503, body: { error: "runtime_offline" } };
        if (runtime.session.streaming)
          return { status: 409, body: { error: "turn_in_flight" } };
        let note =
          "Reset rerouted to compaction — fresh working context, same conversation.";
        try {
          await runtime.session.request({ type: "compact" });
        } catch {
          note =
            "Nothing to compact yet — context is below the threshold, so the session stays as-is.";
        }
        appendTranscript(runtime, {
          id: randomUUID(),
          role: "system",
          origin: "system",
          text: note,
          ts: new Date().toISOString(),
        });
        return { status: 200, body: { accepted: true, rerouted: "compact" } };
      },
      busSend: async (fromName, targetName, message, behavior) =>
        deliverHandoff(fromName, targetName, message, behavior),
    },
  });

  const httpServer = serve({
    fetch: server.fetch,
    port: fleet.port,
    hostname: fleet.host,
  });
  const keepalive = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.ping();
    }
  }, 30_000);
  keepalive.unref?.();

  httpServer.on("error", (error: Error) => {
    const message =
      (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `port ${fleet.port} is already in use — ${describePortHolder(fleet.port) || "stop the other listener"}; or pass --port`
        : error.message;
    log(`fatal: ${message}`);
    process.exit(3);
  });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }
    if (!wsUpgradeAuthorized(request, url, token)) {
      writeWsAuthFailure(socket);
      return;
    }
    wss.handleUpgrade(request, socket, head, (socket_) => {
      sockets.add(socket_);
      socket_.on("close", () => sockets.delete(socket_));
      const since = Number(url.searchParams.get("since") ?? "0");
      socket_.send(
        JSON.stringify({
          type: "hello",
          fleet: fleet.dir,
          bootId,
          seq: eventLog.current,
        })
      );
      for (const missed of eventLog.since(Number.isFinite(since) ? since : 0)) {
        socket_.send(JSON.stringify(missed.payload));
      }
      socket_.send(
        JSON.stringify({
          type: "roster",
          bots: [...runtimes.values()].map(presence),
          counts: { total: runtimes.size, active: 0 },
        })
      );
    });
  });

  // ── Hot bot onboarding (issue 27): watch bots.toml and reconcile live. ──
  let manifestWatcher: import("node:fs").FSWatcher | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;

  const closeBotRuntime = (name: string): void => {
    const runtime = runtimes.get(name);
    if (!runtime) return;
    runtime.stopping = true; // handleExit must not respawn a removed bot.
    personaWatchers.get(name)?.close();
    personaWatchers.delete(name);
    runtime.session?.stop();
    runtimes.delete(name);
    // Issue 34: a removed bot's pending journal goes with the runtime.
    pendingStore.drop(name);
  };

  const reconcileFleet = async (next: FleetConfig): Promise<void> => {
    const diff = diffFleet(fleet.bots, next.bots);
    for (const bot of diff.removed) {
      closeBotRuntime(bot.name);
      log(`[fleet] bot "${bot.name}" removed — transcript journal kept`);
    }
    for (const bot of diff.added) {
      runtimes.set(bot.name, makeRuntime(bot));
      log(`[fleet] bot "${bot.name}" added`);
      void spawnBot(bot.name);
    }
    for (const bot of diff.changed) {
      const runtime = runtimes.get(bot.name);
      if (!runtime) continue;
      runtime.stopping = true;
      personaWatchers.get(bot.name)?.close();
      personaWatchers.delete(bot.name);
      runtime.session?.stop();
      runtime.config = bot;
      runtime.stopping = false;
      runtime.restartTimes = [];
      log(
        `[fleet] bot "${bot.name}" reconfigured — respawning (session dir kept)`
      );
      void spawnBot(bot.name);
    }
    for (const bot of diff.untouched) {
      const runtime = runtimes.get(bot.name);
      if (runtime) runtime.config = bot; // title/avatar copy updates live.
    }
    fleet = next;
    if (diff.added.length > 0 || diff.removed.length > 0)
      routines.splice(
        0,
        routines.length,
        ...next.bots.flatMap((bot) =>
          bot.routines.map((routine) => ({
            bot: bot.name,
            name: routine.name,
            schedule: routine.schedule,
            prompt: routine.prompt,
            enabled:
              routineState.routines?.[`${bot.name}:${routine.name}`]?.enabled ??
              true,
          }))
        )
      );
    emitRoster();
  };

  const reconcileFromDisk = async (): Promise<void> => {
    let next: FleetConfig;
    try {
      next = loadFleetConfig(fleet.dir, fleetOverrides);
    } catch (error) {
      // A bad edit must never kill a running fleet.
      const message = (error as Error).message;
      log(`config error: ${message} — keeping the running fleet`);
      emit({ type: "config-error", error: message });
      return;
    }
    if (next.port !== fleet.port || next.host !== fleet.host) {
      const message =
        "[fleet] table changed — port/host changes need a daemon restart";
      log(`config error: ${message}`);
      emit({ type: "config-error", error: message });
      return;
    }
    await reconcileFleet(next);
  };

  try {
    // Watch the fleet DIR (not the file): editors atomically replace
    // bots.toml, which kills file watches.
    manifestWatcher = watch(fleet.dir, (_event, filename) => {
      if (filename && filename !== "bots.toml") return;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void reconcileFromDisk();
      }, 300);
      reconcileTimer.unref?.();
    });
    manifestWatcher.on("error", () => {
      manifestWatcher?.close();
      manifestWatcher = null;
    });
  } catch {
    // Manifest watching is best-effort; restart-based onboarding still works.
  }

  return new Promise<FleetHandle>((resolvePromise) => {
    httpServer.addListener("listening", () => {
      // Port 0 = OS-assigned: report the bound port, not the request.
      const address = httpServer.address();
      const actualPort =
        typeof address === "object" && address !== null
          ? address.port
          : fleet.port;
      const url = `http://${fleet.host === "0.0.0.0" ? "127.0.0.1" : fleet.host}:${actualPort}`;
      log(
        `fleet ${fleet.dir} serving on ${url}${token ? " (token required)" : ""}`
      );
      for (const bot of fleet.bots) void spawnBot(bot.name);
      resolvePromise({
        url,
        port: actualPort,
        token,
        fleetDir: fleet.dir,
        stop: async () => {
          manifestWatcher?.close();
          if (reconcileTimer) clearTimeout(reconcileTimer);
          schedulerTimer.unref?.();
          clearInterval(schedulerTimer);
          for (const watcher of personaWatchers.values()) watcher.close();
          for (const runtime of runtimes.values()) {
            runtime.stopping = true;
            runtime.session?.stop();
          }
          lockResult.lock.release();
          for (const socket of sockets) socket.close();
          await new Promise<void>((resolveStop) =>
            httpServer.close(() => resolveStop())
          );
        },
      });
    });
  });
}

// Local type alias keeps handleEvent usable before RpcEvent is exported below.
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
  toolOutput: ToolOutputMode;
  token?: string;
  childSecret: string;
  log: (line: string) => void;
  handlers: {
    message(
      name: string,
      text: string,
      images?: { type: "image"; data: string; mimeType: string }[],
      clientMessageId?: string
    ): Promise<{ status: number; body: unknown }>;
    compact(name: string): Promise<{ status: number; body: unknown }>;
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
      behavior?: "steer" | "followUp"
    ): Promise<{ status: number; body: unknown }>;
  };
}

function buildHttpServer(deps: ServerDeps): Hono {
  const app = new Hono();
  const authorized = (url: URL, request: Request): boolean =>
    !deps.token ||
    url.searchParams.get("token") === deps.token ||
    (request.headers.get("authorization") ?? "") === `Bearer ${deps.token}`;

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
    // Public assets carry no fleet data; browsers fetch them without the document's query token.
    if (
      url.pathname === "/app.js" ||
      url.pathname === "/style.css" ||
      url.pathname === "/md.js" ||
      url.pathname === "/parts.js"
    ) {
      await next();
      return;
    }
    if (!authorized(url, context.req.raw)) {
      if (url.pathname.startsWith("/api/") || url.pathname === "/api/ws") {
        return context.json({ error: "unauthorized" }, 401);
      }
      return context.html(tokenPage, 401);
    }
    await next();
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
  app.get("/style.css", serveAsset("style.css", "text/css"));

  app.get("/api/fleet", (context) => {
    const bots = [...deps.runtimes.values()].map((runtime) => ({
      name: runtime.config.name,
      title: runtime.config.title,
      avatar: runtime.config.avatar,
      online: runtime.online,
      active: Date.now() - Date.parse(runtime.lastActive) < ACTIVE_WINDOW_MS,
      lastActive: runtime.lastActive,
      queued: runtime.queuedCount,
      latest: runtime.transcript.at(-1)?.text ?? "",
    }));
    return context.json({ dir: deps.fleet.dir, bots });
  });

  app.get("/api/version", (context) => {
    return context.json({
      ...versionPayload(),
      fleetName: deps.fleetName,
      fleetDir: deps.fleet.dir,
    });
  });

  app.get("/api/settings", (context) => {
    return context.json({ toolOutput: deps.toolOutput });
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
    const page = paginateTranscript(runtime.transcript, {
      before: context.req.query("before"),
      limit: context.req.query("limit"),
    });
    if (!page.ok) return context.json({ error: page.error }, 400);
    return context.json({ transcript: page.entries });
  });

  app.post("/api/bots/:name/message", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      text?: string;
      images?: unknown;
      clientMessageId?: unknown;
    };
    if (!body.text || body.text.trim().length === 0)
      return context.json({ error: "text required" }, 400);
    if (
      body.clientMessageId !== undefined &&
      typeof body.clientMessageId !== "string"
    )
      return context.json({ error: "clientMessageId must be a string" }, 400);
    const images = coerceMessageImages(body.images);
    if (!images.ok) {
      return context.json(
        {
          error:
            "images must be one { mediaType, data } object with non-empty strings",
        },
        400
      );
    }
    const result = await deps.handlers.message(
      context.req.param("name"),
      body.text.trim(),
      images.images,
      body.clientMessageId
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
    const result = await deps.handlers.busSend(
      body.from,
      body.target,
      body.message,
      behavior.behavior
    );
    return context.json(result.body, result.status as 200 | 404 | 503);
  });

  return app;
}
