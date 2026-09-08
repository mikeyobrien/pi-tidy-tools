import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import {
  spawnOwnedProcess,
  type PluginContext,
  type EventInput,
} from "@mobrienv/pi-tidy-bots/plugin-sdk";
import {
  nonempty,
  ProtocolError,
  type JsonObject,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";
import { CodexSession } from "./session.ts";

export interface CodexConfiguration {
  executable: string;
  home: string;
  profile: string;
  environment: Record<string, string>;
}

const keys = ["executable", "home_dir", "profile_dir", "environment_keys"];
const absolute = (value: unknown): value is string =>
  nonempty(value) && isAbsolute(value) && !value.includes("\0");

export async function validateCodexConfiguration(
  config: JsonObject
): Promise<CodexConfiguration> {
  if (
    Object.keys(config).some((key) => !keys.includes(key)) ||
    !absolute(config.executable) ||
    !absolute(config.home_dir) ||
    !absolute(config.profile_dir) ||
    !Array.isArray(config.environment_keys) ||
    !config.environment_keys.every(
      (key) =>
        typeof key === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(key) &&
        !/^(TIDY_|PI_TIDY_|CODEX_HOME$|HOME$|NODE_|LD_|DYLD_)/.test(key)
    ) ||
    new Set(config.environment_keys).size !== config.environment_keys.length
  )
    throw new ProtocolError(
      "invalid_config",
      "Codex requires explicit runtime paths and permitted environment names"
    );
  const executable = config.executable;
  const environment: Record<string, string> = {};
  for (const key of config.environment_keys as string[]) {
    const value = process.env[key];
    if (value === undefined || value.includes("\0"))
      throw new ProtocolError(
        "invalid_config",
        "A requested Codex environment variable is unavailable"
      );
    environment[key] = value;
  }
  try {
    if (!(await stat(executable)).isFile()) throw new Error();
    await access(executable, constants.X_OK);
    const [home, profile] = await Promise.all(
      [config.home_dir, config.profile_dir].map(async (path) => {
        const resolved = await realpath(path);
        if (!(await stat(resolved)).isDirectory()) throw new Error();
        return resolved;
      })
    );
    return {
      executable,
      home,
      profile,
      environment: { ...environment, HOME: home, CODEX_HOME: home },
    };
  } catch {
    throw new ProtocolError(
      "invalid_config",
      "Codex runtime paths must already exist and be accessible"
    );
  }
}

export interface CodexRuntime {
  session: CodexSession;
  nativeReference: string;
  launchId: string;
  closed: Promise<void>;
  close(): Promise<void>;
  cancel(params: JsonObject): unknown;
}

export async function openCodexRuntime(
  ctx: PluginContext,
  launchId: string,
  config: JsonObject,
  hooks: {
    nativeReference?: string;
    onFailure: (error: ProtocolError) => void;
  }
): Promise<CodexRuntime> {
  const configuration = await validateCodexConfiguration(config);
  const process = await spawnOwnedProcess(ctx, {
    launchId,
    executable: configuration.executable,
    args: ["app-server", "--stdio"],
    cwd: ctx.initialization.workspace,
    environment: configuration.environment,
  });
  process.child.stderr!.resume();
  let session: CodexSession | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        try {
          session?.close();
        } finally {
          await process.close();
        }
      });
    }
    return closing;
  };
  try {
    const onFailure = (error: ProtocolError) => {
      void close();
      hooks.onFailure(error);
    };
    session = new CodexSession({
      input: process.child.stdin!,
      output: process.child.stdout!,
      maxFrameBytes: ctx.initialization.limits.maxFrameBytes,
      maxPendingRequests: ctx.initialization.limits.maxPendingRequests,
      requestTimeoutMs: ctx.initialization.limits.commandTimeoutMs,
      promptTimeoutMs: 3600000,
      expectedHome: configuration.home,
      emit: (event) => ctx.emit(event as EventInput),
      onFailure,
    });
    const nativeReference = await session.open(
      ctx.initialization.workspace,
      hooks.nativeReference
    );
    ctx.signal.throwIfAborted();
    return {
      session,
      nativeReference,
      launchId,
      closed: process.closed,
      close,
      cancel: (params) => {
        if (
          !nonempty(params.operationId) ||
          !nonempty(params.payloadDigest) ||
          !nonempty(params.targetOperationId)
        )
          throw new ProtocolError(
            "invalid_request",
            "Cancellation requires a durable control and target identity"
          );
        const key = `operation:${params.operationId}`;
        if (ctx.store.reservation(key)?.method !== "operation.cancel")
          throw new ProtocolError(
            "durability_required",
            "SDK must reserve cancellation before native dispatch"
          );
        const reservation = ctx.store.reserve(
          key,
          "operation.cancel",
          params.payloadDigest,
          params
        );
        if (reservation.settled) return reservation.result;
        return session!.cancel(params.targetOperationId);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
