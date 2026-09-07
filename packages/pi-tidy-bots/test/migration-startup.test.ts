import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  const source = fileURLToPath(
    new URL("./fixtures/gateway-application/backend.mjs", import.meta.url)
  );
  const artifacts = ["one", "two"].map((name) => join(dir, `plugin-${name}`));
  for (const [index, artifact] of artifacts.entries()) {
    await mkdir(artifact);
    await cp(source, join(artifact, "backend.mjs"));
    await chmod(join(artifact, "backend.mjs"), 0o755);
    await writeFile(
      join(artifact, "config.schema.json"),
      JSON.stringify({ type: "object", additionalProperties: false })
    );
    await writeFile(
      join(artifact, "backend.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: `org.example.independent-${index + 1}`,
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
  }
  await writeFile(
    join(dir, "registry.json"),
    JSON.stringify({
      registryVersion: 1,
      plugins: [
        {
          id: "org.example.independent-1",
          version: "1.0.0",
          artifactPath: "plugin-one",
          sha256: await digestArtifact(artifacts[0]),
          enabled: true,
        },
        {
          id: "org.example.independent-2",
          version: "1.0.0",
          artifactPath: "plugin-two",
          sha256: await digestArtifact(artifacts[1]),
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
      backend: {
        one: "org.example.independent-1",
        two: "org.example.independent-2",
      },
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
      bots: Array<{
        name: string;
        online: boolean;
        gateway: { backend: { id: string } };
      }>;
    };
    assert.deepEqual(
      body.bots.map((bot) => [bot.name, bot.online, bot.gateway.backend.id]),
      [
        ["one", true, "org.example.independent-1"],
        ["two", true, "org.example.independent-2"],
      ]
    );
  } finally {
    await handle.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
