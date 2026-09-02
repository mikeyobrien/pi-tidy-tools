import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { binEntry, daemonRespawnArgs, restartSpawnArgs } from "../src/cli.ts";
import { describePortHolder } from "../src/cli-core.ts";

test("binEntry points at the shipped bin shim (cwd-independent runner)", () => {
  const entry = binEntry();
  assert.match(entry, /bin\/pi-tidy-bots\.mjs$/);
  assert.equal(existsSync(entry), true, "bin shim ships with the package");
});

test("daemonRespawnArgs: bin entry, no --daemon/--json, never --import tsx", () => {
  const argv = [
    process.execPath,
    "/somewhere/src/cli.ts",
    "start",
    "/tmp/fleet",
    "--port",
    "4317",
    "--daemon",
    "--json",
  ];
  const args = daemonRespawnArgs(argv);
  assert.equal(args[0], binEntry(), "entry forced to the package bin");
  assert.deepEqual(
    args.slice(1),
    ["start", "/tmp/fleet", "--port", "4317"],
    "same invocation minus --daemon/--json"
  );
  assert.ok(!args.includes("--import"), "no cwd-dependent --import tsx");
  assert.ok(!args.includes("--daemon"));
});

test("daemonRespawnArgs also works when the parent ran via the bin", () => {
  const argv = [process.execPath, binEntry(), "start", "--daemon"];
  const args = daemonRespawnArgs(argv);
  assert.deepEqual(args, [binEntry(), "start"]);
});

test("restartSpawnArgs boots a daemonized json start via the bin", () => {
  const args = restartSpawnArgs("/tmp/fleet", 4317, "pi-tidy-fleet");
  assert.deepEqual(args, [
    binEntry(),
    "start",
    "/tmp/fleet",
    "--daemon",
    "--json",
    "--port",
    "4317",
    "--fleet",
    "pi-tidy-fleet",
  ]);
  assert.ok(!args.includes("--import"));
  const bare = restartSpawnArgs("/tmp/fleet", 4599);
  assert.ok(!bare.includes("--fleet"), "no --fleet when unnamed");
});

test("probeDaemonIdentity fingerprints the serving fleet (issue 154)", async () => {
  const { probeDaemonIdentity } = await import("../src/cli-core.ts");
  const ok = (_url: string) =>
    Promise.resolve(
      new Response(JSON.stringify({ fleetDir: "/fleets/alpha" }), {
        status: 200,
      })
    );
  assert.deepEqual(
    await probeDaemonIdentity(4000, "/fleets/alpha", ok),
    { kind: "match", fleetDir: "/fleets/alpha" },
    "same fleet"
  );
  assert.deepEqual(
    await probeDaemonIdentity(4000, "/fleets/beta", ok),
    { kind: "foreign-fleet", fleetDir: "/fleets/alpha" },
    "different fleet on the port — loud refusal data"
  );
  const unreachable = () => Promise.reject(new Error("down"));
  assert.deepEqual(
    await probeDaemonIdentity(4000, "/fleets/alpha", unreachable),
    { kind: "unreachable" },
    "nothing serving"
  );
});

test("daemonCommandMatches recognizes bin and source daemons only (issue 135)", async () => {
  const { daemonCommandMatches, verifyDaemonPid } = await import(
    "../src/cli-core.ts"
  );
  assert.equal(
    daemonCommandMatches(
      "/opt/homebrew/bin/node /x/packages/pi-tidy-bots/bin/pi-tidy-bots.mjs start /fleet --port 4317"
    ),
    true,
    "bin daemon"
  );
  assert.equal(
    daemonCommandMatches(
      "node --import tsx /x/packages/pi-tidy-bots/src/cli.ts start /fleet"
    ),
    true,
    "source daemon"
  );
  assert.equal(
    daemonCommandMatches("mosh-server new -s -c 256"),
    false,
    "foreign process"
  );
  assert.equal(
    daemonCommandMatches("/x/pi-tidy-bots.mjs status /fleet"),
    false,
    "non-start subcommand"
  );
  // verifyDaemonPid: dead (ps misses), foreign (alive but not ours), ours.
  const ps = (rows: Record<number, string>) => (_file: string, args: string[]) => {
    const pid = Number(args[1]);
    if (pid in rows) return rows[pid];
    throw new Error("no such pid");
  };
  assert.deepEqual(
    verifyDaemonPid(123, ps({})),
    { kind: "dead", pid: 123 },
    "dead pid"
  );
  assert.deepEqual(
    verifyDaemonPid(123, ps({ 123: "top" })),
    { kind: "foreign", pid: 123, command: "top" },
    "foreign pid"
  );
  assert.deepEqual(
    verifyDaemonPid(
      123,
      ps({ 123: "node /x/pi-tidy-bots.mjs start /fleet" })
    ),
    { kind: "alive-daemon", pid: 123, command: "node /x/pi-tidy-bots.mjs start /fleet" },
    "our daemon"
  );
});

test("describePortHolder names every listening pid and command", () => {
  const fakeRun = (file: string, args: string[]) => {
    if (file === "lsof") return "4242\n4243\n"; // two holders (v4 + v6)
    if (file === "ps" && args.includes("4242"))
      return "node /repo/src/cli.ts start /tmp/f --daemon\n";
    if (file === "ps" && args.includes("4243"))
      return "mosh-server new -s -c 256\n";
    throw new Error("unexpected call");
  };
  const holder = describePortHolder(4317, fakeRun);
  assert.match(holder, /^held by pid 4242: node .*cli\.ts start/);
  assert.match(holder, /; pid 4243: mosh-server/);
});

test("describePortHolder stays silent when nothing holds the port", () => {
  assert.equal(
    describePortHolder(4317, () => ""),
    "",
    "no listener → empty string, not an error"
  );
  assert.equal(
    describePortHolder(4317, () => {
      throw new Error("lsof missing");
    }),
    "",
    "tool failure → empty string (best-effort)"
  );
});
