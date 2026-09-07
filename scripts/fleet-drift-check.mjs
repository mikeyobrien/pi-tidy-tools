#!/usr/bin/env node
/**
 * Fleet drift guard (issue 119) — safety net, never a primary mechanism.
 *
 * Compares the git commit the RUNNING fleet daemon reports (GET /api/version
 * -> commit) against the repository's main tip (git rev-parse main). Read-only:
 * it never stops, restarts, or otherwise disturbs the live daemon. Restarts
 * stay at the merge step's settle boundary, executed via the sanctioned
 * `pi-tidy-bots restart --fleet <name>` (operator-run; this script only says
 * when it is due).
 *
 * Usage:
 *   node scripts/fleet-drift-check.mjs [--fleet <name>] [--repo <path>]
 *                                      [--port <n>] [--json]
 *
 * Exit codes (for cron / launchd alerting):
 *   0  synced  — daemon commit == main tip
 *   1  DRIFT   — daemon commit != main tip (alert: restart is due)
 *   2  down    — daemon unreachable or /api/version failed
 *   3  no-commit — daemon did not report a commit (packed install: unanswerable)
 *   4  unknown-repo — main tip did not resolve in the checkout
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const fleetName = arg("--fleet") ?? "pi-tidy-fleet";
const repo = arg("--repo") ?? REPO_DEFAULT;
const port = Number(arg("--port") ?? 0) || 4317;
const json = process.argv.includes("--json");

function registryPath() {
  return join(homedir(), ".pi", "pi-tidy", "fleets.json");
}

function resolveFleetDir(name) {
  let records = [];
  try {
    records = JSON.parse(readFileSync(registryPath(), "utf8"));
  } catch {
    // No registry: fall through to name-as-dir heuristic below.
  }
  const record = (Array.isArray(records) ? records : []).find(
    (entry) => entry && typeof entry === "object" && entry.name === name
  );
  return record?.dir;
}

function mainTip(repoPath) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "main"], {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: repoPath,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }
}

function report(state, payload) {
  const row = {
    checkedAt: new Date().toISOString(),
    fleet: fleetName,
    state,
    ...payload,
  };
  if (json) {
    console.log(JSON.stringify(row));
  } else {
    const line =
      state === "synced"
        ? `synced: daemon=${payload.daemonCommit} main=${payload.mainCommit}`
        : state === "drift"
          ? `DRIFT: daemon=${payload.daemonCommit} main=${payload.mainCommit} — restart due: pi-tidy-bots restart --fleet ${fleetName}`
          : state === "down"
            ? `down: daemon unreachable at 127.0.0.1:${port}`
            : state === "no-commit"
              ? `no-commit: daemon at ${payload.fleetDir} reported no git commit (packed install?)`
              : `unknown-repo: no main/HEAD tip in ${payload.repo}`;
    console.log(_DRIFT_TAG + line);
    console.log(_DRIFT_TAG + JSON.stringify(row));
  }
  return row;
}

// Stable grep-able marker so alerting (cron mail, SIEM, humans) can find rows.
const _DRIFT_TAG = "[fleet-drift] ";

const dir = resolveFleetDir(fleetName);
if (!dir) {
  const row = report("unknown-repo", {
    repo,
    fleetDir: dir ?? "(not registered)",
  });
  process.exit(4);
}

let token = "";
try {
  token = readFileSync(join(dir, ".fleet", "token"), "utf8").trim();
} catch {
  token = "";
}

let version;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  version = await res.json();
} catch (error) {
  const row = report("down", { error: String(error) });
  process.exit(2);
}

const daemonCommit = version?.commit;
if (!daemonCommit) {
  const row = report("no-commit", { fleetDir: dir });
  process.exit(3);
}

const tip = mainTip(repo);
if (!tip) {
  const row = report("unknown-repo", { repo });
  process.exit(4);
}

if (daemonCommit === tip) {
  report("synced", { daemonCommit, mainCommit: tip });
  process.exit(0);
}
report("drift", { daemonCommit, mainCommit: tip });
process.exit(1);
