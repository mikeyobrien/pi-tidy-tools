import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFleetConfig } from "../src/config.ts";
import { botPackageInstalled } from "../src/daemon.ts";
import { rpcSpawnArgs } from "../src/rpc.ts";

// Issue 92: bot-scoped pi packages. Optional `packages` on [[bot]]; at spawn
// the daemon installs missing ones project-local (pi install -l into the
// fleet-owned bot dir) and runs that bot with project trust (--approve =
// pi's project-file trust, NOT tool auto-approve) so they actually load.

const runner = new URL("./fixtures/rpc/streaming-pi.mjs", import.meta.url)
  .pathname;

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met in time");
}

test("config parses optional bot packages; omitted stays undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-pkg-cfg-"));
  try {
    mkdirSync(join(dir, "bots", "aa"), { recursive: true });
    writeFileSync(join(dir, "bots", "aa", "AGENTS.md"), "# aa\n");
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\npackages = ["npm:@ramarivera/pi-grok-build"]\n`
    );
    const fleet = loadFleetConfig(dir);
    assert.deepEqual(fleet.bots[0].packages, ["npm:@ramarivera/pi-grok-build"]);
    writeFileSync(
      join(dir, "bots.toml"),
      `[[bot]]\nname = "aa"\ndir = "bots/aa"\n`
    );
    assert.equal(loadFleetConfig(dir).bots[0].packages, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rpcSpawnArgs: trustProject adds --approve; default stays without", () => {
  const base = {
    name: "aa",
    sessionDir: "/s",
    resume: false,
    approve: false,
    bridgePath: "/b.ts",
  };
  assert.ok(!rpcSpawnArgs(base).includes("--approve"));
  assert.ok(
    rpcSpawnArgs({ ...base, trustProject: true }).includes("--approve")
  );
});

test("rpcSpawnArgs: tool-isolation controls map 1:1 to pi flags", () => {
  const base = {
    name: "aa",
    sessionDir: "/s",
    resume: false,
    approve: false,
    bridgePath: "/b.ts",
  };
  // Default: none of the isolation flags ride the argv.
  for (const flag of [
    "--tools",
    "--no-builtin-tools",
    "--no-extensions",
    "--no-skills",
  ])
    assert.ok(!rpcSpawnArgs(base).includes(flag), `${flag} absent by default`);
  const argv = rpcSpawnArgs({
    ...base,
    tools: ["tiller_digest"],
    noBuiltinTools: true,
    noExtensions: true,
    noSkills: true,
  });
  const toolsIndex = argv.indexOf("--tools");
  assert.ok(toolsIndex !== -1, "--tools present");
  assert.equal(argv[toolsIndex + 1], "tiller_digest");
  assert.equal(
    argv[toolsIndex + 1],
    ["tiller_digest"].join(","),
    "multi-entry tools join comma-separated"
  );
  assert.ok(argv.includes("--no-builtin-tools"));
  assert.ok(argv.includes("--no-extensions"));
  assert.ok(argv.includes("--no-skills"));
  // The fleet's own -e extensions still load alongside --no-extensions.
  const bridgeIndex = argv.indexOf("-e");
  assert.ok(bridgeIndex !== -1, "bridge extension still explicit");
});

test("botPackageInstalled matches string and {source} entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-pkg-set-"));
  try {
    assert.equal(botPackageInstalled(dir, "npm:x"), false, "no settings");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({
        packages: ["npm:x", { source: "git:h/r", extensions: [] }],
      })
    );
    assert.equal(botPackageInstalled(dir, "npm:x"), true, "string entry");
    assert.equal(botPackageInstalled(dir, "git:h/r"), true, "object entry");
    assert.equal(botPackageInstalled(dir, "npm:y"), false, "absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "packages bot: install-once, trusted spawn, sibling untouched (issue 92)",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-pkg-fleet-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    const argvLog = join(fleetDir, "argv.log");
    try {
      for (const bot of ["aa", "bb"]) {
        mkdirSync(join(fleetDir, "bots", bot), { recursive: true });
        writeFileSync(join(fleetDir, "bots", bot, "AGENTS.md"), `# ${bot}\n`);
      }
      // aa declares a package AND pre-seeds it in project settings (install
      // must be skipped); bb declares none.
      mkdirSync(join(fleetDir, "bots", "aa", ".pi"), { recursive: true });
      writeFileSync(
        join(fleetDir, "bots", "aa", ".pi", "settings.json"),
        JSON.stringify({ packages: ["npm:@test/pkg"] })
      );
      writeFileSync(
        join(fleetDir, "bots.toml"),
        // Atlas scenario: approve=false everywhere; trust comes ONLY from
        // the packages field.
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\npackages = ["npm:@test/pkg"]\napprove = false\n` +
          `[[bot]]\nname = "bb"\ndir = "bots/bb"\napprove = false\n`
      );
      // Wrapper: log argv; `install` subcommand writes the settings file;
      // anything else runs the streaming rpc stub.
      const wrapper = join(fleetDir, "pi.sh");
      writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          `echo "$PI_TIDY_BOTS_NAME $@" >> "${argvLog}"`,
          `if [ "$1" = "install" ]; then`,
          `  botdir="$(pwd)"`,
          `  mkdir -p "$botdir/.pi"`,
          `  printf '{"packages":["%s"]}' "$3" > "$botdir/.pi/settings.json"`,
          "  exit 0",
          "fi",
          `exec node ${runner}`,
        ].join("\n")
      );
      spawnSync("chmod", ["+x", wrapper]);

      const { startFleet } = await import("../src/daemon.ts");
      const handle = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        piBin: wrapper,
        log: () => {},
      });
      handles.push(handle);
      const base = `http://127.0.0.1:${handle.port}`;
      await waitFor(async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );

      const argvAll = existsSync(argvLog)
        ? readFileSync(argvLog, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
        : [];
      const aa = argvAll.filter((line) => line.startsWith("aa "));
      const bb = argvAll.filter((line) => line.startsWith("bb "));
      // aa's rpc spawn is trusted; bb's is not; aa needed no install.
      assert.ok(
        aa.some(
          (line) => line.includes("--mode rpc") && line.includes("--approve")
        ),
        "packages bot spawns with project trust"
      );
      assert.ok(
        bb.some((line) => line.includes("--mode rpc")),
        "sibling spawned"
      );
      assert.ok(
        bb.every((line) => !line.includes("--approve")),
        "sibling spawns without project trust"
      );
      assert.equal(
        argvAll.filter((line) => / (install) /.test(line)).length,
        0,
        "pre-seeded package skips install"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);

test(
  "missing package installs project-local before spawn (issue 92)",
  { timeout: 45000 },
  async () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "ptb-pkg-install-"));
    const handles: Array<{ stop(): Promise<void> }> = [];
    const argvLog = join(fleetDir, "argv.log");
    try {
      mkdirSync(join(fleetDir, "bots", "aa"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "aa", "AGENTS.md"), "# aa\n");
      writeFileSync(
        join(fleetDir, "bots.toml"),
        `[[bot]]\nname = "aa"\ndir = "bots/aa"\npackages = ["npm:@fresh/pkg"]\n`
      );
      const wrapper = join(fleetDir, "pi.sh");
      writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          `echo "$PI_TIDY_BOTS_NAME $@" >> "${argvLog}"`,
          `if [ "$1" = "install" ]; then`,
          `  botdir="$(pwd)"`,
          `  mkdir -p "$botdir/.pi"`,
          `  printf '{"packages":["%s"]}' "$3" > "$botdir/.pi/settings.json"`,
          "  exit 0",
          "fi",
          `exec node ${runner}`,
        ].join("\n")
      );
      spawnSync("chmod", ["+x", wrapper]);

      const { startFleet } = await import("../src/daemon.ts");
      const handle = await startFleet({
        dir: fleetDir,
        port: 0,
        host: "127.0.0.1",
        piBin: wrapper,
        log: () => {},
      });
      handles.push(handle);
      const base = `http://127.0.0.1:${handle.port}`;
      await waitFor(async () =>
        (
          (await (await fetch(`${base}/api/fleet`)).json()) as {
            bots: { online: boolean }[];
          }
        ).bots.every((b) => b.online)
      );

      const argvAll = existsSync(argvLog)
        ? readFileSync(argvLog, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
        : [];
      assert.ok(
        argvAll.some(
          (line) =>
            / install /.test(line) &&
            line.includes("-l") &&
            line.includes("npm:@fresh/pkg")
        ),
        "install -l ran for the missing package"
      );
      assert.ok(
        botPackageInstalled(join(fleetDir, "bots", "aa"), "npm:@fresh/pkg"),
        "settings now lists the package"
      );
    } finally {
      await Promise.all(handles.map((h) => h.stop().catch(() => {})));
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
