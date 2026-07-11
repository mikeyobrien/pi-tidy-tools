import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTidyMode, loadTidyState, parseEnabled, saveTidyEnabled, saveTidyMode } from "../config.js";

test("missing config defaults to enabled", () => {
	const state = loadTidyState({ envValue: "", configPath: join(tmpdir(), `missing-tidy-${process.pid}.json`) });
	assert.deepEqual(state, { enabled: true, source: "default" });
});

test("persistent config round-trips outside an existing directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-tidy-tools-"));
	const configPath = join(root, ".pi", "agent", "pi-tidy-tools.json");
	try {
		await saveTidyEnabled(false, configPath);
		assert.deepEqual(loadTidyState({ envValue: "", configPath }), { enabled: false, source: "file" });
		assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { enabled: false });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("layout mode persists alongside enabled state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-tidy-tools-"));
	const configPath = join(root, "config.json");
	try {
		assert.equal(loadTidyMode(configPath), "default");
		await saveTidyEnabled(false, configPath);
		await saveTidyMode("reasoning", configPath);
		assert.equal(loadTidyMode(configPath), "reasoning");
		assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { enabled: false, mode: "reasoning" });
		await saveTidyMode("result", configPath);
		assert.equal(loadTidyMode(configPath), "result");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("environment setting takes precedence over the file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-tidy-tools-"));
	const configPath = join(root, "config.json");
	try {
		await writeFile(configPath, JSON.stringify({ enabled: false }));
		assert.deepEqual(loadTidyState({ envValue: "on", configPath }), { enabled: true, source: "environment" });
		assert.deepEqual(loadTidyState({ envValue: "0", configPath }), { enabled: false, source: "environment" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("invalid values do not disable the extension", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-tidy-tools-"));
	const configPath = join(root, "config.json");
	try {
		await writeFile(configPath, "not json");
		assert.deepEqual(loadTidyState({ envValue: "invalid", configPath }), { enabled: true, source: "default" });
		assert.equal(parseEnabled("yes"), true);
		assert.equal(parseEnabled("NO"), false);
		assert.equal(parseEnabled("maybe"), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
