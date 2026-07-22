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

test("parses documented dynamic bank settings without changing static defaults", () => {
  const parsed = parseMemoryConfig({
    ...valid,
    backend: {
      ...valid.backend,
      dynamicBankId: true,
      dynamicBankGranularity: ["agent", "project", "session"],
      bankIdPrefix: "prod",
      agentName: "pi",
      resolveWorktrees: false,
      directoryBankMap: {
        "/work/sensitive": "isolated",
      },
    },
  }).backend as HindsightBackendConfig;
  assert.deepEqual(
    {
      dynamicBankId: parsed.dynamicBankId,
      dynamicBankGranularity: parsed.dynamicBankGranularity,
      bankIdPrefix: parsed.bankIdPrefix,
      agentName: parsed.agentName,
      resolveWorktrees: parsed.resolveWorktrees,
      directoryBankMap: parsed.directoryBankMap,
    },
    {
      dynamicBankId: true,
      dynamicBankGranularity: ["agent", "project", "session"],
      bankIdPrefix: "prod",
      agentName: "pi",
      resolveWorktrees: false,
      directoryBankMap: { "/work/sensitive": "isolated" },
    }
  );
  assert.equal(
    (parseMemoryConfig(valid).backend as HindsightBackendConfig).dynamicBankId,
    undefined
  );
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

test("configuration errors identify the exact rejected contract", () => {
  const cases: Array<[unknown, string]> = [
    [null, "config must be a JSON object"],
    [[], "config must be a JSON object"],
    [{}, "config.version must be 1"],
    [
      { ...valid, backend: null },
      "backend.type must be a safe backend identifier",
    ],
    [
      { ...valid, backend: { ...valid.backend, baseUrl: " " } },
      "backend.baseUrl is required",
    ],
    [
      { ...valid, backend: { ...valid.backend, baseUrl: "relative" } },
      "backend.baseUrl must be an absolute HTTP(S) URL",
    ],
    [
      { ...valid, backend: { ...valid.backend, baseUrl: "file:///tmp/x" } },
      "backend.baseUrl must use HTTP or HTTPS",
    ],
    [
      {
        ...valid,
        backend: {
          ...valid.backend,
          baseUrl: "https://user:pass@example.test",
        },
      },
      "backend.baseUrl must not contain credentials, a query, or a fragment",
    ],
    [
      {
        ...valid,
        backend: {
          ...valid.backend,
          baseUrl: "https://example.test?secret=x",
        },
      },
      "backend.baseUrl must not contain credentials, a query, or a fragment",
    ],
    [
      {
        ...valid,
        backend: { ...valid.backend, baseUrl: "https://example.test#x" },
      },
      "backend.baseUrl must not contain credentials, a query, or a fragment",
    ],
    [
      { ...valid, backend: { ...valid.backend, bankId: "" } },
      "backend.bankId must be 1-128 safe identifier characters",
    ],
    [
      { ...valid, backend: { ...valid.backend, apiKeyEnv: "bad-name" } },
      "backend.apiKeyEnv must be an environment variable name",
    ],
    [
      { ...valid, backend: { ...valid.backend, envFile: 2 } },
      "backend.envFile must be a path",
    ],
    [
      { ...valid, backend: { ...valid.backend, apiKey: "x" } },
      "inline credentials are forbidden; use apiKeyEnv and optional envFile",
    ],
    [
      { ...valid, backend: { ...valid.backend, token: "x" } },
      "inline credentials are forbidden; use apiKeyEnv and optional envFile",
    ],
    [
      { ...valid, backend: { ...valid.backend, headers: {} } },
      "inline credentials are forbidden; use apiKeyEnv and optional envFile",
    ],
    [
      {
        ...valid,
        backend: {
          ...valid.backend,
          baseUrl: "http://192.0.2.1:8888",
        },
      },
      "authenticated Hindsight requires HTTPS except on loopback",
    ],
    [
      { ...valid, backend: { ...valid.backend, dynamicBankId: "yes" } },
      "backend.dynamicBankId must be a boolean",
    ],
    [
      {
        ...valid,
        backend: { ...valid.backend, dynamicBankGranularity: [] },
      },
      "backend.dynamicBankGranularity must be a non-empty array",
    ],
    [
      {
        ...valid,
        backend: {
          ...valid.backend,
          dynamicBankGranularity: ["project", "project"],
        },
      },
      "backend.dynamicBankGranularity must contain unique agent, project, session, channel, or user fields",
    ],
    [
      {
        ...valid,
        backend: { ...valid.backend, dynamicBankGranularity: ["tenant"] },
      },
      "backend.dynamicBankGranularity must contain unique agent, project, session, channel, or user fields",
    ],
    [
      { ...valid, backend: { ...valid.backend, bankIdPrefix: "bad prefix" } },
      "backend.bankIdPrefix must be 1-64 safe identifier characters",
    ],
    [
      { ...valid, backend: { ...valid.backend, agentName: "bad agent" } },
      "backend.agentName must be 1-64 safe identifier characters",
    ],
    [
      { ...valid, backend: { ...valid.backend, resolveWorktrees: "yes" } },
      "backend.resolveWorktrees must be a boolean",
    ],
    [
      { ...valid, backend: { ...valid.backend, directoryBankMap: [] } },
      "backend.directoryBankMap must be an object",
    ],
    [
      {
        ...valid,
        backend: { ...valid.backend, directoryBankMap: { relative: "bank" } },
      },
      "backend.directoryBankMap keys must be absolute paths",
    ],
    [
      {
        ...valid,
        backend: {
          ...valid.backend,
          directoryBankMap: { "/work": "bad bank" },
        },
      },
      "backend.directoryBankMap values must be 1-128 safe identifier characters",
    ],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parseMemoryConfig(raw), {
      name: "Error",
      message,
    });
  }
});

test("rejects malformed boolean values instead of applying defaults", () => {
  const cases: Array<[unknown, string]> = [
    [{ ...valid, enabled: "yes" }, "config.enabled must be a boolean"],
    [
      { ...valid, backend: { ...valid.backend, asyncRetain: "yes" } },
      "backend.asyncRetain must be a boolean",
    ],
    [
      { ...valid, lifecycle: { ...valid.lifecycle, autoRecall: "yes" } },
      "lifecycle.autoRecall must be a boolean",
    ],
    [
      { ...valid, lifecycle: { ...valid.lifecycle, autoRetain: 1 } },
      "lifecycle.autoRetain must be a boolean",
    ],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parseMemoryConfig(raw), { name: "Error", message });
  }
});

test("rejects unknown keys in known configuration objects", () => {
  const cases: Array<[unknown, string]> = [
    [{ ...valid, enabeld: true }, 'config contains unknown key "enabeld"'],
    [
      {
        ...valid,
        lifecycle: { ...valid.lifecycle, autoRacall: true },
      },
      'lifecycle contains unknown key "autoRacall"',
    ],
    [
      {
        ...valid,
        backend: { ...valid.backend, recellBudget: "low" },
      },
      'backend contains unknown key "recellBudget"',
    ],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parseMemoryConfig(raw), { name: "Error", message });
  }
});

test("configuration defaults and integer bounds are exact", () => {
  const defaults = parseMemoryConfig({
    version: 1,
    backend: {
      type: "hindsight",
      baseUrl: " https://memory.example.test/root/ ",
      bankId: "bank:one",
    },
  });
  assert.deepEqual(defaults, {
    version: 1,
    enabled: true,
    backend: {
      type: "hindsight",
      baseUrl: "https://memory.example.test/root",
      bankId: "bank:one",
      recallBudget: "mid",
      recallTypes: ["observation", "world", "experience"],
      asyncRetain: true,
    },
    requestTimeoutMs: 15_000,
    lifecycle: {
      autoRecall: false,
      autoRetain: false,
      maxRecallTokens: 1_024,
      maxRetainChars: 16_000,
    },
  });
  const bounded = parseMemoryConfig({
    ...valid,
    requestTimeoutMs: 999,
    lifecycle: {
      autoRetain: true,
      maxRecallTokens: 9_999,
      maxRetainChars: 255,
    },
  });
  assert.deepEqual(
    {
      enabled: bounded.enabled,
      requestTimeoutMs: bounded.requestTimeoutMs,
      lifecycle: bounded.lifecycle,
    },
    {
      enabled: true,
      requestTimeoutMs: 1_000,
      lifecycle: {
        autoRecall: false,
        autoRetain: true,
        maxRecallTokens: 4_096,
        maxRetainChars: 256,
      },
    }
  );
  assert.equal(
    parseMemoryConfig({ ...valid, requestTimeoutMs: 1_000.5 }).requestTimeoutMs,
    15_000
  );
});

test("loads env files without exposing unrelated syntax", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-memory-config-"));
  try {
    const envFile = join(root, "hindsight.env");
    await writeFile(
      envFile,
      [
        "  # comment  ",
        "export HINDSIGHT_API_KEY='secret value'",
        'DOUBLE=" spaced value "',
        "EMPTY=",
        "PLAIN = ignored",
        "BROKEN",
        "OTHER= ok ",
        "1BAD=no",
        "exported=no",
        "",
      ].join("\r\n")
    );
    assert.deepEqual(readEnvFile(envFile), {
      HINDSIGHT_API_KEY: "secret value",
      DOUBLE: " spaced value ",
      EMPTY: "",
      OTHER: "ok",
      exported: "no",
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
    assert.equal(
      sanitizedConfigSummary(missing),
      `disabled (not configured) at ${join(root, "pi-tidy-memory", "config.json")}`
    );
    const directory = join(root, "pi-tidy-memory");
    await mkdir(directory);
    await writeFile(join(directory, "config.json"), JSON.stringify(valid));
    const loaded = loadMemoryConfig(root);
    assert.equal(loaded.error, undefined);
    const summary = sanitizedConfigSummary(loaded, {
      HINDSIGHT_API_KEY: "secret",
    });
    assert.equal(
      summary,
      "enabled backend=hindsight host=memory.example.test bank=pi-coding auth=HINDSIGHT_API_KEY:present autoRecall=true autoRetain=false"
    );
    assert.doesNotMatch(summary, /secret/);
    assert.equal(
      sanitizedConfigSummary(loaded, {}),
      "enabled backend=hindsight host=memory.example.test bank=pi-coding auth=HINDSIGHT_API_KEY:missing autoRecall=true autoRetain=false"
    );

    const unreadable = parseMemoryConfig({
      ...valid,
      backend: {
        ...valid.backend,
        envFile: join(root, "missing.env"),
      },
    });
    assert.equal(
      sanitizedConfigSummary({ config: unreadable, path: "config.json" }, {}),
      "enabled backend=hindsight host=memory.example.test bank=pi-coding auth=HINDSIGHT_API_KEY:unreadable autoRecall=true autoRetain=false"
    );
    assert.equal(
      sanitizedConfigSummary({ path: "x", error: undefined }),
      "disabled (not configured) at x"
    );
    assert.equal(
      sanitizedConfigSummary({
        path: "x",
        config: parseMemoryConfig({
          ...valid,
          enabled: false,
          backend: { type: "mnemosyne", file: "memory.db" },
        }),
      }),
      "disabled backend=mnemosyne autoRecall=true autoRetain=false"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
