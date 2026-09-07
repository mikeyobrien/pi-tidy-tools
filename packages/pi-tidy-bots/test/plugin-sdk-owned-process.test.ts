import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { PluginStore } from "../src/plugin-sdk/store.ts";
import {
  spawnOwnedProcess,
  type OwnedProcessHandle,
  type OwnedProcessOptions,
} from "../src/plugin-sdk/owned-process.ts";
import type { PluginContext } from "../src/plugin-sdk/runtime.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "tidy-sdk-launch-"));
  const path = join(dir, "sdk.sqlite");
  const identity = {
    bindingId: "binding",
    instanceId: "instance",
    leaseGeneration: 1,
  };
  const store = new PluginStore(path, identity);
  const abort = new AbortController();
  const calls: string[] = [];
  const ctx = {
    store,
    signal: abort.signal,
    async ownedProcess(method, params) {
      calls.push(method);
      return method === "prepare"
        ? {
            launchId: params.launchId,
            state: "prepared",
            executable: process.execPath,
            launcherPath: fileURLToPath(
              new URL("../src/gateway/owned-launcher.mjs", import.meta.url)
            ),
          }
        : {
            launchId: params.launchId,
            state: "started",
            identity: { pid: params.pid, token: params.launchId },
          };
    },
  } as PluginContext;
  const options = {
    launchId: `tidy-launch-${randomUUID()}`,
    executable: process.execPath,
    cwd: dir,
    args: ["-e", "setInterval(()=>{},1000)"],
    environment: {} as Record<string, string>,
  };
  return {
    dir,
    path,
    store,
    identity,
    abort,
    ctx,
    calls,
    options,
    async cleanup() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("launch reservation survives a lost preparation response and refuses replay after reopening", async () => {
  const f = await fixture();
  try {
    f.options.environment = { PRIVATE_TOKEN: "do-not-store-this-secret" };
    f.ctx.ownedProcess = async () => {
      throw new Error("response lost");
    };
    await assert.rejects(spawnOwnedProcess(f.ctx, f.options), /response lost/);
    f.store.close();
    const reopened = new PluginStore(f.path, f.identity);
    f.ctx.store = reopened;
    try {
      await assert.rejects(spawnOwnedProcess(f.ctx, f.options), {
        code: "launch_already_reserved",
      });
      assert.equal(
        reopened.reservation(`operation:${f.options.launchId}`)?.settled,
        false
      );
    } finally {
      reopened.close();
    }
    assert.equal(
      (await readFile(f.path)).includes(
        Buffer.from("do-not-store-this-secret")
      ),
      false
    );
  } finally {
    await f.cleanup();
  }
});

test("launch snapshots input before awaiting the host and records unknown activation before native effects", async () => {
  const f = await fixture();
  let handle: OwnedProcessHandle | undefined;
  try {
    const effect = join(f.dir, "effect");
    f.options.args = [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(effect)},process.env.VALUE);setInterval(()=>{},1000)`,
    ];
    f.options.environment = { VALUE: "original" };
    const originalOptions = {
      ...f.options,
      args: [...f.options.args],
      environment: { ...f.options.environment },
    };
    const original = f.ctx.ownedProcess;
    f.ctx.ownedProcess = async (method, params) => {
      if (method === "prepare") {
        f.options.environment.VALUE = "changed";
        f.options.args[1] = "throw new Error('changed argv')";
      } else {
        await assert.rejects(readFile(effect), { code: "ENOENT" });
        assert.equal(
          f.store.reservation(`operation:${f.options.launchId}`)?.settled,
          false
        );
      }
      return original(method, params);
    };
    handle = await spawnOwnedProcess(f.ctx, f.options);
    handle.child.stdout!.resume();
    handle.child.stderr!.resume();
    const end = Date.now() + 3000;
    while (true) {
      try {
        assert.equal(await readFile(effect, "utf8"), "original");
        break;
      } catch (error) {
        if (Date.now() > end) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(f.calls, ["prepare", "record"]);
    await assert.rejects(spawnOwnedProcess(f.ctx, originalOptions), {
      code: "launch_already_reserved",
    });
    assert.deepEqual(f.calls, ["prepare", "record"]);
    assert.equal(
      (f.store.reservation(`operation:${f.options.launchId}`)?.result as any)
        .nativeOutcome,
      "unknown"
    );
    await handle.close();
    await handle.close();
  } finally {
    await handle?.close();
    await f.cleanup();
  }
});

test("abort during registration closes the unactivated wrapper without native execution", async () => {
  const f = await fixture();
  try {
    const effect = join(f.dir, "effect");
    f.options.args = [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(effect)},'unsafe')`,
    ];
    const original = f.ctx.ownedProcess;
    f.ctx.ownedProcess = async (method, params) => {
      if (method === "record") f.abort.abort();
      return original(method, params);
    };
    await assert.rejects(spawnOwnedProcess(f.ctx, f.options), {
      name: "AbortError",
    });
    await assert.rejects(readFile(effect), { code: "ENOENT" });
    assert.equal(
      f.store.reservation(`operation:${f.options.launchId}`)?.settled,
      false
    );
  } finally {
    await f.cleanup();
  }
});

test("invalid or oversized launch inputs fail before reserving or contacting the host", async () => {
  const f = await fixture();
  try {
    const changes: Partial<OwnedProcessOptions>[] = [
      { executable: "node" },
      { cwd: "relative" },
      { args: ["\0"] },
      { environment: { "BAD=NAME": "value" } },
      { environment: { VALUE: "a".repeat(1024 * 1024) } },
    ];
    for (const change of changes) {
      await assert.rejects(
        spawnOwnedProcess(f.ctx, { ...f.options, ...change }),
        { code: "invalid_config" }
      );
    }
    assert.deepEqual(f.calls, []);
    assert.equal(
      f.store.reservation(`operation:${f.options.launchId}`),
      undefined
    );
  } finally {
    await f.cleanup();
  }
});
