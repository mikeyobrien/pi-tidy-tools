#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "pi-fff-installed-fixture.mjs");
const latestMode = process.argv.includes("--latest");

function runTuple(label, piVersion, packageIdentity, piFffVersion) {
	const result = spawnSync(process.execPath, [fixture], {
		env: { ...process.env, PI_VERSION: piVersion, PI_FFF_PACKAGE: packageIdentity, PI_FFF_VERSION: piFffVersion },
		encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
	});
	return { label, piVersion, packageIdentity, piFffVersion, status: result.status === 0 ? "passed" : "failed", output: (result.status === 0 ? result.stdout : result.stderr).trim() };
}

const baselines = [
	{ label: "legacy verified", pi: "0.80.6", packageIdentity: "pi-fff", fff: "0.1.12" },
	{ label: "scoped verified", pi: "0.80.6", packageIdentity: "@ff-labs/pi-fff", fff: "0.9.6" },
];
const tuples = [...baselines];
let newestPi;
const newestPackages = {};
if (latestMode) {
	try {
		const latest = (name) => execFileSync("npm", ["view", name, "version"], { encoding: "utf8", timeout: 30_000 }).trim();
		newestPi = latest("@earendil-works/pi-coding-agent");
		for (const baseline of baselines) {
			const newest = latest(baseline.packageIdentity); newestPackages[baseline.packageIdentity] = newest;
			tuples.push(
				{ ...baseline, label: `${baseline.packageIdentity} newest/newest`, pi: newestPi, fff: newest },
				{ ...baseline, label: `${baseline.packageIdentity} newest Pi/verified package`, pi: newestPi },
				{ ...baseline, label: `${baseline.packageIdentity} baseline Pi/newest package`, fff: newest },
			);
		}
	} catch (error) {
		console.log(JSON.stringify({ mode: "blocked", gate: "newest-compatible release matrix", reason: "npm registry version discovery unavailable", evidence: error instanceof Error ? error.message : String(error), action: "Restore npm registry access and rerun with --latest; do not promote a forward tuple." }, null, 2));
		process.exit(2);
	}
}

const evidence = tuples.map((tuple) => runTuple(tuple.label, tuple.pi, tuple.packageIdentity, tuple.fff));
console.log(JSON.stringify({ mode: latestMode ? "latest-network-gate" : "hermetic-baselines", checkedAt: new Date().toISOString(), newestPi, newestPackages, evidence }, null, 2));
if (evidence.some((row) => row.status !== "passed")) process.exitCode = 1;
