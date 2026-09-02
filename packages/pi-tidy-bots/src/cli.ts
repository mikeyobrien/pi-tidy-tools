import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { startFleet } from "./daemon.ts";
import {
  loadRegistry,
  pruneRegistry,
  registerFleet,
  registryPath,
  resolveFleetRecord,
} from "./fleets.ts";
import { DAEMON_REVISION } from "./revision.ts";
import { loadFleetConfig, ConfigError, NAME_PATTERN } from "./config.ts";
import { createRotatingLogWriter } from "./logs.ts";
import {
  closestFlag,
  CliError,
  classifyStartFailure,
  daemonPidPath,
  EXIT,
  formatError,
  initJsonPayload,
  pickStopPid,
  pidAlive,
  readDaemonPid,
  readLockHolderPid,
  resolveStartToken,
  startReadinessPayload,
  versionJsonPayload,
  waitForReady,
  healthCheck,
  isPortHeld,
  waitPortReleased,
  describePortHolder,
  verifyDaemonPid,
  probeDaemonIdentity,
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

const SHARED_FLAGS = ["help", "json", "version"];
const COMMAND_FLAGS: Record<string, string[]> = {
  init: [],
  start: [
    "port",
    "host",
    "token",
    "qr",
    "rotate-token",
    "tool-output",
    "daemon",
    "fleet",
  ],
  add: ["dir", "title", "avatar", "description"],
  chat: ["bot", "url", "token"],
  status: ["fleet"],
  stop: ["fleet"],
  restart: ["fleet"],
  fleets: ["prune", "json"],
  id: [],
};

function parseArgs(argv: string[], command?: string): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const known = new Set([
    ...SHARED_FLAGS,
    ...(command ? (COMMAND_FLAGS[command] ?? []) : []),
  ]);
  const boolean = (key: string) =>
    key === "qr" || key === "rotate-token" || key === "json";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // Issue 29 item 5: unknown flags are hard errors — silent no-ops are
      // the worst failure class for unattended agents.
      if (!known.has(key)) {
        const suggestion = closestFlag(key, [...known]);
        throw new CliError(
          `unknown flag --${key} for ${command ?? "cli"}${
            suggestion ? ` [did you mean --${suggestion}?]` : ""
          }`,
          { exitCode: EXIT.usage, remedy: `run pi-tidy-bots --help` }
        );
      }
      const next = argv[index + 1];
      if (!boolean(key) && next !== undefined && !next.startsWith("--")) {
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
  console.error(`pi-tidy-bots — fleet runtime for Pi operator bots

Usage:
  pi-tidy-bots init <fleetDir>            Scaffold a demo fleet (Atlas ops + Forge worker)
  pi-tidy-bots start [fleetDir]           Start the fleet daemon and web UI
  pi-tidy-bots add <name> [--dir fleetDir] [--title t] [--avatar e] [--description d]
                                          Scaffold a bot and append its manifest row
  pi-tidy-bots status [fleetDir]          Show daemon pid, port, per-bot state
  pi-tidy-bots fleets [--prune]           List registered fleets and running state
  pi-tidy-bots start --fleet <name>       Target a registered fleet by name
  pi-tidy-bots stop [fleetDir]            Gracefully stop the running fleet
  pi-tidy-bots restart [fleetDir|--fleet <name>]  Sanctioned stop + boot + health-check

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
  --fleet <name>    Target a registered fleet by name; start registers it (default name: dir basename)
  --prune           (fleets) Drop entries whose directory no longer exists
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
- Fleet daemon restarts are the operator's, via \`pi-tidy-bots restart\` only — never raw kill/nohup chains.

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

## Ops etiquette
- Fleet daemon restarts are the operator's, via \`pi-tidy-bots restart\` only — never raw kill/nohup chains.

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
  options: { title?: string; avatar?: string; description?: string } = {}
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
  const description = options.description ?? "";
  const botDir = join(fleetDir, "bots", name);
  mkdirSync(botDir, { recursive: true });
  writeFileSync(join(botDir, "AGENTS.md"), starterPersona(name, title));
  // TOML string escaping: manifest rows are byte fragments, not parsed and
  // re-emitted — escape backslashes and quotes so values never break the file.
  const tomlString = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const row =
    `\n[[bot]]\nname = ${tomlString(name)}\ntitle = ${tomlString(title)}\navatar = ${tomlString(avatar)}` +
    (description ? `\ndescription = ${tomlString(description)}` : "") +
    `\ndir = "bots/${name}"\n`;
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
      description:
        typeof args.flags.description === "string"
          ? args.flags.description
          : undefined,
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

/** Persist the daemon bind host into .fleet/state.json so restarts replay it. */
function persistDaemonHost(fleetDir: string, host: string): void {
  try {
    const statePath = join(fleetDir, ".fleet", "state.json");
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(readFileSync(statePath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // First boot: no state yet.
    }
    if (state.host === host) return;
    state.host = host;
    mkdirSync(join(fleetDir, ".fleet"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: host persistence must never block a start.
  }
}

async function cmdStart(args: Args): Promise<void> {
  // Target resolution (issue 42): --fleet <name> resolves via the registry; a
  // path argument keeps working and registers implicitly under its basename.
  const fleetName =
    typeof args.flags.fleet === "string" ? args.flags.fleet : undefined;
  let dir: string;
  let portFlag: number | undefined =
    typeof args.flags.port === "string" ? Number(args.flags.port) : undefined;
  dir = resolve(args.positional[0] ?? ".");
  if (fleetName) {
    // Named start: reuse a previously recorded port unless --port overrides.
    // An explicit path argument is authoritative — the record may be stale
    // for this dir (e.g. a previous temp fleet under the same name).
    const record =
      args.positional[0] === undefined
        ? resolveFleetRecord(registryPath(), fleetName)
        : undefined;
    if (!record && args.positional[0] === undefined) {
      throw new CliError(`unknown fleet "${fleetName}"`, {
        exitCode: EXIT.usage,
        remedy: "pi-tidy-bots fleets",
      });
    }
    if (portFlag === undefined && record) portFlag = record.port;
  } else {
    const basename = dir.split("/").pop() || dir;
    registerFleet(registryPath(), {
      name: basename,
      dir,
      port: portFlag,
    });
  }
  const json = args.flags.json === true;
  const daemonize = args.flags.daemon === true;
  // Issue 51 follow-up: remember an explicit bind host so sanctioned restarts
  // replay it instead of silently rebinding to 127.0.0.1.
  if (typeof args.flags.host === "string" && args.flags.host !== "127.0.0.1") {
    persistDaemonHost(dir, args.flags.host);
  }
  // Issue 51: tee daemon output to .fleet/logs/daemon.log (size-capped).
  const logWriter = createRotatingLogWriter(
    join(dir, ".fleet", "logs"),
    "daemon.log"
  );

  // Parent side of --daemon: spawn a detached child running the same start
  // (minus --daemon/--json), wait until it serves, print readiness, exit.
  if (daemonize && process.env.PI_TIDY_BOTS_DAEMON_CHILD !== "1") {
    const { spawn } = await import("node:child_process");
    const childArgs = daemonRespawnArgs(process.argv);
    const logsDir = join(dir, ".fleet", "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "daemon.log");
    // Issue 51: bootstrap-level capture — the child's stdout/stderr ARE the
    // log file (append, never truncated). A crash before main() runs (module
    // resolution, node option parsing) still lands in .fleet/logs/daemon.log;
    // a replacement daemon is never silent. The parent's fd can close right
    // after spawn: the child keeps its own copy for its whole life.
    const logFd = openSync(logFile, "a");
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PI_TIDY_BOTS_DAEMON_CHILD: "1" },
    });
    child.unref();
    closeSync(logFd);
    const host =
      typeof args.flags.host === "string" ? args.flags.host : "127.0.0.1";
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const token = readStoredToken(dir);
    const readyMs = Number(process.env.PI_TIDY_BOTS_DAEMON_READY_MS ?? "15000");

    // Issue 42 regression fix: with --port 0 the OS-assigned port is unknown
    // until the child reports it into the registry — the readiness poll MUST
    // re-read the registry every iteration instead of resolving once pre-boot.
    let readyUrl = "";
    let readyPort = 0;
    let ready = false;
    const expectedDir = resolve(dir);
    const deadline = Date.now() + readyMs;
    for (;;) {
      // A dead child can never become ready — bail instead of burning the
      // whole timeout window.
      if (child.pid && !pidAlive(child.pid)) break;
      const record = fleetName
        ? resolveFleetRecord(registryPath(), fleetName)
        : undefined;
      // Re-read the stored token every iteration: the child persists it
      // during boot, and both probes below need it on a token-protected
      // fleet (issue 51: /api/version without the credential 401s and the
      // parent would kill a perfectly healthy child at timeout).
      const probeToken = readStoredToken(dir);
      const probeHeaders: Record<string, string> = probeToken
        ? { authorization: `Bearer ${probeToken}` }
        : {};
      const port =
        record?.port ??
        (portFlag !== undefined ? portFlag : bestEffortPort(dir));
      if (port) {
        const url = `http://${displayHost}:${port}`;
        try {
          // Identity check against /api/version: a DIFFERENT daemon on this
          // port must never satisfy our readiness (issue 42 orphan repro).
          const res = await fetch(`${url}/api/version`, {
            headers: probeHeaders,
          });
          if (res.ok) {
            const payload = (await res.json()) as { fleetDir?: string };
            if (payload.fleetDir && resolve(payload.fleetDir) === expectedDir) {
              // Issue 51: health-check the actual fleet API before ready.
              const health = await fetch(`${url}/api/fleet`, {
                headers: probeHeaders,
              });
              if (health.ok) {
                readyUrl = url;
                readyPort = port;
                ready = true;
                break;
              }
            }
          }
        } catch {
          // Not serving yet — keep polling.
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) {
      // Never leave an orphaned daemon behind a failed readiness wait.
      try {
        if (child.pid) process.kill(child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      const reaped = await waitForReady(
        () => child.pid === undefined || !pidAlive(child.pid),
        3000,
        100
      );
      if (!reaped && child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        await waitForReady(
          () => child.pid === undefined || !pidAlive(child.pid),
          2000,
          100
        );
      }
      throw new CliError(
        `daemonized fleet did not become ready within ${Math.round(readyMs / 1000)}s${
          reaped ? "" : " (child kill signaled)"
        } — log: ${logFile}`,
        { exitCode: EXIT.runtime, remedy: `inspect ${logFile}` }
      );
    }
    const pid = readDaemonPid(dir) ?? child.pid ?? 0;
    if (json) {
      console.log(
        JSON.stringify(startReadinessPayload(readyUrl, readyPort, pid, token))
      );
    } else {
      console.log(
        `daemon started: pid ${pid} · ${readyUrl}${token ? " (token required)" : ""}`
      );
      console.log(`log: ${logFile}`);
    }
    process.exit(EXIT.ok);
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

  let handle;
  try {
    handle = await startFleet({
      dir,
      port: portFlag,
      host,
      token: resolvedToken,
      toolOutput:
        typeof args.flags["tool-output"] === "string"
          ? (args.flags["tool-output"] as any)
          : undefined,
      // Issue 51: tee — human mode mirrors to stdout; --json keeps stdout
      // pristine (daemon chatter on stderr) while the file always gets it.
      log: (line) => {
        logWriter.write(line);
        // Daemonized child: stdout/stderr already ARE the log file (fd
        // wiring above) — printing again would duplicate every line.
        if (process.env.PI_TIDY_BOTS_DAEMON_CHILD === "1") return;
        if (json) console.error(line);
        else console.log(line);
      },
    });
    if (fleetName) {
      // Child reports the OS-assigned port back into the registry (issue 42).
      registerFleet(registryPath(), {
        name: fleetName,
        dir,
        port: handle.port,
        tokenFile: ".fleet/token",
      });
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      // Manifest/lock failures keep their message (lock holder pid included)
      // but surface as one clean line with a classified exit code.
      throw new CliError(error.message, {
        exitCode: classifyStartFailure(error.message),
      });
    }
    // Issue 51: a bare EADDRINUSE fatal is unautopsiable — name the holder.
    const message = (error as Error).message ?? String(error);
    if (/eaddrinuse|address already in use/i.test(message)) {
      const port = portFlag ?? bestEffortPort(dir);
      const holder = describePortHolder(port);
      throw new CliError(
        `port ${port} is already in use${holder ? ` — ${holder}` : ""}`,
        {
          exitCode: EXIT.port,
          remedy:
            "stop the holder (pi-tidy-bots stop / restart) or pass --port",
        }
      );
    }
    throw error;
  }
  const displayToken = handle.token ?? "";
  // Issue 135: the pidfile is claimed on EVERY boot — foreground starts
  // too (the old daemon-child-only write left foreground daemons
  // unmanageable by sanctioned restart). Clean foreground exits un-claim
  // it so no stale pid survives.
  const pidFile = daemonPidPath(dir);
  writeFileSync(pidFile, String(process.pid));
  // Issue 154: persist the SERVING port — CLI --port starts have no other
  // discoverable record (manifest may lack [fleet] port), and lifecycle
  // identity needs pid↔port binding before any signal.
  writeFileSync(join(dir, ".fleet", "port"), String(handle.port));
  if (process.env.PI_TIDY_BOTS_DAEMON_CHILD !== "1") {
    const releasePidFile = () => {
      try {
        if (readFileSync(pidFile, "utf8").trim() === String(process.pid))
          rmSync(pidFile, { force: true });
      } catch {
        /* already gone */
      }
    };
    process.on("exit", releasePidFile);
    process.on("SIGINT", () => {
      releasePidFile();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      releasePidFile();
      process.exit(0);
    });
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
  if (json) {
    console.log(
      JSON.stringify({
        ...versionJsonPayload(manifest.name, manifest.version),
        ...(DAEMON_REVISION ? { commit: DAEMON_REVISION.short } : {}),
      })
    );
    return;
  }
  const suffix = DAEMON_REVISION ? ` (${DAEMON_REVISION.short})` : "";
  console.log(`${manifest.name} ${manifest.version}${suffix}`);
}

async function cmdStatus(args: Args, json: boolean): Promise<void> {
  const fleetName =
    typeof args.flags.fleet === "string" ? args.flags.fleet : undefined;
  const record = fleetName
    ? resolveFleetRecord(registryPath(), fleetName)
    : undefined;
  if (fleetName && !record) {
    throw new CliError(`unknown fleet "${fleetName}"`, {
      exitCode: EXIT.usage,
      remedy: "pi-tidy-bots fleets",
    });
  }
  const dir = record?.dir ?? resolve(args.positional[0] ?? ".");
  const pid = readDaemonPid(dir) ?? pickStopPid(dir)?.pid;
  const port = record?.port ?? bestEffortPort(dir);
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
  // Issue 135: a stale pidfile must not fake "running" — verify the pid
  // is a live daemon; stale files are cleaned on sight.
  let running = bots.length > 0;
  if (!running && pid !== undefined) {
    const check = verifyDaemonPid(pid);
    if (check.kind === "alive-daemon") running = true;
    else rmSync(daemonPidPath(dir), { force: true });
  }
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

/** Resolve the dir for stop/restart: --fleet name via registry, else path. */
function resolveFleetTarget(args: Args): string {
  const fleetName =
    typeof args.flags.fleet === "string" ? args.flags.fleet : undefined;
  const record = fleetName
    ? resolveFleetRecord(registryPath(), fleetName)
    : undefined;
  if (fleetName && !record) {
    throw new CliError(`unknown fleet "${fleetName}"`, {
      exitCode: EXIT.usage,
      remedy: "pi-tidy-bots fleets",
    });
  }
  return record?.dir ?? resolve(args.positional[0] ?? ".");
}

/**
 * Issue 135: resolve the pid sanctioned stop/restart may signal. The
 * pidfile wins (verified alive AND a fleet daemon); a dead or foreign
 * entry is stale-cleaned and never signalled (pid-reuse kills the wrong
 * process). With no usable pidfile, a daemon holding the configured port
 * is ADOPTED — foreground starts and orphaned daemons stay manageable.
 */
/** Issue 154: the port this fleet's daemon actually serves. Boot-written
 * .fleet/port wins (CLI --port starts), then a registry record matching
 * the dir, then the manifest. Default only when nothing better exists. */
function servingPortFor(dir: string): number {
  try {
    const port = Number(
      readFileSync(join(dir, ".fleet", "port"), "utf8").trim()
    );
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    /* no boot-written port */
  }
  try {
    const record = loadRegistry(registryPath()).find(
      (entry: { dir: string; port?: number }) =>
        entry.dir === resolve(dir) && typeof entry.port === "number"
    );
    if (record && record.port) return record.port;
  } catch {
    /* registry unreadable */
  }
  return bestEffortPort(dir);
}

async function resolveManageableDaemon(
  dir: string
): Promise<
  | { status: "manage"; pid: number; from: "daemon.pid" | "lock.json" | "port" }
  | { status: "stale"; pid: number }
  | { status: "foreign"; pid: number; command: string }
  | { status: "foreign-fleet"; pid: number; fleetDir: string }
  | { status: "absent" }
> {
  const identityPort = servingPortFor(dir);
  const identity = async (pid: number) => {
    if (!identityPort) return "match" as const;
    const probe = await probeDaemonIdentity(identityPort, resolve(dir));
    if (probe.kind === "match") return "match" as const;
    if (probe.kind === "foreign-fleet")
      return { foreign: true, fleetDir: probe.fleetDir } as const;
    // Unreachable: pid verified as a daemon command but not serving — a
    // daemon mid-boot/mid-exit. Treat as not ours to signal (refuse).
    return { foreign: true, fleetDir: "(not serving)" } as const;
  };
  const stop = pickStopPid(dir);
  if (stop) {
    const check = verifyDaemonPid(stop.pid);
    if (check.kind === "alive-daemon") {
      // Issue 154: bind pidfile pid ↔ port holder — a live daemon pid that
      // is NOT the process holding this fleet's port is a cross-wired
      // pidfile (concurrent fleets). Refuse before any probe.
      if (identityPort) {
        const holder = describePortHolder(identityPort);
        const holderMatch = /pid (\d+)/.exec(holder);
        const holderPid = holderMatch ? Number(holderMatch[1]) : undefined;
        if (holderPid !== undefined && holderPid !== stop.pid) {
          return {
            status: "foreign-fleet",
            pid: stop.pid,
            fleetDir: `port :${identityPort} is held by pid ${holderPid}, not pidfile pid ${stop.pid}`,
          };
        }
      }
      const id = await identity(stop.pid);
      if (id === "match")
        return { status: "manage", pid: stop.pid, from: stop.from };
      return {
        status: "foreign-fleet",
        pid: stop.pid,
        fleetDir: (id as { fleetDir: string }).fleetDir,
      };
    }
    if (check.kind === "foreign")
      return { status: "foreign", pid: stop.pid, command: check.command };
    rmSync(daemonPidPath(dir), { force: true });
    return { status: "stale", pid: stop.pid };
  }
  // No pidfile: a fleet daemon on the configured port is still ours to
  // manage (foreground boots never claimed the file before issue 135) —
  // but ONLY when the port's fingerprint is THIS fleet (issue 154).
  if (identityPort) {
    const id = await identity(0);
    if (id !== "match") return { status: "absent" };
    const holder = describePortHolder(identityPort);
    const match = /pid (\d+)/.exec(holder);
    const pid = match ? Number(match[1]) : undefined;
    if (pid !== undefined) {
      const check = verifyDaemonPid(pid);
      if (check.kind === "alive-daemon")
        return { status: "manage", pid, from: "port" };
    }
  }
  return { status: "absent" };
}

/** Gracefully stop the fleet at dir; throws CliError when not running. */
async function stopFleetAt(dir: string): Promise<number> {
  const resolved = await resolveManageableDaemon(dir);
  if (resolved.status === "foreign-fleet") {
    throw new CliError(
      `refusing to signal pid ${resolved.pid}: it belongs to fleet ${resolved.fleetDir} (or is not serving) — not ${dir}. Concurrent-fleet ambiguity; investigate before stopping.`,
      {
        exitCode: EXIT.conflict,
        remedy: "check pi-tidy-bots fleets; fix the pidfile or registry entry",
      }
    );
  }
  if (resolved.status === "absent" || resolved.status === "stale") {
    throw new CliError("fleet is not running", {
      exitCode: EXIT.usage,
      remedy: "pi-tidy-bots start <dir>",
    });
  }
  if (resolved.status === "foreign") {
    rmSync(daemonPidPath(dir), { force: true });
    throw new CliError(
      `pidfile pointed at pid ${resolved.pid} (${resolved.command.slice(0, 80)}) which is not this fleet's daemon — refusing to signal; stale pidfile cleared`,
      { exitCode: EXIT.conflict, remedy: "pi-tidy-bots start <dir>" }
    );
  }
  const stop = { pid: resolved.pid };
  try {
    process.kill(stop.pid, "SIGTERM");
  } catch {
    // Died between the liveness probe and the signal - same as stopped.
  }
  const graceful = await waitForReady(() => !pidAlive(stop.pid), 10_000, 200);
  if (!graceful) {
    process.kill(stop.pid, "SIGKILL");
    await waitForReady(() => !pidAlive(stop.pid), 3_000, 100);
  }
  // The daemon is gone: clear its pidfile either way.
  rmSync(daemonPidPath(dir), { force: true });
  return stop.pid;
}

async function cmdStop(args: Args, json: boolean): Promise<void> {
  const dir = resolveFleetTarget(args);
  const pid = await stopFleetAt(dir);
  if (json) {
    console.log(JSON.stringify({ stopped: true, pid }));
  } else {
    console.log(`fleet stopped (pid ${pid})`);
  }
}

async function cmdRestart(args: Args, json: boolean): Promise<void> {
  const dir = resolveFleetTarget(args);
  const fleetName =
    typeof args.flags.fleet === "string" ? args.flags.fleet : undefined;

  // 1. Stop (graceful; tolerates not-running so restart heals a dark fleet).
  let stoppedPid: number | undefined;
  try {
    stoppedPid = await stopFleetAt(dir);
  } catch {
    // Nothing running - restart is still the sanctioned boot path.
  }
  // 2. Wait for the port to release before booting the replacement.
  const port = bestEffortPort(dir);
  await waitPortReleased(port, 10_000);
  // Replay a persisted non-loopback bind host (issue 51): a sanctioned
  // restart must not silently rebind the fleet to 127.0.0.1.
  let host: string | undefined;
  try {
    const state = JSON.parse(
      readFileSync(join(dir, ".fleet", "state.json"), "utf8")
    ) as { host?: string };
    if (typeof state.host === "string" && state.host !== "127.0.0.1") {
      host = state.host;
    }
  } catch {
    // No state file: default binding applies.
  }
  // 3. Boot daemonized; the daemonize parent health-checks /api/fleet (with
  //    the preserved .fleet/token) before reporting ready. Spawned via the
  //    package bin (issue 51): native stripping first, tsx fallback resolved
  //    from the package — boots from any cwd, including a bot's working dir.
  //    PI_TIDY_BOTS_DAEMON_CHILD must NOT be set here: the spawned start is
  //    the daemonize PARENT — marking it as the child would skip detachment
  //    and hang restart for the daemon's whole life (the durable-daemonize
  //    flake).
  const child = spawn(
    process.execPath,
    restartSpawnArgs(dir, port, fleetName, host),
    {
      stdio: "inherit",
    }
  );
  const exited = await new Promise<number>((resolve) => {
    child.on("exit", (code: number | null) => resolve(code ?? 1));
  });
  if (json) {
    console.log(
      JSON.stringify({
        restarted: exited === 0,
        stoppedPid: stoppedPid ?? undefined,
        pid: readDaemonPid(dir),
      })
    );
  }
  process.exit(exited === 0 ? EXIT.ok : EXIT.runtime);
}

function cliEntry(): string {
  return fileURLToPath(import.meta.url);
}

/**
 * The package bin shim — the cwd-independent way to run this CLI. It prefers
 * Node's native type stripping (engines: >=22.19) and falls back to tsx via
 * require.resolve from the package itself, so it boots from ANY cwd.
 */
export function binEntry(): string {
  return fileURLToPath(new URL("../bin/pi-tidy-bots.mjs", import.meta.url));
}

/**
 * Issue 51: respawn argv for the daemonized child — the same invocation
 * minus --daemon/--json, entry forced to the package bin. Never emits
 * `--import tsx` (that resolved tsx from the *caller's* cwd and killed
 * replacement daemons before main() could land — incident 2026-09-01 09:10).
 */
export function daemonRespawnArgs(argv: string[]): string[] {
  return [
    binEntry(),
    ...argv.slice(2).filter((arg) => arg !== "--daemon" && arg !== "--json"),
  ];
}

/** Issue 51: argv for `restart`'s daemonized boot of the replacement. */
export function restartSpawnArgs(
  dir: string,
  port: number,
  fleetName?: string,
  host?: string
): string[] {
  return [
    binEntry(),
    "start",
    dir,
    "--daemon",
    "--json",
    "--port",
    String(port),
    ...(host ? ["--host", host] : []),
    ...(fleetName ? ["--fleet", fleetName] : []),
  ];
}

function cmdFleets(args: Args): never {
  const json = args.flags.json === true;
  const prune = args.flags.prune === true;
  const registry = registryPath();
  const records = loadRegistry(registry);
  const dead = prune ? pruneRegistry(registry) : [];
  const rows = records.map((entry) => {
    const pid = readLockHolderPid(entry.dir);
    const running = pid !== undefined && pidAlive(pid);
    return { name: entry.name, dir: entry.dir, port: entry.port, running, pid };
  });
  if (json) {
    console.log(
      JSON.stringify({
        fleets: rows,
        pruned: prune ? dead.map((d: { name: string }) => d.name) : undefined,
      })
    );
  } else {
    for (const row of rows) {
      console.log(
        `${row.running ? "●" : "○"} ${row.name} — ${row.dir}${row.port ? ` :${row.port}` : ""} ${row.running ? `(pid ${row.pid})` : ""}`
      );
    }
    if (rows.length === 0) console.log("no registered fleets");
    if (prune && dead.length > 0)
      console.log(
        `pruned: ${dead.map((d: { name: string }) => d.name).join(", ")}`
      );
  }
  process.exit(0);
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

export async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const args = parseArgs(rest, command);
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
    if (command === "restart") {
      await cmdRestart(args, args.flags.json === true);
      return;
    }
    if (command === "fleets") cmdFleets(args);
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

// Direct invocation (node cli.ts, `--import tsx cli.ts`, or the bin shim
// spawning the entry) runs main here. Imported by tests (config.test.ts
// pulls scaffoldBot) or by the bin shim (which calls main explicitly), the
// module stays side-effect free.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
