import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const output = ".test-dist";
rmSync(output, { recursive: true, force: true });
try {
	execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json"], { stdio: "inherit" });
	const tests = readdirSync(join(output, "test"))
		.filter((name) => name.endsWith(".test.js"))
		.map((name) => join(output, "test", name));
	execFileSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
} finally {
	rmSync(output, { recursive: true, force: true });
}
