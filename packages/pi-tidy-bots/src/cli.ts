import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startFleet } from "./daemon.ts";
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
      if (next !== undefined && !next.startsWith("--")) {
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

Start flags:
  --port <n>        Web UI port (default 4317, or [fleet] port in bots.toml)
  --host <addr>     Bind address (default 127.0.0.1; use 0.0.0.0 for tailnet/LAN, token auth auto-enables)
  --token <token>   Opt-in access token for the web UI (off by default — secure via your network instead)
  --tool-output <m> Tool output visibility in the console: off | reasons | full (default reasons)
  --bot <name>      Chat client: start with this bot selected
  --url <url>       Chat client: fleet daemon URL (default http://127.0.0.1:4317)
  --version         Print package version
`);
  process.exit(1);
}

const DEMO_BOTS_TOML = `# pi-tidy-bots fleet manifest. One [[bot]] per operator bot.
[fleet]
port = 4317

[[bot]]
name = "atlas"
title = "Infrastructure Operator"
avatar = "🛰️"
dir = "bots/atlas"
routes = ["forge"]

[[bot]]
name = "forge"
title = "Remediation Worker"
avatar = "🔨"
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

function cmdInit(fleetDirArg: string | undefined): never {
  const fleetDir = resolve(fleetDirArg ?? ".");
  if (existsSync(join(fleetDir, "bots.toml"))) {
    console.error(`refusing to overwrite existing fleet at ${fleetDir}`);
    process.exit(1);
  }
  mkdirSync(join(fleetDir, "bots", "atlas"), { recursive: true });
  mkdirSync(join(fleetDir, "bots", "forge"), { recursive: true });
  writeFileSync(join(fleetDir, "bots.toml"), DEMO_BOTS_TOML);
  writeFileSync(join(fleetDir, "bots", "atlas", "AGENTS.md"), ATLAS_AGENTS);
  writeFileSync(join(fleetDir, "bots", "forge", "AGENTS.md"), FORGE_AGENTS);
  console.log(`scaffolded demo fleet at ${fleetDir}`);
  console.log(`next: pi-tidy-bots start ${fleetDir}`);
  process.exit(0);
}

async function cmdStart(args: Args): Promise<void> {
  const dir = resolve(args.positional[0] ?? ".");
  const handle = await startFleet({
    dir,
    port:
      typeof args.flags.port === "string" ? Number(args.flags.port) : undefined,
    host: typeof args.flags.host === "string" ? args.flags.host : undefined,
    token: typeof args.flags.token === "string" ? args.flags.token : undefined,
    toolOutput:
      typeof args.flags["tool-output"] === "string"
        ? (args.flags["tool-output"] as any)
        : undefined,
    log: (line) => console.log(line),
  });
  const displayToken = handle.token ?? "";
  console.log(
    `\npi-tidy-bots ready: ${handle.url}${displayToken ? `/?token=${displayToken}` : ""}`
  );
  if (displayToken) console.log(`token: ${displayToken}`);
  console.log(
    "Ctrl-C stops the fleet. Sessions persist under .fleet/sessions/.\n"
  );
  process.on("SIGINT", () => {
    console.log("\nstopping fleet…");
    void handle.stop().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void handle.stop().then(() => process.exit(0));
  });
  await new Promise<never>(() => {});
}

function printVersion(): void {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  console.log(`${manifest.name} ${manifest.version}`);
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
  if (args.flags.version !== undefined) {
    printVersion();
    return;
  }
  if (command === "init") cmdInit(args.positional[0]);
  if (command === "chat") await cmdChat(args);
  if (command === "start") await cmdStart(args);
  if (command === "id") {
    console.log(randomUUID());
    process.exit(0);
  }
  usage();
}

await main();
