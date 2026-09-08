import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  runPlugin,
  type PluginContext,
  type PluginRuntime,
  type CapabilityDescriptor,
} from "@mobrienv/pi-tidy-bots/plugin-sdk";
import {
  nonempty,
  object,
  ProtocolError,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";
import {
  openCodexRuntime,
  validateCodexConfiguration,
  type CodexRuntime,
} from "./runtime.ts";

// Load is fail-closed identity proof only: isolated CODEX_HOME
// (profile_dir, not Unix HOME) + exact thread id.
// That is not Pi/Hermes retained-history verification. Never-prompted seats
// stay non-restorable (Codex unprompted threads may lack a resumable rollout).
export const CODEX_CAPABILITIES: CapabilityDescriptor = {
  input: { text: true, mediaTypes: [], maxMediaBytes: 0 },
  sessions: {
    load: true,
    import: false,
    continuity: "verified",
    proof: "identity-only",
    emptySeat: "non-restorable",
  },
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

export function startCodexAdapter(): PluginRuntime {
  let native: CodexRuntime | undefined;
  let opening = false;
  let stopping = false;
  let preparing = false;
  let lost = false;
  let conversationId: string | undefined;
  let active: Promise<unknown> | undefined;
  let activeTurn: { operationId: string; turnId: string } | undefined;
  const launches = new Set<string>();
  const runtime = runPlugin({
    identity: { id: "tidy.codex", version: "0.1.0-dev" },
    runtime: { name: "codex", version: "0.145.0", transport: "app-server" },
    capabilities: CODEX_CAPABILITIES,
    async onInitialize(ctx) {
      await validateCodexConfiguration(ctx.initialization.config);
      const services = ctx.initialization.ownershipServices;
      if (
        !Array.isArray(services) ||
        !["prepare", "record", "inspect", "stopped"].every((method) =>
          services.includes(`ownership.${method}`)
        )
      )
        throw new ProtocolError(
          "capability_unavailable",
          "Codex requires granted durable child ownership services"
        );
    },
    async onClose(info, ctx) {
      stopping = true;
      if (info.mode === "drain" && active) await active;
      await native?.close();
      for (const launchId of [...launches].reverse()) {
        while (true) {
          try {
            const result = (await ctx.ownedProcess("stopped", {
              launchId,
            })) as { state?: string };
            if (result.state !== "stopped")
              return { ownedResourcesStopped: false };
            break;
          } catch (error) {
            if (
              !(error instanceof ProtocolError) ||
              error.code !== "ownership_unreconciled" ||
              Date.now() + 25 >= info.deadline
            )
              return { ownedResourcesStopped: false };
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
      }
      return { ownedResourcesStopped: !opening || native !== undefined };
    },
    handlers: {
      async "session.open"(params, ctx) {
        if (params.mode !== "new" && params.mode !== "load")
          throw new ProtocolError(
            "continuity_unverified",
            "Codex requires an explicit new or load mode"
          );
        if (
          opening ||
          stopping ||
          lost ||
          !nonempty(params.conversationId) ||
          !nonempty(params.cwd) ||
          (await realpath(params.cwd)) !==
            (await realpath(ctx.initialization.workspace))
        )
          throw new ProtocolError(
            "session_unavailable",
            "Codex requires one session in the binding workspace"
          );
        opening = true;
        const ownedContext: PluginContext = {
          ...ctx,
          ownedProcess: (method, values) => {
            if (method === "prepare" && nonempty(values.launchId))
              launches.add(values.launchId);
            return ctx.ownedProcess(method, values);
          },
        };
        if (
          params.mode === "load" &&
          (typeof params.nativeReference !== "string" ||
            !params.nativeReference.startsWith("codex:") ||
            params.nativeReference.length <= 6)
        )
          throw new ProtocolError(
            "continuity_unverified",
            "Codex load requires an exact native reference"
          );
        native = await openCodexRuntime(
          ownedContext,
          `tidy-launch-${randomUUID()}`,
          ctx.initialization.config,
          {
            ...(params.mode === "load"
              ? { nativeReference: String(params.nativeReference).slice(6) }
              : {}),
            onFailure() {
              if (lost || stopping) return;
              lost = true;
              try {
                if (activeTurn)
                  ctx.emit({
                    type: "observation.gap",
                    operationId: activeTurn.operationId,
                    turnId: activeTurn.turnId,
                    payload: { code: "native_observation_gap" },
                  });
              } finally {
                void runtime.close("native_observation_gap");
              }
            },
          }
        );
        conversationId = params.conversationId;
        return {
          status: "opened",
          nativeReference: `codex:${native.nativeReference}`,
          continuity: params.mode === "load" ? "verified" : "unverified",
          proof: params.mode === "load" ? "identity-only" : "none",
          diagnostics: native.diagnostics,
          ...(params.mode === "load"
            ? {
                evidence: {
                  provenance: "codex-thread-identity",
                  expectedHome: true,
                  codexHome: native.diagnostics.codexHome,
                  threadId: native.nativeReference,
                },
              }
            : {}),
        };
      },
      async "operation.submit"(params, ctx) {
        if (!native || active || preparing || stopping || lost)
          return { disposition: "unknown" };
        if (
          params.conversationId !== conversationId ||
          !nonempty(params.operationId) ||
          !nonempty(params.turnId)
        )
          return { disposition: "rejected" };
        const input: JsonObject[] = [];
        preparing = true;
        try {
          if (!Array.isArray(params.input) || !params.input.length)
            return { disposition: "rejected" };
          for (const part of params.input) {
            if (!object(part)) return { disposition: "rejected" };
            if (part.type === "text" && typeof part.text === "string")
              input.push({ type: "text", text: part.text });
            else return { disposition: "rejected" };
          }
          if (
            Buffer.byteLength(JSON.stringify(input), "utf8") >
            ctx.initialization.limits.maxFrameBytes - 1024
          )
            return { disposition: "rejected" };
        } catch {
          return { disposition: "rejected" };
        } finally {
          preparing = false;
        }
        if (stopping || lost || ctx.signal.aborted)
          return { disposition: "rejected" };
        let admit!: (value: {
          disposition: "accepted" | "rejected" | "unknown";
        }) => void;
        const admission = new Promise<{
          disposition: "accepted" | "rejected" | "unknown";
        }>((resolve) => {
          admit = resolve;
        });
        activeTurn = {
          operationId: params.operationId,
          turnId: params.turnId,
        };
        const completion = native.session.submit(
          params.operationId,
          params.turnId,
          input,
          () => admit({ disposition: "accepted" })
        );
        active = completion;
        void completion
          .then(admit, () => admit({ disposition: "unknown" }))
          .finally(() => {
            if (active === completion) {
              active = undefined;
              activeTurn = undefined;
            }
          });
        const timer = setTimeout(
          () => admit({ disposition: "unknown" }),
          Math.max(1, ctx.initialization.limits.commandTimeoutMs - 100)
        );
        try {
          return await admission;
        } finally {
          clearTimeout(timer);
        }
      },
      "operation.cancel": (params) =>
        native?.cancel(params) ?? { status: "unknown" },
    },
  });
  return runtime;
}
