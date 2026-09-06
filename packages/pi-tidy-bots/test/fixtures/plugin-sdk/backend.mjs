#!/usr/bin/env node
import { appendFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runPlugin, spawnOwnedProcess } from "SDK_INDEX_URL";
const { HermesInteractions } = await import("HERMES_INTERACTIONS_URL");

let ownedChild;
let ownedLaunchId;
let ownedHandle;
let interactions;
const log = (value) => {
  const file = openSync(
    join(process.env.TIDY_DATA_DIR, "native-effects.jsonl"),
    "a"
  );
  try {
    appendFileSync(file, JSON.stringify(value) + "\n");
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
};
const capabilities = {
  input: { text: true, mediaTypes: [], maxMediaBytes: 0 },
  sessions: { load: false, import: false, continuity: "unverified" },
  output: { text: "snapshots", tools: false, usage: "unknown" },
  operations: {
    nativeDedupe: "none",
    nativeReplay: "none",
    cancel: "cooperative",
    steer: false,
  },
  interactions: { permissions: "exact-request", questions: false },
  configuration: { model: true, thinking: false, compact: false },
  fleetTools: true,
};
const runtime = runPlugin({
  identity: { id: "org.example.sdk-fixture", version: "1.0.0" },
  runtime: { name: "sdk-native-fixture", version: "1.0.0" },
  capabilities,
  ownership: process.env.FIXTURE_OWNERSHIP ?? "owned",
  onInitialize(ctx) {
    if (ctx.initialization.config.mode?.startsWith("hermes-")) {
      interactions = new HermesInteractions(ctx, {
        timeoutMs:
          ctx.initialization.config.mode === "hermes-lost-receipt" ? 150 : 3000,
        onFailure: () => {
          void runtime.close("permission_observation_gap");
        },
      });
    }
    if (ctx.initialization.config.mode === "owned-child") {
      ownedChild = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" }
      );
      log({ childPid: ownedChild.pid });
    }
  },
  async onClose(info, ctx) {
    interactions?.close();
    log({
      close: info.reason,
      ownership: info.ownership,
      mode: info.mode,
      signalAborted: ctx.signal.aborted,
    });
    if (ctx.initialization.config.mode === "stuck-cleanup")
      await new Promise(() => {});
    if (
      ownedChild &&
      ownedChild.exitCode === null &&
      ownedChild.signalCode === null
    ) {
      const exit = new Promise((resolve) => ownedChild.once("close", resolve));
      if (ownedHandle) await ownedHandle.close();
      else ownedChild.kill("SIGTERM");
      await exit;
    }
    return { ownedResourcesStopped: true };
  },
  handlers: {
    async "session.open"(params, ctx) {
      log({ method: "session.open", openId: params.openId });
      if (ctx.initialization.config.mode === "registered-child") {
        ownedLaunchId = `tidy-launch-${randomUUID()}`;
        log({ ownedLaunchId });
        // A caller environment must never preload code in the trusted wrapper.
        process.env.NODE_OPTIONS = `--require=${join(ctx.initialization.dataDir, "preload.cjs")}`;
        ownedHandle = await spawnOwnedProcess(ctx, {
          launchId: ownedLaunchId,
          executable: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(join(ctx.initialization.dataDir, "child-effect"))},'started');setInterval(()=>{},1000)`,
          ],
          cwd: ctx.initialization.workspace,
          environment: {},
        });
        ownedChild = ownedHandle.child;
        ownedChild.stdout.resume();
        ownedChild.stderr.resume();
      }
      if (ctx.initialization.config.mode === "crash-open")
        process.kill(process.pid, "SIGKILL");
      return { status: "opened", nativeReference: `native:${params.openId}` };
    },
    async "session.snapshot"(_params, ctx) {
      if (ownedLaunchId)
        return ctx.ownedProcess("inspect", { launchId: ownedLaunchId });
      return {
        disposition: "unknown",
        observation: ctx.store.observationGap
          ? "reconciliation_required"
          : "complete",
        lastSourceSequence: ctx.store.watermark,
      };
    },
    async "operation.submit"(params, ctx) {
      log({ method: "operation.submit", operationId: params.operationId });
      const text = params.input[0].text;
      if (text === "[crash]") process.kill(process.pid, "SIGKILL");
      if (text === "[hang]") await new Promise(() => {});
      if (text === "[slow]") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        log({ drainedWithoutAbort: !ctx.signal.aborted });
      }
      if (text === "[host-action]" || text === "[host-action-unknown]") {
        const call = {
          name: "fleet.send",
          callId: "call-1",
          actionId: "action-1",
          operationId: params.operationId,
          toolCallId: "tool-1",
          payloadDigest: "caller-action-digest",
          arguments: { target: "fixture", text: "hello" },
        };
        const first = await ctx.hostCall(call),
          second = await ctx.hostCall(call);
        log({
          actionResultsEqual: isDeepStrictEqual(first, second),
          actionResult: first,
        });
      }
      const identity = {
        operationId: params.operationId,
        turnId: params.turnId,
      };
      if (interactions)
        ctx.emit({
          ...identity,
          type: "operation.disposition",
          payload: { disposition: "accepted" },
        });
      ctx.emit({ ...identity, type: "turn.started", payload: {} });
      if (interactions) {
        const permissionId = "native-permission-1";
        const response = await interactions.onPermission(
          {
            _meta: { tidy: { permissionId } },
            options: [
              {
                optionId: "allow_once",
                kind: "allow_once",
                name: "Allow once",
              },
              { optionId: "deny", kind: "reject_once", name: "Deny" },
            ],
          },
          17,
          identity,
          ctx.signal
        );
        log({ nativePermissionResponse: response });
        if (
          response.outcome.outcome === "selected" &&
          ctx.initialization.config.mode === "hermes-confirmed"
        )
          interactions.onPermissionConsumed({
            ...identity,
            permissionId,
            optionId: response.outcome.optionId,
          });
      }
      ctx.emit({
        ...identity,
        messageId: `message:${params.operationId}`,
        type: "message.started",
        payload: { role: "assistant", order: 0 },
      });
      ctx.emit({
        ...identity,
        messageId: `message:${params.operationId}`,
        blockId: "body",
        type: "text.snapshot",
        payload: { revision: 1, text: "Reply: " + text },
      });
      ctx.emit({
        ...identity,
        messageId: `message:${params.operationId}`,
        type: "message.finished",
        payload: {
          ts: "2026-09-05T00:00:00.000Z",
          blocks: [
            {
              type: "text",
              blockId: "body",
              revision: 1,
              text: "Reply: " + text,
            },
          ],
        },
      });
      ctx.emit({
        ...identity,
        type: "turn.terminal",
        payload: { execution: "ended", observation: "complete" },
      });
      return { disposition: "accepted" };
    },
    "operation.cancel"(params) {
      log({ method: "operation.cancel", operationId: params.operationId });
      return { status: "requested" };
    },
    "interaction.respond"(params) {
      log({ method: "interaction.respond", operationId: params.operationId });
      if (interactions) return interactions.respond(params);
      return { status: "applied" };
    },
    "session.configure"(params) {
      log({ method: "session.configure", operationId: params.operationId });
      return { status: "applied" };
    },
  },
});
const outcome = await runtime.done;
log({ done: outcome });
process.exit(outcome.cleanup === "complete" ? 0 : 2);
