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

interface Turn {
  operationId: string;
  turnId: string;
  nativeTurnId?: string;
  started: boolean;
  cancelRequested?: boolean;
  onAccepted?: () => void;
  settle?: (execution: "ended" | "failed" | "cancelled" | "interrupted") => void;
  order: number;
  text: string;
  message?: { id: string; text: string; revision: number };
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
      text: "",
      onAccepted,
    };
    this.active = turn;
    const finished = new Promise<"ended" | "failed" | "cancelled" | "interrupted">(
      (resolve) => {
        turn.settle = resolve;
      }
    );
    try {
      const started = await this.transport.request(
        "turn/start",
        {
          threadId: this.threadId,
          input: input.map((part) => ({ type: "text", text: part.text })),
        },
        this.options.requestTimeoutMs
      );
      if (!object(started) || !object(started.turn) || !nonempty(started.turn.id))
        throw new Error();
      turn.nativeTurnId = String(started.turn.id);
      this.started(turn);
      if (started.turn.status === "completed") this.complete(turn, "ended");
      else if (started.turn.status === "failed") this.complete(turn, "failed");
      else if (started.turn.status === "interrupted")
        this.complete(turn, "interrupted");
      const timeout = setTimeout(
        () => this.fail(new ProtocolError("native_timeout", "Codex turn timed out")),
        this.options.promptTimeoutMs ?? 3600000
      );
      try {
        const execution = await finished;
        this.finishMessage(turn);
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
    if (method === "turn/started" && object(params.turn)) {
      if (!turn.nativeTurnId && nonempty(params.turn.id))
        turn.nativeTurnId = String(params.turn.id);
      this.started(turn);
      return;
    }
    if (
      method === "item/agentMessage/delta" &&
      typeof params.delta === "string" &&
      params.delta
    ) {
      this.started(turn);
      this.snapshot(turn, turn.text + params.delta);
      return;
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      object(params.item)
    ) {
      const text = agentText(params.item);
      if (text) {
        this.started(turn);
        this.snapshot(turn, text);
      }
      return;
    }
    if (method === "turn/completed" && object(params.turn)) {
      const status = params.turn.status;
      this.complete(
        turn,
        status === "failed"
          ? "failed"
          : status === "interrupted" || turn.cancelRequested
            ? turn.cancelRequested && status !== "failed"
              ? "cancelled"
              : "interrupted"
            : "ended"
      );
    }
  }
  private complete(
    turn: Turn,
    execution: "ended" | "failed" | "cancelled" | "interrupted"
  ): void {
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
  private snapshot(turn: Turn, text: string): void {
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error();
    if (!turn.message) {
      const order = turn.order++;
      turn.message = {
        id: `${turn.operationId}:message:${order}`,
        text: "",
        revision: 0,
      };
      this.emit(
        turn,
        "message.started",
        { role: "assistant", order },
        { messageId: turn.message.id }
      );
    }
    turn.text = text;
    turn.message.text = text;
    this.emit(
      turn,
      "text.snapshot",
      { text, revision: ++turn.message.revision },
      { messageId: turn.message.id, blockId: "body" }
    );
  }
  private finishMessage(turn: Turn): void {
    if (!turn.message) return;
    const message = turn.message;
    this.emit(
      turn,
      "message.finished",
      {
        ts: new Date().toISOString(),
        blocks: [
          {
            type: "text",
            blockId: "body",
            text: message.text,
            revision: message.revision,
          },
        ],
      },
      { messageId: message.id }
    );
    turn.message = undefined;
  }
  private fail(error: ProtocolError): void {
    if (this.lost) return;
    this.lost = true;
    this.options.onFailure(error);
  }
}
