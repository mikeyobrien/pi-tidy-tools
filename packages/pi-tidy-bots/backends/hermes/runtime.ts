import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
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
import { HermesSession, type HermesSessionOptions } from "./session.ts";

export interface HermesConfiguration {
  executable: string;
  source: string;
  home: string;
  profile: string;
  environment: Record<string, string>;
}

const keys = [
  "executable",
  "source_dir",
  "home_dir",
  "profile_dir",
  "environment_keys",
];
const absolute = (value: unknown): value is string =>
  nonempty(value) && isAbsolute(value) && !value.includes("\0");

/** No ambient provider configuration or Python startup hooks enter the child. */
export async function validateHermesConfiguration(
  config: JsonObject
): Promise<HermesConfiguration> {
  if (
    Object.keys(config).some((key) => !keys.includes(key)) ||
    !absolute(config.executable) ||
    !absolute(config.source_dir) ||
    !absolute(config.home_dir) ||
    !absolute(config.profile_dir) ||
    !Array.isArray(config.environment_keys) ||
    !config.environment_keys.every(
      (key) =>
        typeof key === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(key) &&
        !/^(TIDY_|PI_TIDY_|HERMES_|PYTHON|NODE_|LD_|DYLD_|HOME$|VIRTUAL_ENV$)/.test(
          key
        )
    ) ||
    new Set(config.environment_keys).size !== config.environment_keys.length
  )
    throw new ProtocolError(
      "invalid_config",
      "Hermes requires explicit runtime paths and permitted environment names"
    );
  // Preserve the venv executable path: realpath can silently select base Python.
  const executable = config.executable;
  const directories = [config.source_dir, config.home_dir, config.profile_dir];
  const environment: Record<string, string> = {};
  for (const key of config.environment_keys as string[]) {
    const value = process.env[key];
    if (value === undefined || value.includes("\0"))
      throw new ProtocolError(
        "invalid_config",
        "A requested Hermes environment variable is unavailable"
      );
    environment[key] = value;
  }
  try {
    if (!(await stat(executable)).isFile()) throw new Error();
    await access(executable, constants.X_OK);
    const [source, home, profile] = await Promise.all(
      directories.map(async (path) => {
        const resolved = await realpath(path);
        if (!(await stat(resolved)).isDirectory()) throw new Error();
        return resolved;
      })
    );
    return {
      executable,
      source,
      home,
      profile,
      environment: { ...environment, HOME: home, HERMES_HOME: profile },
    };
  } catch {
    throw new ProtocolError(
      "invalid_config",
      "Hermes runtime paths must already exist and be accessible"
    );
  }
}

export interface HermesRuntime {
  session: HermesSession;
  nativeReference: string;
  launchId: string;
  /** Wrapper exit is not proof that separately launched tools were reconciled. */
  closed: Promise<void>;
  close(): Promise<void>;
}

/** The caller's session.open reservation must precede this fresh native launch.
 * This owns the ACP group. Hermes detached tool launches require separate broker
 * registrations before a composing adapter can claim complete native cleanup.
 */
export async function openHermesRuntime(
  ctx: PluginContext,
  launchId: string,
  config: JsonObject,
  hooks: Pick<HermesSessionOptions, "onPermission" | "onFailure">
): Promise<HermesRuntime> {
  const configuration = await validateHermesConfiguration(config);
  const process = await spawnOwnedProcess(ctx, {
    launchId,
    executable: configuration.executable,
    args: [
      "-I",
      "-B",
      fileURLToPath(new URL("./native_guard.py", import.meta.url)),
      "--source",
      configuration.source,
      "--profile",
      configuration.profile,
      "--home",
      configuration.home,
    ],
    cwd: ctx.initialization.workspace,
    environment: configuration.environment,
  });
  // Drain private native diagnostics without storing or forwarding their contents.
  process.child.stderr!.resume();
  let session: HermesSession | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      session?.close();
      closing = process.close();
    }
    return closing;
  };
  try {
    session = new HermesSession({
      input: process.child.stdin!,
      output: process.child.stdout!,
      maxFrameBytes: ctx.initialization.limits.maxFrameBytes,
      maxPendingRequests: ctx.initialization.limits.maxPendingRequests,
      requestTimeoutMs: ctx.initialization.limits.commandTimeoutMs,
      emit: (event) => ctx.emit(event as EventInput),
      onPermission: hooks.onPermission,
      onFailure: (error) => {
        void close();
        hooks.onFailure(error);
      },
    });
    const nativeReference = await session.open(ctx.initialization.workspace);
    ctx.signal.throwIfAborted();
    return {
      session,
      nativeReference,
      launchId,
      closed: process.closed,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
