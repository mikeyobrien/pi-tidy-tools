import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface RpcSpawnOptions {
  name: string;
  /** Executable to spawn (defaults to "pi"); tests use a stub. */
  piBin?: string;
  cwd: string;
  sessionDir: string;
  resume: boolean;
  model?: string;
  approve: boolean;
  /** Issue 92: trust the fleet-owned bot dir's project-local settings so
   * bot-scoped packages load (pi's --approve = project trust, not tool
   * auto-approve). */
  trustProject?: boolean;
  bridgePath: string;
  /** Issue 85: extra extensions loaded after bridge (MCP wrap etc.). */
  extensions?: string[];
  /** Issue 132: extra child env (image provider id, fleet dir for outputs). */
  env?: Record<string, string>;
  daemonUrl: string;
  childSecret: string;
  onEvent: (event: RpcEvent) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onLine?: (line: string) => void;
}

/**
 * Pure argv builder for the rpc child — exported for unit tests (issue 82:
 * rules ride --append-system-prompt only when present).
 */
export function rpcSpawnArgs(
  options: Pick<
    RpcSpawnOptions,
    | "name"
    | "sessionDir"
    | "resume"
    | "model"
    | "approve"
    | "trustProject"
    | "bridgePath"
    | "extensions"
  >
): string[] {
  return [
    "--mode",
    "rpc",
    "--name",
    options.name,
    "--session-dir",
    options.sessionDir,
    ...(options.resume ? ["--continue"] : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.approve ? ["--approve"] : []),
    ...(options.trustProject ? ["--approve"] : []),
    "-e",
    options.bridgePath,
    ...(options.extensions ?? []).flatMap((extension) => ["-e", extension]),
  ];
}

/** Issue 158: reasons bound to ~90 chars (first line + ellipsis). */
export const REASON_MAX_CHARS = 90;

/**
 * Issue 158: shared wire-bounding contract for step text. First line only
 * (multi-line JS bodies never ride the wire) + hard truncate with an
 * ellipsis. stepReason and stepLabel both route through this — the old
 * contracts were inconsistent (40 vs unbounded, and reason could carry
 * 3.4k-char mcpScript bodies).
 */
export function boundStepText(value: string, max: number): string {
  const firstLine = value.trim().split("\n")[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Compact, non-sensitive args digest for a tool step row (issue 36). */
export function stepLabel(toolName: string, args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0)
        return value.trim();
    }
    return undefined;
  };
  const truncate = boundStepText;
  if (toolName === "message_agent") {
    const target = first("target");
    return target ? `→ ${target}` : undefined;
  }
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    const path = first("file_path", "path", "notebook_path");
    if (path === undefined) return undefined;
    const base = path.split(/[\\/]/).pop();
    return base ? `✎ ${base}` : undefined;
  }
  if (toolName === "bash") {
    const command = first("command");
    return command ? truncate(command.replace(/\s+/g, " "), 60) : undefined;
  }
  const stringified = JSON.stringify(record);
  return stringified === undefined ? undefined : truncate(stringified, 40);
}

export type RpcEvent =
  | { kind: "agent_start" }
  | { kind: "turn_start" }
  | { kind: "agent_end" }
  | { kind: "agent_settled" }
  | { kind: "assistant_delta"; delta: string }
  | { kind: "assistant_message"; text: string }
  | {
      kind: "tool_start";
      toolCallId: string;
      toolName: string;
      reason: string;
      label?: string;
      /** Issue 128: message_agent dispatch target (receipt enrichment). */
      target?: string;
    }
  | { kind: "tool_output"; toolCallId: string; text: string }
  | {
      /** Issue 66: the settle event — pi's tool_execution_end carries the
       * result text, isError flag, and optional measured duration. */
      kind: "tool_end";
      toolCallId: string;
      result: string;
      isError: boolean;
      elapsedMs?: number;
    }
  | { kind: "usage"; inputTokens?: number; model?: string }
  | {
      kind: "ui_request";
      id: string;
      method: string;
      title: string;
      options?: string[];
      message?: string;
      placeholder?: string;
    }
  | { kind: "event"; raw: Record<string, unknown> };

/** Answer for an interactive extension UI request (select, confirm, input, editor). */
export interface UiAnswer {
  value?: string;
  confirmed?: boolean;
  cancel?: boolean;
}

const INTERACTIVE_UI_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
]);

/** Interactive UI requests block the child until an extension_ui_response arrives. */
export function isInteractiveUiMethod(method: string): boolean {
  return INTERACTIVE_UI_METHODS.has(method);
}

const FIRE_AND_FORGET_UI_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

/** Known UI methods the child emits without waiting for an answer. */
export function isFireAndForgetUiMethod(method: string): boolean {
  return FIRE_AND_FORGET_UI_METHODS.has(method);
}

/** Wire frame answering a pending extension UI request. */
export function uiResponseFrame(
  id: string,
  answer: UiAnswer
): Record<string, unknown> {
  if (answer.cancel === true)
    return { type: "extension_ui_response", id, cancelled: true };
  if (answer.confirmed !== undefined)
    return { type: "extension_ui_response", id, confirmed: answer.confirmed };
  return { type: "extension_ui_response", id, value: answer.value ?? "" };
}

/** Deterministic fallback so an unanswered question can never wedge a turn. */
export function autoUiAnswer(method: string, options?: string[]): UiAnswer {
  if (method === "select") return { value: options?.[0] ?? "" };
  if (method === "confirm") return { confirmed: true };
  if (method === "input") return { value: "" };
  return { cancel: true };
}

/** Human-readable resolution for transcripts and the console. */
export function describeUiAnswer(method: string, answer: UiAnswer): string {
  if (answer.cancel === true) return "cancelled";
  if (method === "confirm") return answer.confirmed ? "confirmed" : "declined";
  return answer.value ?? "";
}

/** Pick the human-readable "why" from a tool call's arguments. */
export function stepReason(args: unknown, toolName?: string): string {
  if (args === null || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  // Issue 128: dispatch-class tools — the reason is a BOUNDED gist of the
  // brief, never the full message (the label already carries the target).
  if (toolName === "message_agent" && typeof record.message === "string") {
    return boundStepText(record.message, 60);
  }
  const candidates = [
    "reasoning",
    "reason",
    "command",
    "path",
    "file_path",
    "url",
    "query",
    "pattern",
  ];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0)
      return boundStepText(value, REASON_MAX_CHARS);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim().length > 0)
      return boundStepText(value, REASON_MAX_CHARS);
  }
  return "";
}

const textOfMessage = (message: any): string => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("");
};

/**
 * Issue 66: tool results arrive as a string, a content-part array, or an
 * object with .text — normalize to display text without dropping output.
 */
const toolResultText = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .filter(
        (part: any) => part?.type === "text" || typeof part?.text === "string"
      )
      .map((part: any) => String(part.text ?? ""))
      .join("");
  }
  if (result && typeof result === "object") {
    const text = (result as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
};

/**
 * One perpetual `pi --mode rpc` child. Strict LF JSONL framing (no readline —
 * pi's rpc protocol forbids readers that split on U+2028/U+2029).
 */
/** Issue 149: prompt-class guard — 10 minutes. Accept-acks are <10ms; only
 * a wedged-alive child can hit this, and the timeout means UNKNOWN. */
export const PROMPT_CLASS_TIMEOUT_MS = 10 * 60_000;

export class RpcSession {
  readonly process: ChildProcess;
  private buffer = "";
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private closed = false;

  streaming = false;
  settled = true;
  /** Assistant text accumulated for the in-flight assistant message (live deltas). */
  liveAssistant = "";
  /** Assistant text of the most recently completed assistant message this turn. */
  lastAssistant = "";

  private readonly options: RpcSpawnOptions;

  private constructor(options: RpcSpawnOptions, process_: ChildProcess) {
    this.options = options;
    this.process = process_;
    this.process.stdout?.setEncoding("utf8");
    this.process.stdout?.on("data", (chunk: string) => this.ingest(chunk));
    this.process.stderr?.setEncoding("utf8");
    this.process.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length > 0) options.onLine?.(`[stderr] ${line}`);
      }
    });
    this.process.stdin?.on("error", () => {
      /* EPIPE when the child dies mid-write; death is handled by exit/error. */
    });
    this.process.on("exit", (code, signal) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("rpc child exited before responding"));
      }
      this.pending.clear();
      options.onExit(code, signal);
    });
    this.process.on("error", (error) => {
      // Spawn failure (e.g. pi missing from PATH) emits `error` without `exit`:
      // treat as death so alive() goes false and the respawn budget engages.
      options.onLine?.(`[spawn-error] ${error.message}`);
      if (!this.closed) {
        this.closed = true;
        for (const pending of this.pending.values()) {
          pending.reject(
            new Error(`rpc child failed to start: ${error.message}`)
          );
        }
        this.pending.clear();
        options.onExit(null, "spawn-error");
      }
    });
  }

  static spawn(options: RpcSpawnOptions): RpcSession {
    const args = rpcSpawnArgs(options);
    const child = spawn(options.piBin ?? "pi", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PI_TIDY_BOTS_CHILD: "1",
        PI_TIDY_BOTS_NAME: options.name,
        PI_TIDY_BOTS_DAEMON_URL: options.daemonUrl,
        PI_TIDY_BOTS_CHILD_SECRET: options.childSecret,
        ...(options.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new RpcSession(options, child);
  }

  /** Issue 148: the spawned child's pid (for the daemon's ledger). */
  get pid(): number | undefined {
    return this.process.pid;
  }

  get alive(): boolean {
    return (
      !this.closed &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    );
  }

  send(payload: Record<string, unknown>): void {
    if (!this.alive) throw new Error("rpc child is not running");
    this.process.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  request<T = any>(
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
    timeoutCode?: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.alive) {
        reject(new Error("rpc child is not running"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${timeoutCode ?? "rpc request timed out"} after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value: T) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ ...payload, id });
    });
  }

  /**
   * Issue 149: prompt-class requests follow the ACCEPT-ACK contract — real
   * pi resolves the request when the turn is accepted (<10ms measured), not
   * when it finishes. The old shared 30s timeout misclassified long turns
   * as delivery_failed while the reply still landed (phantom completion).
   * The guard stays long — genuinely dead sessions are rejected by the
   * exit handler immediately; only a wedged-but-alive child can hit this.
   */
  async prompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
    images?: { type: "image"; data: string; mimeType: string }[]
  ): Promise<void> {
    await this.request(
      {
        type: "prompt",
        message,
        ...(streamingBehavior ? { streamingBehavior } : {}),
        ...(images ? { images } : {}),
      },
      PROMPT_CLASS_TIMEOUT_MS,
      "rpc_prompt_timeout"
    );
  }

  async steer(message: string): Promise<void> {
    await this.request({ type: "steer", message });
  }

  async followUp(
    message: string,
    images?: { type: "image"; data: string; mimeType: string }[]
  ): Promise<void> {
    await this.request(
      {
        type: "follow_up",
        message,
        ...(images ? { images } : {}),
      },
      PROMPT_CLASS_TIMEOUT_MS,
      "rpc_prompt_timeout"
    );
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async getState<T = any>(): Promise<T> {
    return this.request<T>({ type: "get_state" });
  }

  async getMessages<T = any>(): Promise<T> {
    return this.request<T>({ type: "get_messages" });
  }

  stop(): void {
    if (this.alive) {
      this.process.stdin?.end();
      this.process.kill("SIGTERM");
    }
  }

  /** Answer a pending extension UI request; throws if the child is gone. */
  respondUi(id: string, answer: UiAnswer): void {
    this.send(uiResponseFrame(id, answer));
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    this.options.onLine?.(line);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(parsed.type ?? "");

    if (type === "response") {
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      if (id) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          if (parsed.success === false) {
            pending.reject(new Error(`rpc command failed: ${line}`));
          } else {
            pending.resolve(parsed);
          }
        }
      }
      return;
    }

    switch (type) {
      case "agent_start":
        this.streaming = true;
        this.settled = false;
        this.lastAssistant = "";
        this.liveAssistant = "";
        this.options.onEvent({ kind: "agent_start" });
        return;
      case "turn_start":
        // Each turn inside the agent cycle — including queued follow-ups, which
        // do NOT get a second agent_start.
        this.options.onEvent({ kind: "turn_start" });
        return;
      case "agent_end":
        this.streaming = false;
        this.options.onEvent({ kind: "agent_end" });
        return;
      case "agent_settled":
        this.settled = true;
        this.options.onEvent({ kind: "agent_settled" });
        return;
      case "message_start":
      case "message_end": {
        const message = (parsed.message ?? {}) as Record<string, unknown>;
        if (message.role === "assistant") {
          if (type === "message_end") {
            this.lastAssistant = textOfMessage(message);
            this.liveAssistant = this.lastAssistant;
            this.options.onEvent({
              kind: "assistant_message",
              text: this.lastAssistant,
            });
          }
        }
        this.options.onEvent({ kind: "event", raw: parsed });
        return;
      }
      case "turn_end": {
        const message = (parsed.message ?? {}) as Record<string, unknown>;
        const usage = (message.usage ?? {}) as Record<string, unknown>;
        this.options.onEvent({
          kind: "usage",
          inputTokens:
            typeof usage.input === "number" ? usage.input : undefined,
          model: typeof message.model === "string" ? message.model : undefined,
        });
        this.options.onEvent({ kind: "event", raw: parsed });
        return;
      }
      case "tool_execution_start":
        const toolName = String(parsed.toolName ?? "tool");
        this.options.onEvent({
          kind: "tool_start",
          toolCallId: String(parsed.toolCallId ?? ""),
          toolName,
          reason: stepReason(parsed.args, toolName),
          label: stepLabel(toolName, parsed.args),
          // Issue 128: dispatch target — the daemon enriches the tool part
          // with the structured receipt (avatar/title from bot config).
          ...(toolName === "message_agent" &&
          typeof (parsed.args as { target?: unknown } | undefined)?.target ===
            "string"
            ? {
                target: (parsed.args as { target: string }).target,
              }
            : {}),
        });
        return;
      case "tool_execution_end": {
        this.options.onEvent({
          kind: "tool_end",
          toolCallId: String(parsed.toolCallId ?? ""),
          result: toolResultText(parsed.result),
          isError: parsed.isError === true,
          elapsedMs:
            typeof parsed.piTidyElapsedMs === "number"
              ? parsed.piTidyElapsedMs
              : undefined,
        });
        return;
      }
      case "tool_execution_update": {
        // Partial result text while the tool runs — surfaces live output in
        // full mode instead of starving it until settle (issue 66).
        const partial = toolResultText(parsed.partialResult);
        if (partial.length > 0) {
          this.options.onEvent({
            kind: "tool_output",
            toolCallId: String(parsed.toolCallId ?? ""),
            text: partial,
          });
        }
        return;
      }
      case "message_update": {
        const update = (parsed.assistantMessageEvent ?? {}) as Record<
          string,
          unknown
        >;
        if (update.type === "text_delta" && typeof update.delta === "string") {
          this.liveAssistant += update.delta;
          this.options.onEvent({
            kind: "assistant_delta",
            delta: update.delta,
          });
        }
        return;
      }
      case "extension_ui_request": {
        const method = String(parsed.method ?? "");
        const id = typeof parsed.id === "string" ? parsed.id : "";
        // Every id'd request crosses to the daemon: interactive methods become
        // answerable cards, unknown methods get defused there, and known
        // fire-and-forget methods are ignored without a response.
        if (id) {
          this.options.onEvent({
            kind: "ui_request",
            id,
            method,
            title: typeof parsed.title === "string" ? parsed.title : "",
            options: Array.isArray(parsed.options)
              ? parsed.options.map((option) => String(option))
              : undefined,
            message:
              typeof parsed.message === "string" ? parsed.message : undefined,
            placeholder:
              typeof parsed.placeholder === "string"
                ? parsed.placeholder
                : undefined,
          });
        }
        return;
      }
      default:
        this.options.onEvent({ kind: "event", raw: parsed });
    }
  }
}
