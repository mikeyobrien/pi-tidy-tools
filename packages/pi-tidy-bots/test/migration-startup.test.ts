import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFleet } from "../src/daemon.ts";
import { convertLegacyManifest, loadFleetConfig } from "../src/config.ts";
import { digestArtifact } from "../src/gateway/registry.ts";

test("converted legacy manifest starts a disposable mixed two-bot fleet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-migration-startup-"));
  await writeFile(join(dir, "AGENTS.md"), "disposable migration fixture\n");
  const artifact = join(dir, "plugin");
  await mkdir(artifact);
  await cp(
    fileURLToPath(
      new URL("./fixtures/gateway-application/backend.mjs", import.meta.url)
    ),
    join(artifact, "backend.mjs")
  );
  await chmod(join(artifact, "backend.mjs"), 0o755);
  await writeFile(
    join(artifact, "config.schema.json"),
    JSON.stringify({ type: "object", additionalProperties: false })
  );
  await writeFile(
    join(artifact, "backend.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "org.example.independent",
      version: "1.0.0",
      protocol: { major: 1, minMinor: 0, maxMinor: 0 },
      entrypoint: { path: "backend.mjs", args: [] },
      configSchema: "config.schema.json",
      runtime: {
        name: "migration-fixture",
        testedVersion: "1.0.0",
        transport: "stdio",
      },
      requestedAccess: {
        workspace: "none",
        nativeProfile: false,
        network: false,
        gatewayTools: [],
      },
    })
  );
  await writeFile(
    join(dir, "registry.json"),
    JSON.stringify({
      registryVersion: 1,
      plugins: [
        {
          id: "org.example.independent",
          version: "1.0.0",
          artifactPath: "plugin",
          sha256: await digestArtifact(artifact),
          enabled: true,
        },
      ],
    })
  );
  const legacy =
    'title = "Migrated fleet"\n[[bot]]\nname = "one"\ndir = "."\ntitle = "One"\napprove = true\n[[bot]]\nname = "two"\ndir = "."\ntitle = "Two"\n';
  await writeFile(
    join(dir, "bots.toml"),
    convertLegacyManifest(legacy, {
      registry: "registry.json",
      backend: "org.example.independent",
      environment: ["PATH"],
    })
  );
  const config = loadFleetConfig(dir, { port: 0 });
  assert.equal(config.bots.length, 2);
  assert.deepEqual(
    config.bots.map((bot) => [bot.name, bot.title, bot.approve, bot.noSkills]),
    [
      ["one", "One", true, undefined],
      ["two", "Two", true, undefined],
    ]
  );
  const handle = await startFleet({
    dir,
    port: 0,
    token: "migration-fixture-token",
    log: () => {},
  });
  try {
    const response = await fetch(handle.url + "/api/fleet", {
      headers: { authorization: "Bearer migration-fixture-token" },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      bots: Array<{ name: string; online: boolean }>;
    };
    assert.deepEqual(
      body.bots.map((bot) => [bot.name, bot.online]),
      [
        ["one", true],
        ["two", true],
      ]
    );
  } finally {
    await handle.stop();
  }
});
