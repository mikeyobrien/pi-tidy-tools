import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Writable } from "node:stream";
import { payloadDigest } from "../gateway/journal.ts";
import { object, ProtocolError } from "../gateway/protocol.ts";
import type { PluginContext } from "./runtime.ts";

export interface OwnedProcessOptions {
  launchId: string;
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
}

export interface OwnedProcessHandle {
  launchId: string;
  child: ChildProcess;
  /** Local wrapper exit only; the host separately reconciles the owned group. */
  closed: Promise<void>;
  /** Close the private activation pipe and join the wrapper, without PID signals. */
  close(): Promise<void>;
}

/** Reserve once, register the trusted wrapper, then dispatch native activation.
 * Returning a handle is not evidence that native execution started or succeeded.
 */
export async function spawnOwnedProcess(
  ctx: PluginContext,
  options: OwnedProcessOptions
): Promise<OwnedProcessHandle> {
  const validPath = (value: unknown): value is string =>
    typeof value === "string" && isAbsolute(value) && !value.includes("\0");
  if (
    !/^tidy-launch-[a-f0-9-]{36}$/.test(options.launchId) ||
    !validPath(options.executable) ||
    !validPath(options.cwd) ||
    !Array.isArray(options.args) ||
    options.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !object(options.environment) ||
    Object.entries(options.environment).some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        typeof value !== "string" ||
        value.includes("\0")
    )
  )
    throw new ProtocolError("invalid_config", "Invalid owned process launch");
  // Snapshot before any asynchronous host call. Never persist credentials.
  const { launchId, executable, cwd } = options;
  const args = [...options.args];
  const environment = { ...options.environment };
  const activation =
    JSON.stringify({ activate: launchId, env: environment }) + "\n";
  if (Buffer.byteLength(activation) > 1024 * 1024)
    throw new ProtocolError(
      "invalid_config",
      "Owned activation exceeds frame limit"
    );
  ctx.signal.throwIfAborted();
  const intent = {
    operationId: launchId,
    executable,
    cwd,
    argsDigest: payloadDigest(args),
    environmentDigest: payloadDigest(environment),
  };
  const key = `operation:${launchId}`;
  const reservation = ctx.store.reserve(
    key,
    "process.launch",
    payloadDigest(intent),
    intent
  );
  if (!reservation.created)
    throw new ProtocolError(
      "launch_already_reserved",
      "Inspect the existing launch; never repeat activation"
    );
  const prepared = await ctx.ownedProcess("prepare", { launchId });
  if (
    !object(prepared) ||
    prepared.launchId !== launchId ||
    prepared.state !== "prepared" ||
    !validPath(prepared.executable) ||
    !validPath(prepared.launcherPath)
  )
    throw new ProtocolError(
      "invalid_ownership",
      "Host did not prepare a trusted launcher"
    );
  ctx.signal.throwIfAborted();
  const child = spawn(
    prepared.executable,
    [prepared.launcherPath, launchId, executable, ...args],
    {
      cwd,
      env: {},
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }
  );
  const control = child.stdio[3] as Writable;
  let exited = false;
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  control.on("error", (error) => {
    failure = error;
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      exited = true;
      ctx.signal.removeEventListener("abort", stop);
      resolve();
    })
  );
  const stop = () => {
    control.end();
  };
  ctx.signal.addEventListener("abort", stop, { once: true });
  const close = async () => {
    stop();
    await closed;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    ctx.signal.throwIfAborted();
    const recorded = await ctx.ownedProcess("record", {
      launchId,
      pid: child.pid,
    });
    if (
      !object(recorded) ||
      recorded.launchId !== launchId ||
      recorded.state !== "started" ||
      !object(recorded.identity) ||
      recorded.identity.pid !== child.pid ||
      recorded.identity.token !== launchId
    )
      throw new ProtocolError(
        "invalid_ownership",
        "Host did not record the child identity"
      );
    ctx.signal.throwIfAborted();
    if (failure || exited || control.destroyed || control.writableEnded)
      throw new ProtocolError(
        "ownership_unreconciled",
        "Launcher closed before activation"
      );
    // A crash on either side of the write leaves activation unknown, never replayable.
    ctx.store.settle(key, {
      status: "activation_reserved",
      nativeOutcome: "unknown",
      launchId,
      pid: child.pid,
    });
    await new Promise<void>((resolve, reject) =>
      control.write(activation, (error) => (error ? reject(error) : resolve()))
    );
    return { launchId, child, closed, close };
  } catch (error) {
    await close();
    throw error;
  }
}
