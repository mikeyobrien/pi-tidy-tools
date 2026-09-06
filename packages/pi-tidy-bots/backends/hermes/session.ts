import { isAbsolute } from "node:path";
import { AcpTransport, type AcpTransportOptions } from "./acp-transport.ts";
import {
  object,
  nonempty,
  ProtocolError,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";

interface Turn {
  operationId: string;
  turnId: string;
  started: boolean;
  order: number;
  message?: { id: string; text: string; revision: number };
  tools: Map<string, { finished: boolean; private: boolean }>;
}
export interface HermesSessionOptions extends Pick<
  AcpTransportOptions,
  | "input"
  | "output"
  | "maxFrameBytes"
  | "maxPendingRequests"
  | "requestTimeoutMs"
> {
  /** Must durably append synchronously. The SDK supplies source IDs and sequence. */
  emit: (event: JsonObject) => void;
  onFailure: (error: ProtocolError) => void;
  onPermission: (
    params: JsonObject,
    id: string | number,
    turn: {
      operationId: string;
      turnId: string;
    },
    signal: AbortSignal
  ) => Promise<unknown>;
  /** Must synchronously persist the exact native decision receipt. */
  onPermissionConsumed?: (receipt: {
    permissionId: string;
    optionId: string;
    operationId: string;
    turnId: string;
  }) => void;
}
const metadataUpdates = new Set([
  "session_info_update",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "usage_update",
  "plan",
]);
const toolLabels: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run command",
  fetch: "Fetch",
  other: "Tool",
};

/** One fresh, explicitly guarded native session. The composing plugin must
 * reserve every mutation in its durable SDK before calling these methods and
 * supervise all native descendants; this class does not certify ownership.
 */
export class HermesSession {
  readonly transport: AcpTransport;
  private opening = false;
  private sessionId?: string;
  private active?: Turn;
  private lost = false;
  private closing = false;
  private readonly permissions = new Map<
    string,
    {
      operationId: string;
      turnId: string;
      optionId?: string;
    }
  >();
  private readonly permissionIds = new Set<string>();
  constructor(private readonly options: HermesSessionOptions) {
    this.transport = new AcpTransport({
      ...options,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: async (method, params, id, signal) => {
        if (
          method !== "session/request_permission" ||
          !this.active ||
          params.sessionId !== this.sessionId
        )
          throw new ProtocolError(
            "native_protocol_error",
            "Uncorrelated native permission request"
          );
        const tidy = object(params._meta) ? params._meta.tidy : undefined;
        if (
          !object(tidy) ||
          !nonempty(tidy.permissionId) ||
          tidy.permissionId.length > 128 ||
          this.permissionIds.has(tidy.permissionId) ||
          this.permissions.size >= 256 ||
          this.permissionIds.size >= 4096
        )
          throw new ProtocolError(
            "native_protocol_error",
            "Missing or reused native permission identity"
          );
        this.started(this.active);
        const permission = {
          operationId: this.active.operationId,
          turnId: this.active.turnId,
          optionId: undefined as string | undefined,
        };
        this.permissions.set(tidy.permissionId, permission);
        this.permissionIds.add(tidy.permissionId);
        const result = await options.onPermission(
          params,
          id,
          {
            operationId: this.active.operationId,
            turnId: this.active.turnId,
          },
          signal
        );
        if (!object(result) || !object(result.outcome)) throw new Error();
        if (result.outcome.outcome === "cancelled")
          this.permissions.delete(tidy.permissionId);
        else if (
          result.outcome.outcome === "selected" &&
          ["allow_once", "deny"].includes(String(result.outcome.optionId))
        )
          permission.optionId = String(result.outcome.optionId);
        else throw new Error();
        return result;
      },
      onFailure: (error) => this.fail(error),
    });
  }
  async open(cwd: string): Promise<string> {
    if (this.opening || this.lost || !isAbsolute(cwd))
      throw new ProtocolError(
        "session_unavailable",
        "A fresh session can be opened only once with an absolute workspace"
      );
    this.opening = true;
    const initialized = await this.transport.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "tidy-hermes", version: "0.1.0-dev" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    if (
      !object(initialized) ||
      initialized.protocolVersion !== 1 ||
      !object(initialized.agentInfo) ||
      initialized.agentInfo.name !== "hermes-agent" ||
      initialized.agentInfo.version !== "0.20.5" ||
      !object(initialized._meta) ||
      !object(initialized._meta.tidy) ||
      initialized._meta.tidy.guardVersion !== 3 ||
      initialized._meta.tidy.approvalPolicy !== "ask" ||
      initialized._meta.tidy.environment !== "explicit" ||
      !object(initialized.agentCapabilities) ||
      initialized.agentCapabilities.loadSession !== false
    )
      throw new ProtocolError(
        "native_contract_unavailable",
        "Native runtime did not prove the required guarded contract"
      );
    const opened = await this.transport.request("session/new", {
      cwd,
      mcpServers: [],
    });
    if (!object(opened) || !nonempty(opened.sessionId))
      throw new ProtocolError(
        "session_unknown",
        "Native session creation has no correlated identity"
      );
    this.sessionId = opened.sessionId;
    return this.sessionId;
  }
  async submit(
    operationId: string,
    turnId: string,
    input: unknown
  ): Promise<{ disposition: "accepted" | "rejected" | "unknown" }> {
    if (!this.sessionId || this.active || this.lost || this.closing)
      return { disposition: "unknown" };
    if (
      !nonempty(operationId) ||
      !nonempty(turnId) ||
      !Array.isArray(input) ||
      !input.length ||
      !input.every(
        (part) =>
          object(part) && part.type === "text" && typeof part.text === "string"
      ) ||
      !input.some((part) => part.text.trim())
    )
      return { disposition: "rejected" };
    const turn: Turn = {
      operationId,
      turnId,
      started: false,
      order: 0,
      tools: new Map(),
    };
    this.active = turn;
    try {
      const result = await this.transport.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: input.map((part) => ({ type: "text", text: part.text })),
      });
      if (
        !object(result) ||
        !object(result._meta) ||
        !object(result._meta.tidy)
      )
        throw new Error();
      const tidy = result._meta.tidy;
      if (
        tidy.rejectedBeforePrompt === true &&
        !turn.started &&
        result.stopReason === "refusal"
      ) {
        this.active = undefined;
        return { disposition: "rejected" };
      }
      const evidence = tidy.turnEvidence;
      if (
        tidy.guardVersion !== 3 ||
        !object(evidence) ||
        evidence.started !== true ||
        evidence.settled !== true ||
        typeof evidence.failed !== "boolean" ||
        typeof evidence.interrupted !== "boolean" ||
        ![
          "end_turn",
          "cancelled",
          "max_tokens",
          "max_turn_requests",
          "refusal",
        ].includes(String(result.stopReason))
      )
        throw new Error();
      this.started(turn);
      if (!evidence.failed) {
        if (typeof evidence.finalText !== "string") throw new Error();
        // The guard captures final_response after native output transforms.
        // ACP alone cannot distinguish this full replacement from another delta.
        if (evidence.finalText || turn.message)
          this.snapshot(turn, evidence.finalText);
      } else if (turn.message) this.snapshot(turn, "The native turn failed.");
      this.finishMessage(turn);
      const complete =
        evidence.observationsComplete === true &&
        this.permissions.size === 0 &&
        [...turn.tools.values()].every((tool) => tool.finished);
      const execution = evidence.failed
        ? "failed"
        : result.stopReason === "cancelled"
          ? "cancelled"
          : evidence.interrupted
            ? "interrupted"
            : result.stopReason === "end_turn"
              ? "ended"
              : "interrupted";
      this.emit(turn, "turn.terminal", {
        execution,
        observation: complete ? "complete" : "reconciliation_required",
        evidence: "guarded_native_run_settled",
      });
      this.active = undefined;
      if (!complete)
        this.fail(
          new ProtocolError(
            "native_observation_gap",
            "Native tool settlement is incomplete"
          )
        );
      return { disposition: "accepted" };
    } catch {
      this.fail(
        new ProtocolError(
          "native_observation_gap",
          "Native prompt outcome requires reconciliation"
        )
      );
      return { disposition: turn.started ? "accepted" : "unknown" };
    }
  }
  close(): void {
    this.closing = true;
    this.permissions.clear();
    this.transport.close();
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
  private notification(method: string, params: JsonObject): void {
    if (method === "_tidy/permission_consumed") {
      const permission = nonempty(params.permissionId)
        ? this.permissions.get(params.permissionId)
        : undefined;
      if (
        !permission ||
        !this.active ||
        params.sessionId !== this.sessionId ||
        params.evidence !== "native_callback_returned" ||
        !permission.optionId ||
        params.optionId !== permission.optionId ||
        permission.operationId !== this.active.operationId ||
        permission.turnId !== this.active.turnId ||
        !this.options.onPermissionConsumed
      )
        throw new Error();
      const result: unknown = this.options.onPermissionConsumed({
        ...permission,
        permissionId: String(params.permissionId),
        optionId: permission.optionId,
      });
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw new Error();
      }
      this.permissions.delete(String(params.permissionId));
      return;
    }
    if (method !== "session/update" || !object(params.update))
      throw new Error();
    const update = params.update;
    if (metadataUpdates.has(String(update.sessionUpdate))) return;
    const turn = this.active;
    if (!turn || this.lost || params.sessionId !== this.sessionId)
      throw new Error();
    this.started(turn);
    if (update.sessionUpdate === "agent_thought_chunk") return;
    if (update.sessionUpdate === "agent_message_chunk") {
      if (
        !object(update.content) ||
        update.content.type !== "text" ||
        typeof update.content.text !== "string"
      )
        throw new Error();
      this.snapshot(turn, (turn.message?.text ?? "") + update.content.text);
      return;
    }
    if (!nonempty(update.toolCallId)) throw new Error();
    if (update.sessionUpdate === "tool_call") {
      if (turn.tools.has(update.toolCallId)) throw new Error();
      this.finishMessage(turn);
      const privateTool = update.kind === "think";
      turn.tools.set(update.toolCallId, {
        finished: false,
        private: privateTool,
      });
      if (!privateTool)
        this.emit(
          turn,
          "tool.started",
          {
            label: toolLabels[String(update.kind)] ?? "Tool",
            state: "running",
          },
          { toolCallId: update.toolCallId }
        );
    } else if (update.sessionUpdate !== "tool_call_update") throw new Error();
    const tool = turn.tools.get(update.toolCallId);
    if (!tool || tool.finished) throw new Error();
    if (update.status === "completed" || update.status === "failed") {
      tool.finished = true;
      if (!tool.private)
        this.emit(
          turn,
          "tool.finished",
          { state: update.status === "completed" ? "ended" : "error" },
          { toolCallId: update.toolCallId }
        );
    } else if (
      update.status !== undefined &&
      !["pending", "in_progress"].includes(String(update.status))
    )
      throw new Error();
  }
  private fail(error: ProtocolError): void {
    if (this.lost) return;
    this.lost = true;
    this.permissions.clear();
    try {
      if (this.active)
        this.emit(this.active, "observation.gap", {
          code: "native_observation_gap",
        });
    } finally {
      if (!this.closing) this.options.onFailure(error);
    }
  }
}
