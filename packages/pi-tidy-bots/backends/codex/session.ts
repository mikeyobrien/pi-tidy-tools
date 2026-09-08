import { isAbsolute } from "node:path";
import {
  CodexRequestError,
  CodexTransport,
  type CodexTransportOptions,
} from "./transport.ts";
import {
  object,
  nonempty,
  ProtocolError,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";

type Execution = "ended" | "failed" | "cancelled" | "interrupted";

interface ItemMessage {
  nativeItemId: string;
  id: string;
  text: string;
  revision: number;
  finished: boolean;
}

interface Turn {
  operationId: string;
  turnId: string;
  nativeTurnId?: string;
  started: boolean;
  cancelRequested?: boolean;
  onAccepted?: () => void;
  settle?: (execution: Execution) => void;
  order: number;
  items: Map<string, ItemMessage>;
}

const LIVE_STATUS = new Set(["inProgress", "in_progress"]);

function nativeTurnIdOf(params: JsonObject): string | undefined {
  if (nonempty(params.turnId)) return params.turnId;
  if (object(params.turn) && nonempty(params.turn.id))
    return String(params.turn.id);
  return undefined;
}

function nativeItemIdOf(params: JsonObject): string | undefined {
  if (nonempty(params.itemId)) return params.itemId;
  if (object(params.item) && nonempty(params.item.id))
    return String(params.item.id);
  return undefined;
}

function terminalExecution(
  status: unknown,
  cancelRequested: boolean
): Execution | undefined {
  if (status === "completed") return "ended";
  if (status === "failed") return "failed";
  if (status === "interrupted")
    return cancelRequested ? "cancelled" : "interrupted";
  return undefined;
}

export interface CodexSessionOptions extends Pick<
  CodexTransportOptions,
  | "input"
  | "output"
  | "maxFrameBytes"
  | "maxPendingRequests"
  | "requestTimeoutMs"
> {
  promptTimeoutMs?: number;
  /** Isolated CODEX_HOME (`profile_dir`). Not Unix HOME (`home_dir`). */
  expectedHome: string;
  emit: (event: JsonObject) => void;
  onFailure: (error: ProtocolError) => void;
}

function threadIdOf(value: unknown): string | undefined {
  if (!object(value) || !object(value.thread) || !nonempty(value.thread.id))
    return undefined;
  if (value.thread.ephemeral === true) return undefined;
  return value.thread.id;
}

function agentText(item: JsonObject): string | undefined {
  if (item.type !== "agentMessage" || typeof item.text !== "string")
    return undefined;
  return item.text;
}

/** One owned Codex app-server thread. Load never creates. */
export class CodexSession {
  readonly transport: CodexTransport;
  private opening = false;
  private threadId?: string;
  private active?: Turn;
  private lost = false;
  private closing = false;
  constructor(private readonly options: CodexSessionOptions) {
    this.transport = new CodexTransport({
      ...options,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: async (method, params, id) => {
        void params;
        void id;
        throw new ProtocolError(
          "capability_unavailable",
          `Codex native request ${method} is not implemented`
        );
      },
      onFailure: (error) => this.fail(error),
    });
  }
  async open(cwd: string, restoreThreadId?: string): Promise<string> {
    if (this.opening || this.lost || !isAbsolute(cwd))
      throw new ProtocolError(
        "session_unavailable",
        "A Codex session can be opened only once with an absolute workspace"
      );
    this.opening = true;
    const initialized = await this.transport.request("initialize", {
      clientInfo: { name: "tidy.codex", version: "0.1.0-dev" },
    });
    if (
      !object(initialized) ||
      !nonempty(initialized.codexHome) ||
      !nonempty(initialized.userAgent) ||
      initialized.codexHome !== this.options.expectedHome
    )
      throw new ProtocolError(
        "continuity_unverified",
        "Codex initialize did not prove the isolated native home"
      );
    if (restoreThreadId !== undefined) {
      if (!nonempty(restoreThreadId))
        throw new ProtocolError(
          "continuity_unverified",
          "Codex load requires an exact native thread"
        );
      let resumed: unknown;
      try {
        resumed = await this.transport.request("thread/resume", {
          threadId: restoreThreadId,
        });
      } catch (error) {
        if (error instanceof CodexRequestError)
          throw new ProtocolError(
            "session_not_found",
            "Codex load missed the retained thread"
          );
        throw error;
      }
      const resumedId = threadIdOf(resumed);
      if (resumedId !== restoreThreadId)
        throw new ProtocolError(
          "continuity_unverified",
          "Codex load did not restore the exact retained thread"
        );
      // Identity-only: expected CODEX_HOME + returned thread id. No history
      // digest, message count, or checkpoint comparison is available.
      this.threadId = resumedId;
      return this.threadId;
    }
    const created = await this.transport.request("thread/start", {
      cwd,
      ephemeral: false,
      serviceName: "tidy.codex",
    });
    const createdId = threadIdOf(created);
    if (!createdId)
      throw new ProtocolError(
        "session_unknown",
        "Codex thread creation has no correlated identity"
      );
    this.threadId = createdId;
    return this.threadId;
  }
  async submit(
    operationId: string,
    turnId: string,
    input: JsonObject[],
    onAccepted?: () => void
  ): Promise<{ disposition: "accepted" | "rejected" | "unknown" }> {
    if (!this.threadId || this.active || this.lost || this.closing)
      return { disposition: "unknown" };
    if (
      !nonempty(operationId) ||
      !nonempty(turnId) ||
      !input.length ||
      !input.every(
        (part) => part.type === "text" && typeof part.text === "string"
      ) ||
      !input.some((part) => String(part.text).trim())
    )
      return { disposition: "rejected" };
    const turn: Turn = {
      operationId,
      turnId,
      started: false,
      order: 0,
      items: new Map(),
      onAccepted,
    };
    this.active = turn;
    const finished = new Promise<Execution>((resolve) => {
      turn.settle = resolve;
    });
    try {
      const started = await this.transport.request(
        "turn/start",
        {
          threadId: this.threadId,
          input: input.map((part) => ({ type: "text", text: part.text })),
        },
        this.options.requestTimeoutMs
      );
      if (
        !object(started) ||
        !object(started.turn) ||
        !nonempty(started.turn.id)
      )
        throw new Error();
      turn.nativeTurnId = String(started.turn.id);
      this.started(turn);
      const rpcStatus = started.turn.status;
      if (rpcStatus !== undefined && !LIVE_STATUS.has(String(rpcStatus))) {
        const execution = terminalExecution(rpcStatus, !!turn.cancelRequested);
        if (!execution)
          throw new ProtocolError(
            "native_observation_gap",
            "Codex turn status is not an allowlisted terminal"
          );
        this.complete(turn, execution);
      }
      const timeout = setTimeout(
        () =>
          this.fail(
            new ProtocolError("native_timeout", "Codex turn timed out")
          ),
        this.options.promptTimeoutMs ?? 3600000
      );
      try {
        const execution = await finished;
        if (this.lost) {
          this.active = undefined;
          return { disposition: turn.started ? "accepted" : "unknown" };
        }
        this.finishOpenItems(turn);
        this.emit(turn, "turn.terminal", {
          execution,
          observation: "complete",
          evidence: "codex_app_server_turn",
        });
        this.active = undefined;
        return { disposition: "accepted" };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      this.fail(
        new ProtocolError(
          "native_observation_gap",
          "Codex turn outcome requires reconciliation"
        )
      );
      return { disposition: turn.started ? "accepted" : "unknown" };
    }
  }
  cancel(targetOperationId: string): { status: "requested" | "unknown" } {
    const turn = this.active;
    if (
      !turn ||
      turn.operationId !== targetOperationId ||
      !this.threadId ||
      !turn.nativeTurnId ||
      this.lost ||
      this.closing
    )
      return { status: "unknown" };
    if (turn.cancelRequested) return { status: "requested" };
    turn.cancelRequested = true;
    void this.transport
      .request("turn/interrupt", {
        threadId: this.threadId,
        turnId: turn.nativeTurnId,
      })
      .catch(() =>
        this.fail(
          new ProtocolError(
            "native_observation_gap",
            "Codex cancellation requires reconciliation"
          )
        )
      );
    return { status: this.lost ? "unknown" : "requested" };
  }
  close(): void {
    this.closing = true;
    this.transport.close();
  }
  private notification(method: string, params: JsonObject): void {
    try {
      this.observe(method, params);
    } catch (error) {
      this.fail(
        error instanceof ProtocolError
          ? error
          : new ProtocolError(
              "native_protocol_error",
              "Codex notification could not be projected"
            )
      );
    }
  }
  private observe(method: string, params: JsonObject): void {
    const turn = this.active;
    if (!turn || !this.threadId || params.threadId !== this.threadId) return;
    const notificationTurnId = nativeTurnIdOf(params);
    if (method === "turn/started" && object(params.turn)) {
      if (!nonempty(params.turn.id)) return;
      const id = String(params.turn.id);
      if (turn.nativeTurnId && turn.nativeTurnId !== id) return;
      turn.nativeTurnId = id;
      this.started(turn);
      return;
    }
    if (!turn.nativeTurnId || notificationTurnId !== turn.nativeTurnId) return;
    if (!method.startsWith("item/")) {
      if (method === "turn/completed" && object(params.turn)) {
        const execution = terminalExecution(
          params.turn.status,
          !!turn.cancelRequested
        );
        if (!execution)
          throw new ProtocolError(
            "native_observation_gap",
            "Codex turn status is not an allowlisted terminal"
          );
        this.complete(turn, execution);
      }
      return;
    }
    const itemId = nativeItemIdOf(params);
    if (!itemId) return;
    if (
      method === "item/agentMessage/delta" &&
      typeof params.delta === "string" &&
      params.delta
    ) {
      const item = this.itemOf(turn, itemId);
      if (item.finished) return;
      this.started(turn);
      this.snapshot(item, turn, item.text + params.delta);
      return;
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      object(params.item)
    ) {
      const text = agentText(params.item);
      const item = text ? this.itemOf(turn, itemId) : turn.items.get(itemId);
      if (!item || item.finished) return;
      if (text) {
        this.started(turn);
        this.snapshot(item, turn, text);
      }
      if (method === "item/completed") this.finishItem(item, turn);
    }
  }
  private complete(turn: Turn, execution: Execution): void {
    turn.settle?.(execution);
    turn.settle = undefined;
  }
  private emit(
    turn: Turn,
    type: string,
    payload: JsonObject,
    identity: JsonObject = {}
  ): void {
    this.options.emit({
      operationId: turn.operationId,
      turnId: turn.turnId,
      ...identity,
      type,
      payload,
    });
  }
  private started(turn: Turn): void {
    if (turn.started) return;
    this.emit(turn, "operation.disposition", {
      disposition: "accepted",
      evidence: "correlated_native_activity",
    });
    this.emit(turn, "turn.started", {});
    turn.started = true;
    turn.onAccepted?.();
  }
  private itemOf(turn: Turn, nativeItemId: string): ItemMessage {
    const existing = turn.items.get(nativeItemId);
    if (existing) return existing;
    const item: ItemMessage = {
      nativeItemId,
      id: `${turn.operationId}:message:${turn.order}`,
      text: "",
      revision: 0,
      finished: false,
    };
    turn.items.set(nativeItemId, item);
    return item;
  }
  private snapshot(item: ItemMessage, turn: Turn, text: string): void {
    if (item.finished) return;
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error();
    if (!item.revision) {
      const order = turn.order++;
      item.id = `${turn.operationId}:message:${order}`;
      this.emit(
        turn,
        "message.started",
        { role: "assistant", order },
        { messageId: item.id }
      );
    }
    item.text = text;
    this.emit(
      turn,
      "text.snapshot",
      { text, revision: ++item.revision },
      { messageId: item.id, blockId: "body" }
    );
  }
  private finishItem(item: ItemMessage, turn: Turn): void {
    if (item.finished || !item.revision) return;
    item.finished = true;
    this.emit(
      turn,
      "message.finished",
      {
        ts: new Date().toISOString(),
        blocks: [
          {
            type: "text",
            blockId: "body",
            text: item.text,
            revision: item.revision,
          },
        ],
      },
      { messageId: item.id }
    );
  }
  private finishOpenItems(turn: Turn): void {
    for (const item of turn.items.values()) this.finishItem(item, turn);
  }
  private fail(error: ProtocolError): void {
    if (this.lost) return;
    this.lost = true;
    const turn = this.active;
    turn?.settle?.("failed");
    if (turn) turn.settle = undefined;
    this.options.onFailure(error);
  }
}
