import { readFile, realpath, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runPlugin,
  ProtocolError,
  type PluginContext,
  type PluginRuntime,
  type CapabilityDescriptor,
} from "@mobrienv/pi-tidy-bots/plugin-sdk";
import {
  object,
  nonempty,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";
import {
  RpcSession,
  RpcCommandRejected,
  type RpcEvent,
} from "@mobrienv/pi-tidy-bots/src/rpc.ts";

// Expand this profile only after its native feature conformance cells pass.
export const PI_CAPABILITIES: CapabilityDescriptor = {
  input: { text: true, mediaTypes: [], maxMediaBytes: 0 },
  sessions: { load: false, import: false, continuity: "unverified" },
  output: { text: "snapshots", tools: false, usage: "unknown" },
  operations: {
    nativeDedupe: "none",
    nativeReplay: "none",
    cancel: "cooperative",
    steer: false,
  },
  interactions: { permissions: "none", questions: false },
  configuration: { model: false, thinking: false, compact: false },
  fleetTools: false,
};
export const PI_VERSION = "0.85.0";

interface Configuration {
  executable: string;
  home: string;
  profile: string;
  environment: Record<string, string>;
  model?: string;
}
async function absoluteDirectory(value: unknown): Promise<string> {
  if (!nonempty(value) || !isAbsolute(value))
    throw new ProtocolError(
      "invalid_config",
      "Pi requires explicit absolute directories"
    );
  const path = await realpath(value);
  if (!(await stat(path)).isDirectory())
    throw new ProtocolError(
      "invalid_config",
      "Pi profile and home must already exist"
    );
  return path;
}
export async function validatePiConfiguration(
  config: JsonObject
): Promise<Configuration> {
  const keys = [
    "executable",
    "package_json",
    "home_dir",
    "profile_dir",
    "environment_keys",
    "model",
  ];
  if (Object.keys(config).some((key) => !keys.includes(key)))
    throw new ProtocolError("invalid_config", "Unknown Pi configuration key");
  if (
    !nonempty(config.executable) ||
    !isAbsolute(config.executable) ||
    !nonempty(config.package_json) ||
    !isAbsolute(config.package_json)
  )
    throw new ProtocolError(
      "invalid_config",
      "Pi requires explicit executable and package metadata paths"
    );
  const executable = await realpath(config.executable);
  const metadataPath = await realpath(config.package_json);
  const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
  if (
    !object(metadata) ||
    metadata.name !== "@earendil-works/pi-coding-agent" ||
    metadata.version !== PI_VERSION
  )
    throw new ProtocolError(
      "invalid_config",
      "Pi runtime version is outside this adapter profile"
    );
  const binary =
    typeof metadata.bin === "string"
      ? metadata.bin
      : object(metadata.bin)
        ? metadata.bin.pi
        : undefined;
  if (
    !nonempty(binary) ||
    (await realpath(resolve(dirname(metadataPath), binary))) !== executable
  )
    throw new ProtocolError(
      "invalid_config",
      "Pi executable does not match runtime package metadata"
    );
  const home = await absoluteDirectory(config.home_dir);
  const profile = await absoluteDirectory(config.profile_dir);
  if (
    !Array.isArray(config.environment_keys) ||
    !config.environment_keys.every(
      (key) =>
        typeof key === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(key) &&
        !/^(TIDY_|PI_TIDY_|PI_CODING_|NODE_OPTIONS$|LD_PRELOAD$|DYLD_|HOME$)/.test(
          key
        )
    )
  )
    throw new ProtocolError(
      "invalid_config",
      "Pi environment requires explicit permitted variable names"
    );
  const environment: Record<string, string> = {
    HOME: home,
    PI_CODING_AGENT_DIR: profile,
  };
  for (const key of config.environment_keys as string[]) {
    const value = process.env[key];
    if (value === undefined)
      throw new ProtocolError(
        "invalid_config",
        "An explicitly requested Pi environment variable is unavailable"
      );
    environment[key] = value;
  }
  if (config.model !== undefined && !nonempty(config.model))
    throw new ProtocolError(
      "invalid_config",
      "Pi model must be a nonempty native model selector"
    );
  return {
    executable,
    home,
    profile,
    environment,
    ...(config.model ? { model: String(config.model) } : {}),
  };
}

interface Turn {
  operationId: string;
  turnId: string;
  started: boolean;
  execution: "ended" | "failed" | "cancelled";
  order: number;
  message?: { id: string; text: string; revision: number };
}

/** One private Pi RPC child per binding. SDK reservations precede all native effects. */
export function startPiAdapter(): PluginRuntime {
  let configuration: Configuration;
  let context: PluginContext;
  let native: RpcSession | undefined;
  let nativeClosed: Promise<void> | undefined;
  let conversationId: string | undefined;
  let nativeReference: string | undefined;
  let active: Turn | undefined;
  let observationLost = false;
  let stopping = false;
  const emit = (
    type: string,
    payload: JsonObject,
    identity: JsonObject = {}
  ) => {
    context.emit({
      ...(active
        ? { operationId: active.operationId, turnId: active.turnId }
        : {}),
      ...identity,
      type,
      payload,
    });
  };
  const loseObservation = () => {
    if (observationLost || stopping) return;
    observationLost = true;
    try {
      emit("observation.gap", { code: "native_observation_gap" });
    } catch {
      // A failed durable append is itself uncertainty; shutdown must still run.
    } finally {
      void runtime.close("native_observation_gap");
    }
  };
  const ensureMessage = () => {
    if (!active?.started)
      throw new Error("Uncorrelated native assistant message");
    if (!active.message) {
      const order = active.order++;
      active.message = {
        id: `${active.operationId}:message:${order}`,
        text: "",
        revision: 0,
      };
      emit(
        "message.started",
        { role: "assistant", order },
        { messageId: active.message.id }
      );
    }
    return active.message;
  };
  const snapshot = (text: string) => {
    const message = ensureMessage();
    message.text = text;
    emit(
      "text.snapshot",
      { text, revision: ++message.revision },
      { messageId: message.id, blockId: "body" }
    );
  };
  const onEvent = (event: RpcEvent) => {
    if (stopping || observationLost) return;
    try {
      if (event.kind === "event") {
        if (
          event.raw.type === "message_start" &&
          object(event.raw.message) &&
          event.raw.message.role === "assistant"
        ) {
          if (active?.message)
            throw new Error("Overlapping native assistant messages");
          ensureMessage();
        }
        if (
          event.raw.type === "message_end" &&
          object(event.raw.message) &&
          event.raw.message.role === "assistant" &&
          active
        ) {
          if (event.raw.message.stopReason === "error")
            active.execution = "failed";
          if (
            event.raw.message.stopReason === "aborted" &&
            active.execution !== "failed"
          )
            active.execution = "cancelled";
        }
        return;
      }
      if (
        event.kind === "usage" ||
        event.kind === "turn_start" ||
        event.kind === "agent_end"
      )
        return;
      if (event.kind === "ui_request" || event.kind.startsWith("tool_")) {
        // These are outside this no-tools profile. Never auto-answer native approval/UI.
        loseObservation();
        return;
      }
      if (!active)
        throw new Error("Native output without an admitted operation");
      if (event.kind === "agent_start") {
        if (active.started) throw new Error("Unrequested native follow-up");
        active.started = true;
        emit("operation.disposition", {
          disposition: "accepted",
          evidence: "native_turn_started",
        });
        emit("turn.started", {});
      } else if (event.kind === "assistant_delta") {
        const message = ensureMessage();
        snapshot(message.text + event.delta);
      } else if (event.kind === "assistant_message") {
        snapshot(event.text);
        const message = active.message!;
        emit(
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
        active.message = undefined;
      } else if (event.kind === "agent_settled") {
        if (!active.started || active.message)
          throw new Error("Incomplete native turn observation");
        emit("turn.terminal", {
          execution: active.execution,
          observation: "complete",
          evidence: "native_agent_settled",
        });
        active = undefined;
      }
    } catch {
      loseObservation();
    }
  };
  const runtime = runPlugin({
    identity: { id: "tidy.pi", version: "0.1.0-dev" },
    runtime: { name: "pi", version: PI_VERSION, transport: "rpc" },
    capabilities: PI_CAPABILITIES,
    async onInitialize(ctx) {
      context = ctx;
      configuration = await validatePiConfiguration(ctx.initialization.config);
    },
    async onClose(info) {
      if (info.mode === "drain") {
        while (active && !observationLost && Date.now() < info.deadline - 100)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      stopping = true;
      if (!native) return { ownedResourcesStopped: true };
      native.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stopped = await Promise.race([
          nativeClosed!.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(
              () => resolve(false),
              Math.max(0, info.deadline - Date.now())
            );
          }),
        ]);
        return { ownedResourcesStopped: stopped };
      } finally {
        clearTimeout(timer);
      }
    },
    handlers: {
      async "session.open"(params, ctx) {
        if (params.mode !== "new")
          throw new ProtocolError(
            "continuity_unverified",
            "Pi cold load is not verified"
          );
        if (
          native ||
          !nonempty(params.conversationId) ||
          !nonempty(params.cwd) ||
          (await realpath(params.cwd)) !==
            (await realpath(ctx.initialization.workspace))
        )
          throw new ProtocolError(
            "invalid_config",
            "Pi open requires this binding workspace and one native session"
          );
        const sessionDir = join(ctx.initialization.dataDir, "native-sessions");
        // A new native session never adopts a pre-existing directory or symlink.
        // After an interrupted creation, the SDK reservation remains unknown.
        await mkdir(sessionDir, { mode: 0o700 });
        native = RpcSession.spawn({
          name: ctx.initialization.bindingId,
          piBin: configuration.executable,
          cwd: ctx.initialization.workspace,
          sessionDir,
          resume: false,
          approve: false,
          model: configuration.model,
          noBuiltinTools: true,
          noExtensions: true,
          noSkills: true,
          bridgePath: fileURLToPath(
            new URL("./empty-extension.mjs", import.meta.url)
          ),
          isolatedEnv: configuration.environment,
          daemonUrl: "",
          childSecret: "",
          nativeProtocol: {
            maxFrameBytes: ctx.initialization.limits.maxFrameBytes,
            onError: loseObservation,
          },
          onEvent,
          onExit() {
            if (!stopping) loseObservation();
          },
        });
        nativeClosed = new Promise((resolve) =>
          native!.process.once("close", () => resolve())
        );
        const response = await native.request<JsonObject>(
          { type: "get_state" },
          ctx.initialization.limits.inspectTimeoutMs
        );
        if (
          !object(response.data) ||
          !nonempty(response.data.sessionId) ||
          response.data.isStreaming !== false ||
          response.data.pendingMessageCount !== 0 ||
          response.data.messageCount !== 0
        )
          throw new ProtocolError(
            "continuity_unverified",
            "Pi did not open an empty idle native session"
          );
        if (response.data.sessionFile !== undefined) {
          if (
            !nonempty(response.data.sessionFile) ||
            !isAbsolute(response.data.sessionFile)
          )
            throw new ProtocolError(
              "continuity_unverified",
              "Invalid native history identity"
            );
          const rel = relative(sessionDir, resolve(response.data.sessionFile));
          if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new ProtocolError(
              "continuity_unverified",
              "Native history escaped the assigned session directory"
            );
        }
        conversationId = params.conversationId;
        nativeReference = `pi:${response.data.sessionId}`;
        return { status: "opened", nativeReference, continuity: "unverified" };
      },
      async "operation.submit"(params, ctx) {
        if (
          !native ||
          !nativeReference ||
          !native.alive ||
          observationLost ||
          active
        )
          return { disposition: "unknown" };
        if (
          params.conversationId !== conversationId ||
          !nonempty(params.operationId) ||
          !nonempty(params.turnId) ||
          !Array.isArray(params.input) ||
          !params.input.length ||
          !params.input.every(
            (part) =>
              object(part) &&
              part.type === "text" &&
              typeof part.text === "string"
          )
        )
          return { disposition: "rejected" };
        const turn: Turn = {
          operationId: params.operationId,
          turnId: params.turnId,
          started: false,
          execution: "ended",
          order: 0,
        };
        active = turn;
        try {
          await native.request(
            {
              type: "prompt",
              message: params.input
                .map((part) => (part as JsonObject).text)
                .join("\n"),
            },
            ctx.initialization.limits.commandTimeoutMs
          );
          emit(
            "operation.disposition",
            { disposition: "accepted", evidence: "native_prompt_ack" },
            { operationId: turn.operationId, turnId: turn.turnId }
          );
          return { disposition: "accepted" };
        } catch (error) {
          if (error instanceof RpcCommandRejected && !turn.started) {
            active = undefined;
            return { disposition: "rejected" };
          }
          return { disposition: "unknown" };
        }
      },
      async "operation.cancel"(params, ctx) {
        if (
          !active ||
          params.targetOperationId !== active.operationId ||
          !native?.alive ||
          observationLost
        )
          return { status: "unknown" };
        try {
          await native.request(
            { type: "abort" },
            ctx.initialization.limits.commandTimeoutMs
          );
          return { status: "requested" };
        } catch {
          return { status: "unknown" };
        }
      },
    },
  });
  return runtime;
}
