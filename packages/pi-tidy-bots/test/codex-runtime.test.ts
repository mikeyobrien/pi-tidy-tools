import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCodexConfiguration } from "../backends/codex/runtime.ts";

const fixtureExecutable = fileURLToPath(
  new URL("./fixtures/codex-native/app-server.mjs", import.meta.url)
);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "tidy-codex-runtime-"));
  const home = join(dir, "home"),
    profile = join(dir, "profile");
  await mkdir(home);
  await mkdir(profile);
  const executable = join(dir, "codex-fixture");
  await copyFile(fixtureExecutable, executable);
  await chmod(executable, 0o755);
  return {
    dir,
    home,
    profile,
    executable,
    config: {
      executable,
      home_dir: home,
      profile_dir: profile,
      environment_keys: [],
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Codex configuration maps distinct home_dir and profile_dir onto HOME and CODEX_HOME", async () => {
  const f = await fixture();
  try {
    const valid = await validateCodexConfiguration(f.config);
    assert.equal(valid.home, await realpath(f.home));
    assert.equal(valid.profile, await realpath(f.profile));
    assert.notEqual(valid.home, valid.profile);
    assert.deepEqual(valid.environment, {
      HOME: valid.home,
      CODEX_HOME: valid.profile,
    });
    assert.notEqual(valid.environment.HOME, valid.environment.CODEX_HOME);
    for (const name of ["HOME", "CODEX_HOME", "NODE_OPTIONS", "LD_PRELOAD"])
      await assert.rejects(
        validateCodexConfiguration({ ...f.config, environment_keys: [name] }),
        { code: "invalid_config" }
      );
    for (const changes of [
      { executable: "codex" },
      { home_dir: "/missing-tidy-directory" },
      { profile_dir: "/missing-tidy-directory" },
      { unknown: true },
    ])
      await assert.rejects(
        validateCodexConfiguration({ ...f.config, ...changes }),
        { code: "invalid_config" }
      );
  } finally {
    await f.cleanup();
  }
});
