#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "pi-fff-installed-fixture.mjs");
const profiles = [
	{ packageIdentity: "pi-fff", version: "0.1.12" },
	{ packageIdentity: "@ff-labs/pi-fff", version: "0.9.6" },
];
const evidence = profiles.map(({ packageIdentity, version }) => {
	const result = spawnSync(process.execPath, [fixture], {
		env: { ...process.env, PI_FFF_PACKAGE: packageIdentity, PI_FFF_VERSION: version },
		encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
	});
	return { packageIdentity, version, status: result.status === 0 ? "passed" : "failed", output: (result.status === 0 ? result.stdout : result.stderr).trim() };
});
console.log(JSON.stringify({ mode: "installed-package-profiles", evidence }, null, 2));
if (evidence.some((row) => row.status !== "passed")) process.exitCode = 1;
