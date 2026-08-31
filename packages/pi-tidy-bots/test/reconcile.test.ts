import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic reconcile integration: real fs.watch on a temp fleet, real daemon,
// stub pi binary (a POSIX sh script that exits immediately — no model calls).
// Roster membership is asserted over the REST API.

const PORT = 4693;

function makeFleet(): string {
  const dir = mkdtempSync(join(tmpdir(), "ptb-reconcile-"));
  const manifest = (rows: string) =>
    writeFileSync(join(dir, "bots.toml"), `[fleet]\nport = ${PORT}\n${rows}`);
  const bot = (name: string) => {
    mkdirSync(join(dir, "bots", name), { recursive: true });
    writeFileSync(join(dir, "bots", name, "AGENTS.md"), `# ${name}\n`);
  };
  bot("alpha");
  manifest('[[bot]]\nname = "alpha"\ndir = "bots/alpha"\n');
  return dir;
}

const row = (name: string, model?: string) =>
  `[[bot]]\nname = "${name}"\ndir = "bots/${name}"${model ? `\nmodel = "${model}"` : ""}\n`;

async function roster() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/fleet`);
  return (await res.json()) as { bots: { name: string }[] };
}

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

test(
  "hot onboarding: add, remove, invalid, and reconfigure reconcile live",
  { timeout: 30000 },
  async () => {
    const fleetDir = makeFleet();

    // Executable stub child: exits immediately, no model traffic needed.
    const stub = join(fleetDir, "stub-pi.sh");
    writeFileSync(stub, "#!/bin/sh\nexit 1\n");
    spawnSync("chmod", ["+x", stub]);

    const lines: string[] = [];
    const handle = await (
      await import("../src/daemon.ts")
    ).startFleet({
      dir: fleetDir,
      port: PORT,
      host: "127.0.0.1",
      piBin: stub,
      log: (line) => lines.push(line),
    });

    const manifestPath = join(fleetDir, "bots.toml");
    const journalFor = (name: string) =>
      join(fleetDir, ".fleet", "transcripts", `${name}.jsonl`);

    try {
      // Boot: single bot, fleet serving.
      await waitFor(
        "initial roster",
        async () =>
          (await roster()).bots.map((b) => b.name).join(",") === "alpha"
      );

      // ── ADD bravo: row + dir via the filesystem only.
      mkdirSync(join(fleetDir, "bots", "bravo"), { recursive: true });
      writeFileSync(join(fleetDir, "bots", "bravo", "AGENTS.md"), "# bravo\n");
      writeFileSync(manifestPath, `${row("alpha")}\n${row("bravo")}\n`);
      await waitFor("bravo added to roster", async () =>
        (await roster()).bots.some((b) => b.name === "bravo")
      );
      assert.ok(
        lines.some((l) => l.includes('bot "bravo" added')),
        "add is logged"
      );

      // ── REMOVE alpha: row deleted; its journal survives; bravo keeps running.
      mkdirSync(join(fleetDir, ".fleet", "transcripts"), { recursive: true });
      writeFileSync(journalFor("alpha"), "persisted\n");
      writeFileSync(manifestPath, `${row("bravo")}\n`);
      await waitFor(
        "alpha removed from roster",
        async () => !(await roster()).bots.some((b) => b.name === "alpha")
      );
      assert.equal(existsSync(journalFor("alpha")), true, "journal survives");
      assert.ok(
        lines.some((l) => l.includes('bot "alpha" removed')),
        "removal is logged"
      );

      // ── INVALID manifest: old fleet keeps running, error surfaces.
      writeFileSync(manifestPath, "not toml at all {{{");
      await waitFor(
        "config error logged",
        async () => lines.some((l) => l.includes("config error:")),
        6000
      );
      const afterInvalid = await roster();
      assert.deepEqual(
        afterInvalid.bots.map((b) => b.name),
        ["bravo"],
        "bad edit keeps the running fleet"
      );

      // ── Fix the file, then change bravo's model → respawn.
      writeFileSync(manifestPath, `${row("bravo", "custom-model-x")}\n`);
      await waitFor(
        "bravo reconfigured",
        async () => lines.some((l) => l.includes('bot "bravo" reconfigured')),
        6000
      );
      const final = await roster();
      assert.deepEqual(
        final.bots.map((b) => b.name),
        ["bravo"]
      );
    } finally {
      await handle.stop();
      rmSync(fleetDir, { recursive: true, force: true });
    }
  }
);
