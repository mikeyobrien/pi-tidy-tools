#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "../..");
const piVersion = process.env.PI_VERSION ?? "0.80.6";
const piFffVersion = process.env.PI_FFF_VERSION ?? "0.1.12";
const root = await mkdtemp(join(tmpdir(), "pi-tidy-installed-fff-"));
const harness = join(root, "harness");
const project = join(root, "project");
const agent = join(root, "agent");
const packDir = join(root, "pack");

function run(command, args, options = {}) {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, ...options });
}

try {
	await Promise.all([mkdir(harness, { recursive: true }), mkdir(project, { recursive: true }), mkdir(packDir, { recursive: true })]);
	await mkdir(join(project, "nested", "path with spaces"), { recursive: true });
	await writeFile(join(project, "nested", "path with spaces", "space marker.txt"), "PI_FFF_INSTALLED_MARKER\n", "utf8");
	const packed = JSON.parse(run("npm", ["pack", "--workspace", "@mobrienv/pi-tidy-tools", "--json", "--pack-destination", packDir], { cwd: repoRoot }));
	const tarball = join(packDir, packed[0].filename);
	await writeFile(join(harness, "package.json"), JSON.stringify({ private: true, type: "module" }));
	run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", `@earendil-works/pi-coding-agent@${piVersion}`, tarball], { cwd: harness });
	for (const npmRoot of [join(agent, "npm"), join(project, ".pi", "npm")]) {
		await mkdir(npmRoot, { recursive: true });
		await writeFile(join(npmRoot, "package.json"), JSON.stringify({ private: true }));
		run("npm", ["install", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", `pi-fff@${piFffVersion}`], { cwd: npmRoot });
	}
	await mkdir(join(harness, "scripts"), { recursive: true });
	await cp(join(here, "pi-fff-installed-runner.ts"), join(harness, "scripts", "runner.ts"));
	await writeFile(join(harness, "launch.mjs"), `
		import { existsSync } from "node:fs";
		import { createRequire } from "node:module";
		import { dirname, join, resolve } from "node:path";
		import { pathToFileURL } from "node:url";
		const require = createRequire(import.meta.url);
		let piRoot = dirname(new URL(import.meta.resolve("@earendil-works/pi-coding-agent")).pathname);
		while (!existsSync(join(piRoot, "package.json"))) piRoot = dirname(piRoot);
		const piRequire = createRequire(join(piRoot, "package.json"));
		const { createJiti } = await import(pathToFileURL(piRequire.resolve("jiti")).href);
		await createJiti(import.meta.url, { moduleCache: false, interopDefault: true }).import(resolve("scripts/runner.ts"));
	`);
	const output = run(process.execPath, ["launch.mjs"], {
		cwd: harness,
		env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, FIXTURE_ROOT: root, PI_VERSION: piVersion, PI_FFF_VERSION: piFffVersion },
		timeout: 120_000,
	});
	const evidence = JSON.parse(output.slice(output.indexOf("{")));
	if (!evidence.ok) throw new Error("installed fixture did not report success");
	process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
	const detail = error?.stderr?.toString?.() || error?.stdout?.toString?.() || error?.stack || String(error);
	throw new Error(`Installed pi-fff fixture failed for Pi ${piVersion} / pi-fff ${piFffVersion}:\n${detail}`);
} finally {
	await rm(root, { recursive: true, force: true });
}
