#!/usr/bin/env node
import { appendFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runPlugin } from "SDK_INDEX_URL";

let ownedChild;
let ownedLaunchId;
let ownedControl;
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
      if (ownedControl) ownedControl.end();
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
        const prepared = await ctx.ownedProcess("prepare", {
          launchId: ownedLaunchId,
        });
        ownedChild = spawn(
          prepared.executable,
          [
            prepared.launcherPath,
            ownedLaunchId,
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(join(ctx.initialization.dataDir, "child-effect"))},'started');setInterval(()=>{},1000)`,
          ],
          { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] }
        );
        ownedControl = ownedChild.stdio[3];
        const recorded = await ctx.ownedProcess("record", {
          launchId: ownedLaunchId,
          pid: ownedChild.pid,
        });
        if (recorded.state !== "started")
          throw new Error("Child identity was not recorded");
        ownedControl.write(
          JSON.stringify({ activate: ownedLaunchId, env: {} }) + "\n"
        );
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
      ctx.emit({ ...identity, type: "turn.started", payload: {} });
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
