import { createHash } from "node:crypto";
import { readFile, realpath, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { PiFleetBridge } from "./fleet-bridge.ts";
import {
  inspectPiHistory,
  piRuntimeSettings,
  samePiSettings,
  loadPiCheckpoint,
  savePiCheckpoint,
} from "./history.ts";
import {
  runPlugin,
  readArtifact,
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
  input: {
    text: true,
    mediaTypes: ["text/plain", "image/png", "image/jpeg"],
    maxMediaBytes: 512 * 1024,
  },
  sessions: { load: true, import: false, continuity: "verified" },
  output: { text: "snapshots", tools: true, usage: "unknown" },
  operations: {
    nativeDedupe: "none",
    nativeReplay: "none",
    cancel: "cooperative",
    steer: false,
  },
  interactions: { permissions: "none", questions: true },
  configuration: { model: true, thinking: true, compact: true },
  fleetTools: true,
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
  nativeStarted: boolean;
  tools: Map<string, boolean>;
  invoked: Set<string>;
  execution: "ended" | "failed" | "cancelled";
  order: number;
  message?: { id: string; text: string; revision: number };
}
interface PendingQuestion {
  id: string;
  descriptor: JsonObject;
  submitted: boolean;
}
interface CompactionControl {
  operationId: string;
  turnId: string;
  started: boolean;
  end?: JsonObject;
  acknowledge: (result: JsonObject) => void;
  done?: Promise<void>;
}

/** One private Pi RPC child per binding. SDK reservations precede all native effects. */
export function startPiAdapter(): PluginRuntime {
  let configuration: Configuration;
  let context: PluginContext;
  let native: RpcSession | undefined;
  let fleet: PiFleetBridge | undefined;
  let nativeClosed: Promise<void> | undefined;
  let conversationId: string | undefined;
  let nativeReference: string | undefined;
  let active: Turn | undefined;
  const questions = new Map<string, PendingQuestion>();
  let compacting: CompactionControl | undefined;
  let preparing = false;
  let settingsRevision = 0;
  let settling = false;
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
  const closeQuestions = (status: "expired" | "unknown") => {
    for (const question of questions.values()) {
      emit(
        "interaction.resolved",
        {
          ...question.descriptor,
          status: question.submitted ? "unknown" : status,
          ...(question.submitted
            ? { transport: "submitted", consumption: "unconfirmed" }
            : {}),
        },
        { interactionId: question.id }
      );
    }
    questions.clear();
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
  const markStarted = () => {
    if (!active) throw new Error("Uncorrelated native activity");
    if (active.started) return;
    emit("operation.disposition", {
      disposition: "accepted",
      evidence: "correlated_native_activity",
    });
    emit("turn.started", {});
    active.started = true;
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
  const stateOf = async () => {
    const response = await native!.request<JsonObject>(
      { type: "get_state" },
      context.initialization.limits.inspectTimeoutMs
    );
    const state = response.data;
    if (
      !object(state) ||
      `pi:${state.sessionId}` !== nativeReference ||
      !Number.isSafeInteger(state.messageCount) ||
      Number(state.messageCount) < 0
    )
      throw new Error("Unverified native session state");
    piRuntimeSettings(state);
    return state;
  };
  const retainSettings = async (state: JsonObject) => {
    // Pi does not flush a fresh session until its first assistant message.
    // There is no restorable history to claim for an untouched conversation.
    if (state.messageCount === 0) return;
    if (
      !nonempty(state.sessionFile) ||
      state.isStreaming !== false ||
      state.pendingMessageCount !== 0
    )
      throw new Error("Native history not settled");
    const history = await inspectPiHistory(
      join(context.initialization.dataDir, "native-sessions"),
      state.sessionFile,
      String(state.sessionId),
      context.initialization.workspace
    );
    await savePiCheckpoint(context.initialization.dataDir, {
      version: 1,
      bindingId: context.initialization.bindingId,
      conversationId: conversationId!,
      messageCount: Number(state.messageCount),
      settings: piRuntimeSettings(state),
      history,
    });
  };
  const thinkingLevels = async (): Promise<string[]> => {
    const response = await native!.request<JsonObject>(
      { type: "get_available_thinking_levels" },
      context.initialization.limits.inspectTimeoutMs
    );
    const levels = object(response.data) ? response.data.levels : undefined;
    if (
      !Array.isArray(levels) ||
      levels.length < 1 ||
      levels.length > 6 ||
      !levels.every(
        (level) =>
          typeof level === "string" &&
          ["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)
      ) ||
      new Set(levels).size !== levels.length
    )
      throw new Error("Invalid native thinking levels");
    return levels as string[];
  };
  const modelCatalog = async () => {
    const response = await native!.request<JsonObject>(
      { type: "get_available_models" },
      context.initialization.limits.inspectTimeoutMs
    );
    if (
      !object(response.data) ||
      !Array.isArray(response.data.models) ||
      response.data.models.length > 4096
    )
      throw new Error("Invalid native model catalog");
    const catalog = response.data.models.map((model) => {
      if (
        !object(model) ||
        !nonempty(model.provider) ||
        !nonempty(model.id) ||
        model.provider.length > 512 ||
        model.id.length > 512 ||
        model.provider.includes("\0") ||
        model.id.includes("\0")
      )
        throw new Error("Invalid native model identity");
      return {
        model: `${model.provider}/${model.id}`,
        provider: model.provider,
        modelId: model.id,
      };
    });
    if (new Set(catalog.map((model) => model.model)).size !== catalog.length)
      throw new Error("Ambiguous native model identity");
    return catalog;
  };
  const onEvent = (event: RpcEvent) => {
    if (stopping || observationLost) return;
    try {
      if (event.kind === "event") {
        if (
          compacting &&
          event.raw.reason === "manual" &&
          ["compaction_start", "compaction_end"].includes(
            String(event.raw.type)
          )
        ) {
          const control = compacting;
          const identity = {
            operationId: control.operationId,
            turnId: control.turnId,
          };
          if (event.raw.type === "compaction_start") {
            if (control.started)
              throw new Error("Duplicate native compaction start");
            control.started = true;
            emit(
              "operation.disposition",
              { disposition: "accepted", evidence: "native_compaction_start" },
              identity
            );
            emit("turn.started", {}, identity);
            control.acknowledge({ disposition: "accepted" });
          } else {
            if (
              !control.started ||
              control.end ||
              typeof event.raw.aborted !== "boolean" ||
              event.raw.willRetry !== false
            )
              throw new Error("Uncorrelated compaction end");
            control.end = event.raw;
          }
          return;
        }
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
      if (event.kind === "ui_request") {
        if (
          !active ||
          !active.started ||
          !active.nativeStarted ||
          !["select", "confirm", "input", "editor"].includes(event.method) ||
          event.invalidTimeout ||
          questions.has(event.id) ||
          questions.size >= 16
        )
          throw new Error("Uncorrelated native UI request");
        const descriptor: JsonObject = {
          kind: "question",
          bindingId: context.initialization.bindingId,
          instanceId: context.initialization.instanceId,
          operationId: active.operationId,
          turnId: active.turnId,
          interactionId: event.id,
          revision: "1",
          optionsDigest: `sha256:${createHash("sha256")
            .update(
              JSON.stringify([
                event.method,
                event.title,
                event.options ?? [],
                event.message ?? "",
                event.placeholder ?? "",
                event.prefill ?? "",
              ])
            )
            .digest("hex")}`,
          method: event.method,
          title: event.title,
          ...(event.options ? { options: event.options } : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
          ...(event.placeholder !== undefined
            ? { placeholder: event.placeholder }
            : {}),
          ...(event.prefill !== undefined ? { prefill: event.prefill } : {}),
          ...(event.timeoutMs !== undefined
            ? {
                expiresAt: new Date(Date.now() + event.timeoutMs).toISOString(),
              }
            : {}),
        };
        questions.set(event.id, { id: event.id, descriptor, submitted: false });
        emit("interaction.requested", descriptor, { interactionId: event.id });
        return;
      }
      if (!active)
        throw new Error("Native output without an admitted operation");
      if (event.kind === "agent_start") {
        if (active.nativeStarted)
          throw new Error("Unrequested native follow-up");
        active.nativeStarted = true;
        markStarted();
      } else if (event.kind === "tool_start") {
        if (
          !active.nativeStarted ||
          !["fleet_send", "fleet_discover", "ask_user_question"].includes(
            event.toolName
          ) ||
          !nonempty(event.toolCallId) ||
          active.tools.has(event.toolCallId) ||
          active.tools.size >= 4096
        )
          throw new Error("Invalid native tool start");
        active.tools.set(event.toolCallId, false);
        emit(
          "tool.started",
          {
            label:
              event.toolName === "fleet_send"
                ? "Send fleet task"
                : event.toolName === "fleet_discover"
                  ? "Discover fleet peers"
                  : "Ask user a question",
            state: "running",
          },
          { toolCallId: event.toolCallId }
        );
      } else if (event.kind === "tool_end" || event.kind === "tool_output") {
        if (active.tools.get(event.toolCallId) !== false)
          throw new Error("Uncorrelated native tool result");
        if (event.kind === "tool_end") {
          active.tools.set(event.toolCallId, true);
          emit(
            "tool.finished",
            { state: event.isError ? "error" : "ended" },
            { toolCallId: event.toolCallId }
          );
        }
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
        if (
          settling ||
          !active.started ||
          !active.nativeStarted ||
          active.message ||
          [...active.tools.values()].some((finished) => !finished) ||
          [...active.invoked].some((id) => active!.tools.get(id) !== true)
        )
          throw new Error("Incomplete native turn observation");
        settling = true;
        const turn = active;
        void (async () => {
          const response = await native!.request<JsonObject>(
            { type: "get_state" },
            context.initialization.limits.inspectTimeoutMs
          );
          const state = response.data;
          if (
            !object(state) ||
            `pi:${state.sessionId}` !== nativeReference ||
            !nonempty(state.sessionFile) ||
            state.isStreaming !== false ||
            state.pendingMessageCount !== 0 ||
            !Number.isSafeInteger(state.messageCount) ||
            Number(state.messageCount) < 1
          )
            throw new Error("Native history not settled");
          await retainSettings(state);
          if (stopping || observationLost || active !== turn) return;
          closeQuestions("expired");
          emit("turn.terminal", {
            execution: turn.execution,
            observation: "complete",
            evidence: "native_agent_settled",
          });
          fleet?.finishPrompt(turn.operationId);
          active = undefined;
          settling = false;
        })().catch(loseObservation);
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
        while (
          (active || compacting) &&
          !observationLost &&
          Date.now() < info.deadline - 100
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      stopping = true;
      const compactDone = compacting?.done;
      fleet?.close();
      if (!native) return { ownedResourcesStopped: true };
      native.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stopped = await Promise.race([
          nativeClosed!.then(async () => {
            await compactDone;
            return true;
          }),
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
        if (params.mode !== "new" && params.mode !== "load")
          throw new ProtocolError(
            "continuity_unverified",
            "Pi requires explicit new or load mode"
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
        const checkpoint =
          params.mode === "load"
            ? await loadPiCheckpoint(
                ctx.initialization.dataDir,
                ctx.initialization.bindingId,
                params.conversationId,
                params.nativeReference,
                ctx.initialization.workspace
              )
            : undefined;
        if (!checkpoint) await mkdir(sessionDir, { mode: 0o700 });
        native = RpcSession.spawn({
          name: ctx.initialization.bindingId,
          piBin: configuration.executable,
          cwd: ctx.initialization.workspace,
          sessionDir,
          resume: false,
          sessionFile: checkpoint?.history.file,
          approve: false,
          model: checkpoint ? undefined : configuration.model,
          noBuiltinTools: true,
          noExtensions: true,
          noSkills: true,
          bridgePath: fileURLToPath(
            new URL("./fleet-extension.mjs", import.meta.url)
          ),
          tools: ["fleet_discover", "fleet_send", "ask_user_question"],
          isolatedEnv: configuration.environment,
          daemonUrl: "",
          childSecret: "",
          nativeProtocol: {
            maxFrameBytes: ctx.initialization.limits.maxFrameBytes,
            onError: loseObservation,
            privateControl: true,
          },
          onEvent,
          onExit() {
            if (!stopping) loseObservation();
          },
        });
        nativeClosed = new Promise((resolve) =>
          native!.process.once("close", () => resolve())
        );
        fleet = new PiFleetBridge(native.process.stdio[3] as Duplex, ctx, {
          onFailure: loseObservation,
          onActivity(scope, tool) {
            if (
              !active ||
              observationLost ||
              stopping ||
              scope.operationId !== active.operationId ||
              scope.turnId !== active.turnId
            )
              throw new Error("Uncorrelated native fleet call");
            markStarted();
            active.invoked.add(tool.toolCallId);
          },
        });
        const fleetSessionId = await fleet.initialize();
        const response = await native.request<JsonObject>(
          { type: "get_state" },
          ctx.initialization.limits.inspectTimeoutMs
        );
        if (
          !object(response.data) ||
          !nonempty(response.data.sessionId) ||
          response.data.sessionId !== fleetSessionId ||
          response.data.isStreaming !== false ||
          response.data.pendingMessageCount !== 0 ||
          response.data.messageCount !== (checkpoint?.messageCount ?? 0) ||
          (checkpoint &&
            (!samePiSettings(response.data, checkpoint.settings) ||
              response.data.sessionId !== checkpoint.history.sessionId ||
              response.data.sessionFile !== checkpoint.history.file))
        )
          throw new ProtocolError(
            "continuity_unverified",
            "Pi did not open the expected idle native session"
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
        if (checkpoint)
          await inspectPiHistory(
            sessionDir,
            checkpoint.history.file,
            checkpoint.history.sessionId,
            ctx.initialization.workspace,
            checkpoint.history
          );
        nativeReference = `pi:${response.data.sessionId}`;
        return {
          status: "opened",
          nativeReference,
          continuity: checkpoint ? "verified" : "unverified",
        };
      },
      async "session.snapshot"(params) {
        if (
          !native?.alive ||
          observationLost ||
          stopping ||
          preparing ||
          params.conversationId !== conversationId
        )
          return {
            disposition: "unknown",
            observation: "reconciliation_required",
          };
        const revision = settingsRevision;
        const models = await modelCatalog();
        const levels = await thinkingLevels();
        const state = await stateOf();
        const settings = piRuntimeSettings(state);
        if (
          revision !== settingsRevision ||
          preparing ||
          observationLost ||
          stopping
        )
          return {
            disposition: "unknown",
            observation: "reconciliation_required",
          };
        return {
          disposition: "known",
          observation: "complete",
          nativeReference,
          settings: {
            model: `${settings.provider}/${settings.modelId}`,
            thinking: settings.thinkingLevel,
          },
          models: models.map(({ model }) => ({ model })),
          thinkingLevels: levels,
          idle:
            !active &&
            !preparing &&
            state.isStreaming === false &&
            state.pendingMessageCount === 0,
        };
      },
      async "session.configure"(params) {
        if (
          params.conversationId !== conversationId ||
          (params.kind !== "model" && params.kind !== "thinking") ||
          (params.kind === "model"
            ? !nonempty(params.model)
            : !nonempty(params.thinking))
        )
          return { disposition: "rejected", status: "failed" };
        if (!native?.alive || !nativeReference || observationLost || stopping)
          return { disposition: "unknown", status: "unknown" };
        if (active || preparing)
          return { disposition: "rejected", status: "failed" };
        preparing = true;
        settingsRevision++;
        let entered = false;
        try {
          const before = await stateOf();
          if (
            before.isStreaming !== false ||
            before.pendingMessageCount !== 0 ||
            before.isCompacting === true
          )
            return { disposition: "rejected", status: "failed" };
          const previous = piRuntimeSettings(before);
          let command: JsonObject;
          let expected = previous;
          if (params.kind === "model") {
            const model = (await modelCatalog()).find(
              (model) => model.model === params.model
            );
            if (!model) return { disposition: "rejected", status: "failed" };
            expected = {
              ...previous,
              provider: model.provider,
              modelId: model.modelId,
            };
            command = {
              type: "set_model",
              provider: model.provider,
              modelId: model.modelId,
            };
          } else {
            if (!(await thinkingLevels()).includes(String(params.thinking)))
              return { disposition: "rejected", status: "failed" };
            expected = { ...previous, thinkingLevel: String(params.thinking) };
            command = { type: "set_thinking_level", level: params.thinking };
          }
          if (stopping || context.signal.aborted)
            return { disposition: "rejected", status: "failed" };
          entered = true;
          await native.request(
            command,
            context.initialization.limits.commandTimeoutMs
          );
          const after = await stateOf();
          const settings = piRuntimeSettings(after);
          // Model selection can legitimately clamp thinking to the new model's capabilities.
          if (
            settings.provider !== expected.provider ||
            settings.modelId !== expected.modelId ||
            (params.kind === "thinking" &&
              settings.thinkingLevel !== expected.thinkingLevel) ||
            after.messageCount !== before.messageCount ||
            after.isStreaming !== false ||
            after.pendingMessageCount !== 0 ||
            after.isCompacting === true
          )
            throw new Error("Native settings readback mismatch");
          await retainSettings(after);
          if (stopping || observationLost)
            return { disposition: "unknown", status: "unknown" };
          return {
            disposition: "accepted",
            status: "applied",
            settings: {
              model: `${settings.provider}/${settings.modelId}`,
              thinking: settings.thinkingLevel,
            },
          };
        } catch {
          if (entered) {
            // A lost or rejected RPC response may follow a native settings write.
            // Keep its reservation unknown and stop; never resend it automatically.
            loseObservation();
            return { disposition: "unknown", status: "unknown" };
          }
          return { disposition: "rejected", status: "failed" };
        } finally {
          preparing = false;
        }
      },
      async "session.compact"(params) {
        if (
          params.conversationId !== conversationId ||
          !nonempty(params.operationId) ||
          !nonempty(params.turnId)
        )
          return { disposition: "rejected", status: "failed" };
        if (!native?.alive || !nativeReference || observationLost || stopping)
          return { disposition: "unknown" };
        if (active || preparing || compacting)
          return { disposition: "rejected", status: "failed" };
        preparing = true;
        let before: JsonObject;
        let previous: Awaited<ReturnType<typeof inspectPiHistory>>;
        try {
          before = await stateOf();
          if (
            before.isStreaming !== false ||
            before.isCompacting !== false ||
            before.pendingMessageCount !== 0 ||
            Number(before.messageCount) < 1 ||
            !nonempty(before.sessionFile)
          )
            throw new Error("Compaction requires settled history");
          previous = await inspectPiHistory(
            join(context.initialization.dataDir, "native-sessions"),
            before.sessionFile,
            String(before.sessionId),
            context.initialization.workspace
          );
          if (stopping || observationLost || context.signal.aborted)
            throw new Error("Session stopping");
        } catch {
          preparing = false;
          return { disposition: "rejected", status: "failed" };
        }
        let acknowledge!: (result: JsonObject) => void;
        const acceptance = new Promise<JsonObject>((resolve) => {
          acknowledge = resolve;
        });
        const control: CompactionControl = {
          operationId: params.operationId,
          turnId: params.turnId,
          started: false,
          acknowledge,
        };
        compacting = control;
        const identity = {
          operationId: control.operationId,
          turnId: control.turnId,
        };
        control.done = (async () => {
          try {
            let response: JsonObject | undefined;
            let rejected = false;
            try {
              // Native execution outlives the admission RPC; completion is a durable event.
              const reply = await native!.request<JsonObject>(
                { type: "compact" },
                5 * 60_000
              );
              if (!object(reply.data))
                throw new Error("Missing native compaction result");
              response = reply.data;
            } catch (error) {
              if (!(error instanceof RpcCommandRejected)) throw error;
              rejected = true;
            }
            if (stopping || observationLost) return;
            const after = await stateOf();
            if (
              !control.started ||
              !control.end ||
              after.isStreaming !== false ||
              after.isCompacting !== false ||
              after.pendingMessageCount !== 0 ||
              !samePiSettings(after, piRuntimeSettings(before)) ||
              after.sessionFile !== previous.file
            )
              throw new Error("Compaction observation incomplete");
            let execution: "ended" | "failed" | "cancelled";
            if (rejected) {
              if (
                control.end.result !== undefined ||
                after.messageCount !== before.messageCount
              )
                throw new Error("Compaction rejection changed context");
              await inspectPiHistory(
                join(context.initialization.dataDir, "native-sessions"),
                previous.file,
                previous.sessionId,
                context.initialization.workspace,
                previous
              );
              execution = control.end.aborted === true ? "cancelled" : "failed";
            } else {
              if (
                control.end.aborted !== false ||
                !response ||
                !nonempty(response.summary) ||
                !nonempty(response.firstKeptEntryId) ||
                !Number.isSafeInteger(response.tokensBefore) ||
                Number(response.tokensBefore) < 0 ||
                Number(after.messageCount) < 1 ||
                !object(control.end.result) ||
                control.end.result.summary !== response.summary ||
                control.end.result.firstKeptEntryId !==
                  response.firstKeptEntryId ||
                control.end.result.tokensBefore !== response.tokensBefore
              )
                throw new Error(
                  "Compaction result differs from native completion"
                );
              await inspectPiHistory(
                join(context.initialization.dataDir, "native-sessions"),
                previous.file,
                previous.sessionId,
                context.initialization.workspace,
                undefined,
                {
                  previous,
                  summary: response.summary,
                  firstKeptEntryId: response.firstKeptEntryId,
                  tokensBefore: Number(response.tokensBefore),
                }
              );
              await retainSettings(after);
              execution = "ended";
            }
            if (stopping || observationLost) return;
            emit(
              "turn.terminal",
              {
                execution,
                observation: "complete",
                result: {
                  status:
                    execution === "ended"
                      ? "applied"
                      : execution === "cancelled"
                        ? "cancelled"
                        : "failed",
                },
                evidence: "native_compaction_history_verified",
              },
              identity
            );
          } catch {
            if (!stopping) loseObservation();
          } finally {
            acknowledge({ disposition: "unknown" });
            if (compacting === control) compacting = undefined;
            preparing = false;
          }
        })();
        return acceptance;
      },
      async "operation.submit"(params, ctx) {
        if (
          !native ||
          !nativeReference ||
          !native.alive ||
          observationLost ||
          stopping ||
          preparing ||
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
              ((part.type === "text" && typeof part.text === "string") ||
                (part.type === "artifact" &&
                  ["text/plain", "image/png", "image/jpeg"].includes(
                    String(part.mediaType)
                  )))
          )
        )
          return { disposition: "rejected" };
        let message: string;
        const images: Array<{ type: "image"; data: string; mimeType: string }> =
          [];
        preparing = true;
        try {
          const parts: string[] = [];
          for (const part of params.input as JsonObject[]) {
            if (part.type === "text") parts.push(String(part.text));
            else {
              const bytes = await readArtifact(
                ctx,
                params.operationId,
                part,
                512 * 1024
              );
              if (part.mediaType !== "text/plain") {
                images.push({
                  type: "image",
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: String(part.mediaType),
                });
                continue;
              }
              const text = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes
              );
              if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
                throw new Error();
              parts.push(
                `Attached file (user-provided data):\n${JSON.stringify({ name: part.name, mediaType: part.mediaType, text })}`
              );
            }
          }
          message = parts.join("\n");
          if (
            Buffer.byteLength(
              JSON.stringify({
                type: "prompt",
                message,
                ...(images.length ? { images } : {}),
              }),
              "utf8"
            ) >
            ctx.initialization.limits.maxFrameBytes - 256
          )
            return { disposition: "rejected" };
        } catch {
          // Artifact reads precede native activation: failure proves no prompt was sent.
          return { disposition: "rejected" };
        } finally {
          preparing = false;
        }
        if (stopping || ctx.signal.aborted || !native.alive)
          return { disposition: "rejected" };
        const turn: Turn = {
          operationId: params.operationId,
          turnId: params.turnId,
          started: false,
          nativeStarted: false,
          tools: new Map(),
          invoked: new Set(),
          execution: "ended",
          order: 0,
        };
        active = turn;
        try {
          await fleet!.activate(turn.operationId, turn.turnId);
          await native.request(
            {
              type: "prompt",
              message,
              ...(images.length ? { images } : {}),
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
            await fleet!.rejectPrompt(turn.operationId);
            active = undefined;
            return { disposition: "rejected" };
          }
          return { disposition: "unknown" };
        }
      },
      async "interaction.respond"(params) {
        if (
          !native?.alive ||
          observationLost ||
          stopping ||
          params.kind !== "question" ||
          !nonempty(params.interactionId)
        )
          return { status: "unknown" };
        const question = questions.get(String(params.interactionId));
        if (!question || question.submitted) return { status: "expired" };
        const descriptor = question.descriptor;
        for (const key of [
          "bindingId",
          "instanceId",
          "targetOperationId",
          "turnId",
          "interactionId",
          "optionsDigest",
          "revision",
        ]) {
          const expected =
            descriptor[key === "targetOperationId" ? "operationId" : key];
          if (params[key] !== expected) return { status: "stale" };
        }
        if (descriptor.method === "confirm") {
          if (
            typeof params.confirmed !== "boolean" ||
            params.cancelled !== undefined
          )
            return { status: "unsupported" };
        } else if (
          params.cancelled !== true &&
          (typeof params.value !== "string" ||
            (descriptor.method === "select" &&
              !(descriptor.options as string[]).includes(params.value)))
        )
          return { status: "unsupported" };
        try {
          native.respondUi(
            String(params.interactionId),
            params.cancelled === true
              ? { cancel: true }
              : descriptor.method === "confirm"
                ? { confirmed: Boolean(params.confirmed) }
                : { value: String(params.value) }
          );
          question.submitted = true;
          return {
            status: "unknown",
            transport: "submitted",
            consumption: "unconfirmed",
          };
        } catch {
          loseObservation();
          return { status: "unknown" };
        }
      },
      async "operation.cancel"(params, ctx) {
        if (
          (!active && !compacting) ||
          params.targetOperationId !==
            (active?.operationId ?? compacting?.operationId) ||
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
