#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "pi-fff-installed-fixture.mjs");
const latestMode = process.argv.includes("--latest");

function runTuple(label, piVersion, piFffVersion) {
	const result = spawnSync(process.execPath, [fixture], {
		env: { ...process.env, PI_VERSION: piVersion, PI_FFF_VERSION: piFffVersion },
		encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
	});
	return {
		label, piVersion, piFffVersion,
		status: result.status === 0 ? "passed" : "failed",
		output: (result.status === 0 ? result.stdout : result.stderr).trim(),
	};
}

const tuples = [["baseline", "0.80.6", "0.1.12"]];
let newestPi;
let newestFff;
if (latestMode) {
	try {
		const latest = (name) => execFileSync("npm", ["view", name, "version"], { encoding: "utf8", timeout: 30_000 }).trim();
		newestPi = latest("@earendil-works/pi-coding-agent");
		newestFff = latest("pi-fff");
		tuples.push(
			["newest/newest", newestPi, newestFff],
			["newest Pi/baseline pi-fff", newestPi, "0.1.12"],
			["baseline Pi/newest pi-fff", "0.80.6", newestFff],
		);
	} catch (error) {
		console.log(JSON.stringify({
			mode: "blocked", gate: "newest-compatible release matrix",
			reason: "npm registry version discovery unavailable",
			evidence: error instanceof Error ? error.message : String(error),
			action: "Restore npm registry access and rerun with --latest; do not promote a forward tuple.",
		}, null, 2));
		process.exit(2);
	}
}

const evidence = tuples.map(([label, piVersion, piFffVersion]) => runTuple(label, piVersion, piFffVersion));
console.log(JSON.stringify({
	mode: latestMode ? "latest-network-gate" : "hermetic-baseline",
	checkedAt: new Date().toISOString(), newestPi, newestFff, evidence,
}, null, 2));
if (evidence.some((row) => row.status !== "passed")) process.exitCode = 1;
