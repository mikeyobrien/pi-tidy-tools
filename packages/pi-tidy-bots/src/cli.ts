import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { startFleet } from "./daemon.ts";
import { loadFleetConfig, NAME_PATTERN } from "./config.ts";
import {
  CliError,
  daemonPidPath,
  EXIT,
  formatError,
  initJsonPayload,
  pickStopPid,
  pidAlive,
  readDaemonPid,
  resolveStartToken,
  startReadinessPayload,
  versionJsonPayload,
  waitForReady,
} from "./cli-core.ts";
import {
  buildPairingUrl,
  pickLanIp,
  readStoredToken,
  resolvePairingTarget,
} from "./pairing.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      const boolean = key === "qr" || key === "rotate-token" || key === "json";
      if (!boolean && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.log(`pi-tidy-bots — fleet runtime for Pi operator bots

Usage:
  pi-tidy-bots init <fleetDir>            Scaffold a demo fleet (Atlas ops + Forge worker)
  pi-tidy-bots start [fleetDir]           Start the fleet daemon and web UI
  pi-tidy-bots add <name> [--dir fleetDir] [--title t] [--avatar e]
                                          Scaffold a bot and append its manifest row
  pi-tidy-bots status [fleetDir]          Show daemon pid, port, per-bot state
  pi-tidy-bots stop [fleetDir]            Gracefully stop the running fleet

Start flags:
  --port <n>        Web UI port (default 4317, or [fleet] port in bots.toml)
  --host <addr>     Bind address (default 127.0.0.1). Non-loopback binds (0.0.0.0 or a LAN IP) auto-enable token auth: a token is minted and stored in .fleet/token if none exists, and printed in the ready block.
  --token <token>   Opt-in access token for the web UI (off by default — secure via your network instead)
  --qr              Print a terminal QR pairing the phone console (LAN IP + token)
  --rotate-token    Regenerate the stored fleet token (.fleet/token) before starting
  --tool-output <m> Tool output visibility in the console: off | reasons | full (default reasons)
  --bot <name>      Chat client: start with this bot selected
  --url <url>       Chat client: fleet daemon URL (default http://127.0.0.1:4317)
  --version         Print package version
  --json            Machine-readable output: init/start emit one JSON line; --version emits {name, version}
  --daemon          (start) Run detached; pid in .fleet/daemon.pid, log in .fleet/daemon.log
`);
  process.exit(1);
}

const DEMO_BOTS_TOML = `# pi-tidy-bots fleet manifest. One [[bot]] per operator bot.
[fleet]
port = 4317

[[bot]]
name = "atlas"
title = "Infrastructure Operator"
dir = "bots/atlas"
routes = ["forge"]

[[bot]]
name = "forge"
title = "Remediation Worker"
dir = "bots/forge"
`;

const ATLAS_AGENTS = `# Atlas — Infrastructure Operator

You are Atlas, an infrastructure operator bot in a pi-tidy-bots fleet.

## Voice
Terse by default: one to five sentences, status-shaped. Lead with the verdict
("Not stable." / "All green."), then at most two key facts. Never walls of text.
Light operator humor is welcome; clarity wins ties.

## Ops etiquette
- Never restart, bounce, or reconfigure systems owned by another bot. Route instead.

## Fleet
- Your teammate Forge (@forge) owns remediation work. Hand fixes to Forge with the
  message_agent tool, then finish your turn — Forge's reply arrives as a completion
  notification. Compose your own message; never forward the operator's words verbatim.
- Finish your turn promptly after a handoff. Fire-and-forget is the contract.
`;

const FORGE_AGENTS = `# Forge — Remediation Worker

You are Forge, a remediation worker bot in a pi-tidy-bots fleet.

## Voice
Terse: verdict first, at most two supporting facts. No filler.

## Work
- You own remediation: restarts, config fixes, rollbacks. Do the work, then report
  what you did and the resulting state.
- If a request is outside remediation (or owned by another bot), say so tersely and
  stop.
`;

function cmdInit(fleetDirArg: string | undefined, json: boolean): never {
  const fleetDir = resolve(fleetDirArg ?? ".");
  if (existsSync(join(fleetDir, "bots.toml"))) {
    console.error(`refusing to overwrite existing fleet at ${fleetDir}`);
    process.exit(2);
  }
  mkdirSync(join(fleetDir, "bots", "atlas"), { recursive: true });
  mkdirSync(join(fleetDir, "bots", "forge"), { recursive: true });
  writeFileSync(join(fleetDir, "bots.toml"), DEMO_BOTS_TOML);
  writeFileSync(join(fleetDir, "bots", "atlas", "AGENTS.md"), ATLAS_AGENTS);
  writeFileSync(join(fleetDir, "bots", "forge", "AGENTS.md"), FORGE_AGENTS);
  if (json) {
    console.log(JSON.stringify(initJsonPayload(fleetDir)));
  } else {
    console.log(`scaffolded demo fleet at ${fleetDir}`);
    console.log(`next: pi-tidy-bots start ${fleetDir}`);
  }
  process.exit(0);
}

function lanAddresses() {
  const out: { address: string; family: string; internal: boolean }[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      // Node reports family as either "IPv4" or 4 depending on version.
      out.push({
        address: a.address,
        family: String(a.family),
        internal: a.internal,
      });
    }
  }
  return out;
}

function starterPersona(name: string, title: string): string {
  return `# ${name} — ${title}

You are ${name}, a bot in a pi-tidy-bots fleet.

## Voice
Terse: verdict first, at most two supporting facts. No filler.

## Fleet
- Teammates are reachable with the message_agent tool (fire-and-forget;
  replies arrive as completion notifications).
- Finish your turn promptly after a handoff.
`;
}

export function scaffoldBot(
  fleetDir: string,
  name: string,
  options: { title?: string; avatar?: string } = {}
): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `bot name "${name}" must match ${NAME_PATTERN} (lowercase letter first, 2-32 chars)`
    );
  }
  const manifestPath = join(fleetDir, "bots.toml");
  if (!existsSync(manifestPath))
    throw new Error(`no bots.toml in fleet dir ${fleetDir}`);
  const manifest = readFileSync(manifestPath, "utf8");
  if (manifest.includes(`name = "${name}"`))
    throw new Error(`bot "${name}" already exists in bots.toml`);
  const title = options.title ?? "Fleet Bot";
  const avatar = options.avatar ?? "";
  const botDir = join(fleetDir, "bots", name);
  mkdirSync(botDir, { recursive: true });
  writeFileSync(join(botDir, "AGENTS.md"), starterPersona(name, title));
  const row = `\n[[bot]]\nname = "${name}"\ntitle = "${title}"\navatar = "${avatar}"\ndir = "bots/${name}"\n`;
  writeFileSync(
    manifestPath,
    `${manifest.endsWith("\n") ? manifest : manifest + "\n"}${row}`
  );
}

function cmdAdd(args: Args): never {
  const name = args.positional[0] ?? "";
  const fleetDir = resolve(
    typeof args.flags.dir === "string" ? args.flags.dir : "."
  );
  try {
    scaffoldBot(fleetDir, name, {
      title:
        typeof args.flags.title === "string" ? args.flags.title : undefined,
      avatar:
        typeof args.flags.avatar === "string" ? args.flags.avatar : undefined,
    });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  console.log(`scaffolded bots/${name}/AGENTS.md + appended the [[bot]] row`);
  console.log("editing bots.toml — the fleet picks it up live");
  process.exit(0);
}

/** Port for readiness/status when the manifest may be broken: parse or default. */
function bestEffortPort(fleetDir: string): number {
  try {
    // Lazy import keeps the hot path free of an extra round trip.
    return 0 + loadFleetConfig(fleetDir).port;
  } catch {
    return 4317;
  }
}

async function cmdStart(args: Args): Promise<void> {
  const dir = resolve(args.positional[0] ?? ".");
  const json = args.flags.json === true;
  const daemonize = args.flags.daemon === true;

  // Parent side of --daemon: spawn a detached child running the same start
  // (minus --daemon/--json), wait until it serves, print readiness, exit.
  if (daemonize && process.env.PI_TIDY_BOTS_DAEMON_CHILD !== "1") {
    const { spawn } = await import("node:child_process");
    const childArgs = process.argv
      .slice(1)
      .filter((arg) => arg !== "--daemon" && arg !== "--json");
    const logFile = join(dir, ".fleet", "daemon.log");
    mkdirSync(join(dir, ".fleet"), { recursive: true });
    const log = writeFileSync(logFile, "");
    void log;
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ["ignore", log as unknown as number, log as unknown as number],
      env: { ...process.env, PI_TIDY_BOTS_DAEMON_CHILD: "1" },
    });
    child.unref();
    const port =
      typeof args.flags.port === "string"
        ? Number(args.flags.port)
        : bestEffortPort(dir);
    const host =
      typeof args.flags.host === "string" ? args.flags.host : "127.0.0.1";
    const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    const token = readStoredToken(dir);
    const ready = await waitForReady(async () => {
      try {
        const res = await fetch(`${url}/api/fleet`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        return res.status === 200 || res.status === 401;
      } catch {
        return false;
      }
    }, 15000);
    if (!ready) {
      throw new CliError(
        `daemonized fleet did not become ready within 15s — log: ${logFile}`,
        { exitCode: EXIT.runtime, remedy: `inspect ${logFile}` }
      );
    }
    const pid = readDaemonPid(dir) ?? child.pid ?? 0;
    if (json) {
      console.log(JSON.stringify(startReadinessPayload(url, port, pid, token)));
    } else {
      console.log(
        `daemon started: pid ${pid} · ${url}${token ? " (token required)" : ""}`
      );
      console.log(`log: ${logFile}`);
    }
    process.exit(ready ? EXIT.ok : EXIT.runtime);
  }

  const wantsQr = args.flags.qr === true;
  const wantsRotate = args.flags["rotate-token"] === true;
  const explicitToken =
    typeof args.flags.token === "string" ? args.flags.token : undefined;
  const host =
    typeof args.flags.host === "string" ? args.flags.host : "127.0.0.1";

  // Token resolution (issue 29 item 1): --rotate-token mints fresh; --token
  // persists an explicit one; --qr generates for pairing; and a non-loopback
  // bind ALWAYS carries a token (0.0.0.0 auto-enables auth).
  const resolution = resolveStartToken({
    fleetDir: dir,
    host,
    explicitToken,
    wantsQr,
    wantsRotate,
  });
  const resolvedToken = resolution.token;
  if (resolution.rotated) console.log(`rotated fleet token: ${resolvedToken}`);

  const handle = await startFleet({
    dir,
    port:
      typeof args.flags.port === "string" ? Number(args.flags.port) : undefined,
    host,
    token: resolvedToken,
    toolOutput:
      typeof args.flags["tool-output"] === "string"
        ? (args.flags["tool-output"] as any)
        : undefined,
    log: json ? (line) => console.error(line) : (line) => console.log(line),
  });
  const displayToken = handle.token ?? "";
  if (process.env.PI_TIDY_BOTS_DAEMON_CHILD === "1") {
    writeFileSync(daemonPidPath(dir), String(process.pid));
  }
  if (json) {
    // One clean readiness line on stdout — daemon chatter goes to stderr.
    console.log(
      JSON.stringify(
        startReadinessPayload(
          handle.url,
          Number(new URL(handle.url).port),
          process.pid,
          displayToken || undefined
        )
      )
    );
  } else {
    console.log(
      `\npi-tidy-bots ready: ${handle.url}${displayToken ? `/?token=${displayToken}` : ""}`
    );
    if (displayToken) console.log(`token: ${displayToken}`);
    if (wantsQr && displayToken) {
      const port = Number(new URL(handle.url).port);
      const lanIp = pickLanIp({ addresses: lanAddresses() });
      const target = resolvePairingTarget(host, lanIp);
      if (!target.ok) {
        console.log(`qr: skipped — ${target.reason}`);
      } else {
        const url = buildPairingUrl(target.ip, port, displayToken);
        const { renderUnicode } = await import("uqr");
        console.log(
          `\nscan to open the console on your phone:\n\n${renderUnicode(url)}`
        );
        console.log(url);
      }
    }
    console.log(
      "Ctrl-C stops the fleet. Sessions persist under .fleet/sessions/.\n"
    );
  }
  process.on("SIGINT", () => {
    console.log("\nstopping fleet…");
    void handle.stop().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void handle.stop().then(() => process.exit(0));
  });
  await new Promise<never>(() => {});
}

function printVersion(json: boolean): void {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  console.log(
    json
      ? JSON.stringify(versionJsonPayload(manifest.name, manifest.version))
      : `${manifest.name} ${manifest.version}`
  );
}

async function cmdStatus(args: Args, json: boolean): Promise<void> {
  const dir = resolve(args.positional[0] ?? ".");
  const pid = readDaemonPid(dir) ?? pickStopPid(dir)?.pid;
  const port = bestEffortPort(dir);
  const url = `http://127.0.0.1:${port}`;
  const token = readStoredToken(dir);
  let bots: { name: string; online: boolean; queued: number }[] = [];
  try {
    const res = await fetch(`${url}/api/fleet`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = (await res.json()) as {
        bots?: { name: string; online: boolean; queued: number }[];
      };
      bots = (data.bots ?? []).map((b) => ({
        name: b.name,
        online: b.online,
        queued: b.queued,
      }));
    }
  } catch {
    // Daemon not serving — fall through to the not-running error below.
  }
  const running = bots.length > 0 || (pid !== undefined && pidAlive(pid));
  if (!running) {
    throw new CliError("fleet is not running", {
      exitCode: EXIT.runtime,
      remedy: "pi-tidy-bots start <dir>",
    });
  }
  if (json) {
    console.log(JSON.stringify({ pid, port, url, bots }));
    return;
  }
  console.log(`daemon: pid ${pid ?? "?"} · port ${port}`);
  for (const bot of bots) {
    console.log(
      `${bot.online ? "●" : "○"} ${bot.name} — ${bot.online ? "online" : "offline"}${bot.queued > 0 ? ` · queued ${bot.queued}` : ""}`
    );
  }
}

async function cmdStop(args: Args, json: boolean): Promise<void> {
  const dir = resolve(args.positional[0] ?? ".");
  const stop = pickStopPid(dir);
  if (!stop) {
    throw new CliError("fleet is not running", {
      exitCode: EXIT.usage,
      remedy: "pi-tidy-bots start <dir>",
    });
  }
  if (!pidAlive(stop.pid)) {
    // Stale pidfile/lock: the fleet is already gone.
    rmSync(daemonPidPath(dir), { force: true });
    throw new CliError("fleet is not running", {
      exitCode: EXIT.usage,
      remedy: "pi-tidy-bots start <dir>",
    });
  }
  try {
    process.kill(stop.pid, "SIGTERM");
  } catch {
    // Died between the liveness probe and the signal — same as stopped.
  }
  // Wait for a graceful shutdown: pid gone (lock is released on the way out).
  const graceful = await waitForReady(() => !pidAlive(stop.pid), 10_000, 200);
  if (!graceful) {
    process.kill(stop.pid, "SIGKILL");
    const killed = await waitForReady(() => !pidAlive(stop.pid), 3_000, 100);
    if (!killed) {
      throw new CliError(`fleet pid ${stop.pid} refused to stop`, {
        exitCode: EXIT.runtime,
      });
    }
  }
  rmSync(daemonPidPath(dir), { force: true });
  if (json) {
    console.log(JSON.stringify({ stopped: true, pid: stop.pid }));
  } else {
    console.log(`fleet stopped (pid ${stop.pid})`);
  }
}

async function cmdChat(args: Args): Promise<void> {
  const { startChat } = await import("./tui.ts");
  startChat({
    url:
      typeof args.flags.url === "string"
        ? args.flags.url
        : "http://127.0.0.1:4317",
    bot: typeof args.flags.bot === "string" ? args.flags.bot : undefined,
    token: typeof args.flags.token === "string" ? args.flags.token : undefined,
  });
  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional.shift();
  try {
    if (args.flags.version !== undefined) {
      printVersion(args.flags.json === true);
      return;
    }
    if (command === "init")
      cmdInit(args.positional[0], args.flags.json === true);
    if (command === "chat") return void (await cmdChat(args));
    if (command === "add") cmdAdd(args);
    if (command === "start") return void (await cmdStart(args));
    if (command === "status") {
      await cmdStatus(args, args.flags.json === true);
      return;
    }
    if (command === "stop") {
      await cmdStop(args, args.flags.json === true);
      return;
    }
    if (command === "id") {
      console.log(randomUUID());
      process.exit(0);
    }
    usage();
  } catch (error) {
    if (error instanceof CliError) {
      // Lifecycle/status failures: one clean line on stderr, classified exit.
      console.error(formatError(error));
      process.exit(error.exitCode);
    }
    throw error;
  }
}

await main();
