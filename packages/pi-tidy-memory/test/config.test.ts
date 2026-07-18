import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadMemoryConfig,
  parseMemoryConfig,
  readEnvFile,
  resolveApiKey,
  sanitizedConfigSummary,
  type HindsightBackendConfig,
} from "../config.js";

const valid = {
  version: 1,
  enabled: true,
  backend: {
    type: "hindsight",
    baseUrl: "https://memory.example.test/",
    bankId: "pi-coding",
    apiKeyEnv: "HINDSIGHT_API_KEY",
    recallBudget: "high",
  },
  requestTimeoutMs: 20_000,
  lifecycle: { autoRecall: true, autoRetain: false },
};

test("parses defaults and normalizes Hindsight configuration", () => {
  const config = parseMemoryConfig(valid);
  assert.equal(config.backend.baseUrl, "https://memory.example.test");
  assert.deepEqual(config.backend.recallTypes, [
    "observation",
    "world",
    "experience",
  ]);
  assert.equal(config.backend.asyncRetain, true);
  assert.equal(config.lifecycle.maxRecallTokens, 1_024);
  assert.equal(config.lifecycle.maxRetainChars, 16_000);
});

test("rejects unsafe or malformed configuration", () => {
  for (const raw of [
    {},
    { ...valid, version: 2 },
    { ...valid, backend: { ...valid.backend, baseUrl: "file:///tmp/memory" } },
    {
      ...valid,
      backend: { ...valid.backend, baseUrl: "http://192.168.1.2:8888" },
    },
    {
      ...valid,
      backend: { ...valid.backend, baseUrl: "https://key@example.test?q=x" },
    },
    { ...valid, backend: { ...valid.backend, bankId: "bad bank" } },
    { ...valid, backend: { ...valid.backend, apiKeyEnv: "bad-name" } },
    { ...valid, backend: { ...valid.backend, apiKey: "secret" } },
  ])
    assert.throws(() => parseMemoryConfig(raw));
  for (const baseUrl of ["http://127.0.0.1:8888", "http://[::1]:8888"]) {
    assert.equal(
      parseMemoryConfig({
        ...valid,
        backend: { ...valid.backend, baseUrl },
      }).backend.type,
      "hindsight"
    );
  }
  assert.equal(
    parseMemoryConfig({
      ...valid,
      backend: { type: "mnemosyne", database: "memory.db" },
    }).backend.type,
    "mnemosyne"
  );
});

test("loads env files without exposing unrelated syntax", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-memory-config-"));
  try {
    const envFile = join(root, "hindsight.env");
    await writeFile(
      envFile,
      "# comment\nexport HINDSIGHT_API_KEY='secret value'\nBROKEN\nOTHER=ok\n"
    );
    assert.deepEqual(readEnvFile(envFile), {
      HINDSIGHT_API_KEY: "secret value",
      OTHER: "ok",
    });
    const config = parseMemoryConfig({
      ...valid,
      backend: { ...valid.backend, envFile },
    }).backend as HindsightBackendConfig;
    assert.equal(resolveApiKey(config, {}), "secret value");
    assert.equal(
      resolveApiKey(config, { HINDSIGHT_API_KEY: "process" }),
      "process"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports missing and valid agent-dir config safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-memory-load-"));
  try {
    const missing = loadMemoryConfig(root);
    assert.equal(missing.error, "not configured");
    assert.match(
      sanitizedConfigSummary(missing),
      /^disabled \(not configured\)/
    );
    const directory = join(root, "pi-tidy-memory");
    await mkdir(directory);
    await writeFile(join(directory, "config.json"), JSON.stringify(valid));
    const loaded = loadMemoryConfig(root);
    assert.equal(loaded.error, undefined);
    const summary = sanitizedConfigSummary(loaded, {
      HINDSIGHT_API_KEY: "secret",
    });
    assert.match(summary, /host=memory\.example\.test/);
    assert.match(summary, /auth=HINDSIGHT_API_KEY:present/);
    assert.doesNotMatch(summary, /secret/);

    const unreadable = parseMemoryConfig({
      ...valid,
      backend: {
        ...valid.backend,
        envFile: join(root, "missing.env"),
      },
    });
    assert.match(
      sanitizedConfigSummary({ config: unreadable, path: "config.json" }, {}),
      /auth=HINDSIGHT_API_KEY:unreadable/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
