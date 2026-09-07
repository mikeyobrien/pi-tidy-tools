import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcSession, type RpcSpawnOptions } from "../src/rpc.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/rpc/environment-pi.mjs", import.meta.url)
);
function options(directory: string): RpcSpawnOptions {
  return {
    name: "disposable",
    piBin: fixture,
    cwd: directory,
    sessionDir: join(directory, "sessions"),
    resume: false,
    approve: false,
    bridgePath: join(directory, "scoped-bridge.ts"),
    daemonUrl: "http://legacy.invalid",
    childSecret: "dummy-legacy-secret",
    onEvent() {},
    onExit() {},
  };
}
async function inspect(configuration: RpcSpawnOptions) {
  const session = RpcSession.spawn(configuration);
  try {
    return await session.getState<{
      environment: Record<string, string>;
      argv: string[];
      cwd: string;
    }>();
  } finally {
    const closed = once(session.process, "close");
    session.stop();
    await closed;
  }
}

test("isolated RPC passes only explicit environment to a real child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tidy-rpc-env-"));
  const previous = process.env.TIDY_TEST_PARENT_ONLY;
  process.env.TIDY_TEST_PARENT_ONLY = "must-not-cross";
  try {
    const isolatedEnv = {
      PATH: dirname(process.execPath),
      HOME: directory,
      TIDY_TEST_PROVIDER: "dummy-explicit-provider",
    };
    const result = await inspect({ ...options(directory), isolatedEnv });
    // macOS initializes CoreFoundation locale metadata in the launched runtime.
    if (process.platform === "darwin")
      delete result.environment.__CF_USER_TEXT_ENCODING;
    assert.deepEqual(result.environment, isolatedEnv);
    assert.equal(result.cwd, realpathSync(directory));
    assert.ok(!result.argv.includes("--continue"));
    assert.ok(!result.argv.includes("--approve"));
    assert.equal(
      result.argv[result.argv.indexOf("--session-dir") + 1],
      join(directory, "sessions")
    );
  } finally {
    if (previous === undefined) delete process.env.TIDY_TEST_PARENT_ONLY;
    else process.env.TIDY_TEST_PARENT_ONLY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy RPC retains inherited environment, bridge credentials and explicit overrides", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tidy-rpc-legacy-env-"));
  try {
    const result = await inspect({
      ...options(directory),
      env: {
        PATH: dirname(process.execPath),
        TIDY_TEST_OVERRIDE: "explicit",
      },
    });
    assert.equal(
      result.environment.PI_TIDY_BOTS_CHILD_SECRET,
      "dummy-legacy-secret"
    );
    assert.equal(
      result.environment.PI_TIDY_BOTS_DAEMON_URL,
      "http://legacy.invalid"
    );
    assert.equal(result.environment.PI_TIDY_BOTS_NAME, "disposable");
    assert.equal(result.environment.TIDY_TEST_OVERRIDE, "explicit");
    assert.equal(result.environment.HOME, process.env.HOME);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("isolated RPC rejects ambiguous environment or implicit native paths before launch", () => {
  const base = { ...options(tmpdir()), isolatedEnv: {} };
  assert.throws(
    () => RpcSession.spawn({ ...base, env: {} }),
    /cannot be combined/
  );
  for (const patch of [
    { piBin: undefined },
    { piBin: "pi" },
    { cwd: "." },
    { sessionDir: "sessions" },
  ]) {
    assert.throws(
      () => RpcSession.spawn({ ...base, ...patch }),
      /requires absolute/
    );
  }
});
