import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  runPlugin,
  readArtifact,
  ProtocolError,
  type PluginContext,
  type PluginRuntime,
  type CapabilityDescriptor,
} from "@mobrienv/pi-tidy-bots/plugin-sdk";
import {
  nonempty,
  object,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";
import {
  openHermesRuntime,
  validateHermesConfiguration,
  type HermesRuntime,
} from "./runtime.ts";

// Fresh guarded ACP sessions only. Native continuity, media and
// non-pipe worker profiles require their remaining conformance work.
export const HERMES_CAPABILITIES: CapabilityDescriptor = {
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
  interactions: { permissions: "exact-request", questions: false },
  configuration: { model: false, thinking: false, compact: false },
  fleetTools: true,
};

export function startHermesAdapter(): PluginRuntime {
  let native: HermesRuntime | undefined;
  let opening = false;
  let stopping = false;
  let preparing = false;
  let lost = false;
  let conversationId: string | undefined;
  let active: Promise<unknown> | undefined;
  let activeTurn: { operationId: string; turnId: string } | undefined;
  const launches = new Set<string>();
  const runtime = runPlugin({
    identity: { id: "tidy.hermes", version: "0.1.0-dev" },
    runtime: { name: "hermes", version: "0.20.5", transport: "acp" },
    capabilities: HERMES_CAPABILITIES,
    async onInitialize(ctx) {
      await validateHermesConfiguration(ctx.initialization.config);
      const services = ctx.initialization.ownershipServices;
      if (
        !Array.isArray(services) ||
        !["prepare", "record", "inspect", "stopped"].every((method) =>
          services.includes(`ownership.${method}`)
        )
      )
        throw new ProtocolError(
          "capability_unavailable",
          "Hermes requires granted durable child ownership services"
        );
    },
    async onClose(info, ctx) {
      stopping = true;
      if (info.mode === "drain" && active) await active;
      await native?.close();
      // Children are registered before activation. A wrapper exit alone cannot
      // certify detached groups; the host checks each retained launch identity.
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
            "Hermes requires an explicit new or load mode"
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
            "Hermes requires one fresh session in the binding workspace"
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
            !params.nativeReference.startsWith("hermes:") ||
            params.nativeReference.length <= 7)
        )
          throw new ProtocolError(
            "continuity_unverified",
            "Hermes load requires an exact native reference"
          );
        native = await openHermesRuntime(
          ownedContext,
          `tidy-launch-${randomUUID()}`,
          ctx.initialization.config,
          {
            fleetTools: true,
            ...(params.mode === "load"
              ? { nativeReference: String(params.nativeReference).slice(7) }
              : {}),
            onFailure() {
              if (lost || stopping) return;
              lost = true;
              try {
                // Startup has no admitted operation to reconcile. Emitting an
                // uncorrelated gap would itself be rejected by the gateway and
                // hide the native startup failure. Once a prompt is admitted,
                // retain its exact identity for the durable gap projection.
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
          nativeReference: `hermes:${native.nativeReference}`,
          continuity: params.mode === "load" ? "verified" : "unverified",
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
            else if (
              part.type === "artifact" &&
              ["text/plain", "image/png", "image/jpeg"].includes(
                String(part.mediaType)
              )
            ) {
              const bytes = await readArtifact(
                ctx,
                params.operationId,
                part,
                512 * 1024
              );
              if (part.mediaType !== "text/plain") {
                input.push({
                  type: "image",
                  mimeType: part.mediaType,
                  data: Buffer.from(bytes).toString("base64"),
                });
                continue;
              }
              const text = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes
              );
              if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
                throw new Error();
              input.push({
                type: "text",
                text: `Attached file (user-provided data):\n${JSON.stringify({ name: part.name, mediaType: part.mediaType, text })}`,
              });
            } else return { disposition: "rejected" };
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
        // Admission uncertainty is retained without timing out the native turn.
        // Its later correlated events remain the only execution evidence.
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
      "interaction.respond": (params) =>
        native?.respond(params) ?? { status: "expired" },
    },
  });
  return runtime;
}
