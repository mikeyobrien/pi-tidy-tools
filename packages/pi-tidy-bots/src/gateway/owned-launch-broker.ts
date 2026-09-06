import { fileURLToPath } from "node:url";
import { ProtocolError, type JsonObject } from "./protocol.ts";
import {
  ownedChildIdentity,
  ownedGroupHasExited,
  reconcileOwnedProcess,
  type OwnedProcessIdentity,
} from "./process-ownership.ts";

export const OWNERSHIP_METHODS = [
  "ownership.prepare",
  "ownership.record",
  "ownership.inspect",
  "ownership.stopped",
] as const;
export interface OwnedLaunchCallbacks {
  prepare: (launchId: string, parentLaunchId: string) => void | Promise<void>;
  record: (
    launchId: string,
    identity: OwnedProcessIdentity
  ) => void | Promise<void>;
  stopped: (launchId: string) => void | Promise<void>;
}
type Launch = {
  state: "prepared" | "started" | "stopped";
  identity?: OwnedProcessIdentity;
};

/** One current host epoch. The gateway journal retains identities across epochs;
 * startup must reconcile that journal before a replacement broker is created.
 */
export class OwnedLaunchBroker {
  private readonly launches = new Map<string, Launch>();
  private chain: Promise<unknown> = Promise.resolve();
  private closing = false;
  readonly launcherPath = fileURLToPath(
    new URL("./owned-launcher.mjs", import.meta.url)
  );
  private readonly root: OwnedProcessIdentity & { launchId: string };
  private readonly callbacks: OwnedLaunchCallbacks;
  constructor(
    root: OwnedProcessIdentity & { launchId: string },
    callbacks: OwnedLaunchCallbacks
  ) {
    this.root = root;
    this.callbacks = callbacks;
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.catch(() => {});
    return result;
  }
  call(method: string, params: JsonObject): Promise<JsonObject> {
    return this.serialized(async () => {
      if (this.closing)
        throw new ProtocolError(
          "plugin_closed",
          "Ownership service is closing"
        );
      if (
        typeof params.launchId !== "string" ||
        !/^tidy-launch-[a-f0-9-]{36}$/.test(params.launchId) ||
        params.launchId === this.root.launchId ||
        Object.keys(params).some(
          (key) =>
            ![
              "launchId",
              ...(method === "ownership.record" ? ["pid"] : []),
            ].includes(key)
        )
      )
        throw new ProtocolError(
          "invalid_payload",
          "Invalid child launch identity"
        );
      const id = params.launchId;
      let launch = this.launches.get(id);
      if (method === "ownership.prepare") {
        if (launch && launch.state !== "prepared")
          throw new ProtocolError(
            "launch_conflict",
            "An admitted launch cannot be prepared again"
          );
        if (!launch && this.launches.size >= 4096)
          throw new ProtocolError(
            "resource_limit",
            "Child launch history is full"
          );
        await this.callbacks.prepare(id, this.root.launchId);
        launch ??= { state: "prepared" };
        this.launches.set(id, launch);
        return {
          launchId: id,
          state: launch.state,
          launcherPath: this.launcherPath,
          executable: process.execPath,
        };
      }
      if (!launch)
        throw new ProtocolError(
          "launch_not_prepared",
          "Child launch has no reservation in this host epoch"
        );
      if (method === "ownership.record") {
        if (!Number.isSafeInteger(params.pid) || Number(params.pid) < 1)
          throw new ProtocolError(
            "invalid_payload",
            "Invalid child process identity"
          );
        if (
          launch.state === "stopped" ||
          (launch.identity && launch.identity.pid !== params.pid)
        )
          throw new ProtocolError(
            "launch_conflict",
            "Child launch identity cannot be replaced or revived"
          );
        const groups = [
          this.root,
          ...[...this.launches.values()]
            .filter((value) => value.state === "started")
            .map((value) => value.identity!),
        ];
        const identity =
          launch.identity ??
          (await ownedChildIdentity(
            Number(params.pid),
            id,
            this.launcherPath,
            groups
          ));
        // Retain observed ownership even if persistence returns an ambiguous
        // failure after committing. Shutdown must still inspect this group.
        launch.identity = identity;
        await this.callbacks.record(id, identity);
        launch.state = "started";
      } else if (method === "ownership.stopped") {
        if (
          launch.identity &&
          !(await ownedGroupHasExited(launch.identity.pid))
        )
          throw new ProtocolError(
            "ownership_unreconciled",
            "Owned child group still has live processes"
          );
        await this.callbacks.stopped(id);
        launch.state = "stopped";
      } else if (method !== "ownership.inspect") {
        throw new ProtocolError("unsupported", "Unknown ownership service");
      }
      return {
        launchId: id,
        state: launch.state,
        ...(launch.identity ? { identity: { ...launch.identity } } : {}),
      };
    });
  }
  /** Called after the parent group exits. Wait only; private launcher EOF owns reaping. */
  reconcile(): Promise<void> {
    this.closing = true;
    return this.serialized(async () => {
      for (const [id, launch] of this.launches) {
        if (launch.state === "stopped") continue;
        if (launch.identity) await reconcileOwnedProcess(launch.identity);
        await this.callbacks.stopped(id);
        launch.state = "stopped";
      }
    });
  }
}
