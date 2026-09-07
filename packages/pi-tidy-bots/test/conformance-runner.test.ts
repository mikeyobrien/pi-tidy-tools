import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestArtifact } from "../src/gateway/registry.ts";
import {
  cancellationReceiptsMatch,
  immutableReceiptMatches,
  latestPluginInstance,
  malformedPluginFaultMatches,
  matchingEffectLines,
  noCompletedAssistant,
  normalizeConformanceTrace,
  postNativeEofMatches,
  prelaunchFailureMatches,
  publicEventEvidence,
  runLocalConformance,
  type LocalConformanceFixture,
} from "../src/conformance.ts";

const pythonCandidate = "/opt/homebrew/opt/python@3.14/bin/python3.14";
const python =
  process.env.TIDY_TEST_PYTHON ??
  (existsSync(pythonCandidate) ? pythonCandidate : "python3");
const pythonSdk = fileURLToPath(
  new URL("../sdk/python/tidy_backend_sdk", import.meta.url)
);
const pythonBackend = fileURLToPath(
  new URL("./fixtures/gateway-python/backend.py", import.meta.url)
);

async function pythonCrashArtifact(
  root: string
): Promise<{ registry: string; pluginId: string }> {
  const artifact = join(root, "python-plugin");
  await mkdir(join(artifact, "sdk"), { recursive: true });
  await cp(pythonSdk, join(artifact, "sdk", "tidy_backend_sdk"), {
    recursive: true,
    filter: (path) => !path.includes("__pycache__"),
  });
  await copyFile(pythonBackend, join(artifact, "backend.py"));
  await writeFile(
    join(artifact, "plugin"),
    `#!/bin/sh\nexec ${python} -B "$(dirname "$0")/backend.py"\n`
  );
  await chmod(join(artifact, "plugin"), 0o700);
  await writeFile(
    join(artifact, "backend.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "org.example.python",
      version: "1.0.0",
      protocol: { major: 1, minMinor: 0, maxMinor: 0 },
      entrypoint: { path: "plugin", args: [] },
      configSchema: "config.schema.json",
      runtime: {
        name: "independent-python",
        testedVersion: "fixture",
        transport: "stdio",
      },
      requestedAccess: {
        workspace: "none",
        nativeProfile: false,
        network: false,
        gatewayTools: [],
      },
    })
  );
  await writeFile(
    join(artifact, "config.schema.json"),
    JSON.stringify({
      type: "object",
      properties: { mode: { type: "string" } },
      additionalProperties: false,
    })
  );
  const healthy = join(root, "healthy-plugin");
  await cp(artifact, healthy, { recursive: true });
  const healthySource = (
    await readFile(join(healthy, "backend.py"), "utf8")
  ).replaceAll("org.example.python", "org.example.healthy");
  await writeFile(join(healthy, "backend.py"), healthySource);
  const healthyManifest = JSON.parse(
    await readFile(join(healthy, "backend.json"), "utf8")
  );
  healthyManifest.id = "org.example.healthy";
  await writeFile(
    join(healthy, "backend.json"),
    JSON.stringify(healthyManifest)
  );
  const registry = join(root, "python-registry.json");
  await writeFile(
    registry,
    JSON.stringify({
      registryVersion: 1,
      plugins: [
        {
          id: "org.example.python",
          version: "1.0.0",
          artifactPath: "python-plugin",
          sha256: await digestArtifact(artifact),
          enabled: true,
        },
        {
          id: "org.example.healthy",
          version: "1.0.0",
          artifactPath: "healthy-plugin",
          sha256: await digestArtifact(healthy),
          enabled: true,
        },
      ],
    })
  );
  return { registry, pluginId: "org.example.python" };
}

test("runner proves C01 negotiation and config failures before native launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-conformance-c01-"));
  try {
    const { registry, pluginId } = await pythonCrashArtifact(root);
    const fixture = (
      phase: "compatible" | "initialize" | "config_preflight",
      code?:
        "incompatible_protocol" | "missing_required_method" | "invalid_config"
    ): LocalConformanceFixture => ({
      version: 1 as const,
      cells: [
        {
          id: `c01-${phase}-${code ?? "open"}`,
          kind: "prelaunch" as const,
          operationId: `c01-${phase}-${code ?? "open"}`,
          text: "",
          expect: { status: phase === "compatible" ? 200 : 0 },
          prelaunch: {
            phase,
            ...(code ? { code } : {}),
            instrumentation:
              phase === "config_preflight" ? "absent_preflight" : "readable",
          },
        },
      ],
    });
    const compatible = await runLocalConformance({
      registryPath: registry,
      pluginId,
      config: { mode: "normal" },
      fixture: fixture("compatible"),
    });
    assert.equal(
      compatible.cells[0].status,
      "passed",
      JSON.stringify(compatible)
    );
    assert.deepEqual(compatible.cells[0].evidence, {
      phase: "compatible",
      instrumentation: "readable",
      nativeOpenCount: 1,
      nativeSubmitCount: 0,
    });
    for (const [mode, phase, code] of [
      ["initialize-incompatible", "initialize", "incompatible_protocol"],
      ["initialize-missing-method", "initialize", "missing_required_method"],
      ["invalid", "config_preflight", "invalid_config"],
    ] as const) {
      const report = await runLocalConformance({
        registryPath: registry,
        pluginId,
        config: mode === "invalid" ? { unexpected: true } : { mode },
        fixture: fixture(phase, code),
      });
      assert.equal(report.cells[0].status, "passed", JSON.stringify(report));
      assert.equal(report.cells[0].evidence.actualCode, code);
      assert.equal(
        report.cells[0].evidence.instrumentation,
        phase === "config_preflight" ? "absent_preflight" : "readable"
      );
      assert.equal(
        (report.cells[0].evidence.nativeCalls as Array<{ kind: string }>).some(
          (call) => call.kind === "open" || call.kind === "submit"
        ),
        false
      );
    }
    const wrongReason = await runLocalConformance({
      registryPath: registry,
      pluginId,
      config: { mode: "initialize-incompatible" },
      fixture: fixture("initialize", "missing_required_method"),
    });
    assert.equal(wrongReason.cells[0].status, "failed");
    assert.equal(
      prelaunchFailureMatches(
        {
          phase: "initialize",
          code: "incompatible_protocol",
          instrumentation: "readable",
        },
        "incompatible_protocol",
        { instrumentation: "readable", lines: ['{"kind":"open"}'] }
      ),
      false,
      "an unexpected native open cannot certify a startup rejection"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local conformance runner uses the shipped daemon with an explicit pinned fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-conformance-test-"));
  try {
    const artifact = join(root, "plugin");
    await mkdir(artifact);
    await copyFile(
      fileURLToPath(
        new URL("./fixtures/gateway-application/backend.mjs", import.meta.url)
      ),
      join(artifact, "backend.mjs")
    );
    await chmod(join(artifact, "backend.mjs"), 0o755);
    await writeFile(
      join(artifact, "backend.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "org.example.independent",
        version: "1.0.0",
        protocol: { major: 1, minMinor: 0, maxMinor: 0 },
        entrypoint: { path: "backend.mjs", args: [] },
        configSchema: "config.schema.json",
        runtime: {
          name: "independent-fixture",
          testedVersion: "1.0.0",
          transport: "stdio",
        },
        requestedAccess: {
          workspace: "none",
          nativeProfile: false,
          network: false,
          gatewayTools: [],
        },
      })
    );
    await writeFile(
      join(artifact, "config.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {},
        additionalProperties: false,
      })
    );
    const registry = join(root, "registry.json");
    await writeFile(
      registry,
      JSON.stringify({
        registryVersion: 1,
        plugins: [
          {
            id: "org.example.independent",
            version: "1.0.0",
            artifactPath: "plugin",
            sha256: await digestArtifact(artifact),
            enabled: true,
          },
        ],
      })
    );
    const report = await runLocalConformance({
      registryPath: registry,
      pluginId: "org.example.independent",
      config: {},
      fixture: {
        version: 1,
        cells: [
          {
            id: "retry",
            kind: "message",
            operationId: "same",
            text: "hello",
            retry: "same",
            effect: {
              file: "calls.jsonl",
              contains: '"method":"operation.submit","operationId":"same"',
              expectedOccurrences: 1,
            },
            events: { minFrames: 3, terminalFinals: 1 },
            expect: { status: 202, execution: "ended" },
          },
          {
            id: "conflict",
            kind: "message",
            operationId: "conflict",
            text: "hello",
            retry: "conflict",
            effect: {
              file: "calls.jsonl",
              contains: '"method":"operation.submit","operationId":"conflict"',
              expectedOccurrences: 1,
            },
            expect: { status: 202, execution: "ended" },
          },
          {
            id: "no-effect",
            kind: "message",
            operationId: "no-effect",
            text: "skip",
            retry: "same",
            expect: { status: 202, execution: "ended" },
          },
          {
            id: "declared-not-run",
            kind: "message",
            operationId: "skip",
            text: "skip",
            expect: { status: 202 },
            skip: true,
          },
        ],
      },
    });
    assert.equal(report.scope.daemon, "startFleet");
    assert.deepEqual(
      report.cells.map((cell) => cell.status),
      ["passed", "passed", "not-run", "not-run"]
    );
    assert.equal(
      report.cells[2].evidence.reason,
      "fixture_native_effect_evidence_required"
    );
    assert.equal((report.cells[0].evidence.receipt as any).execution, "ended");
    assert.equal(
      (report.cells[0].evidence.events as any).terminalFinalCount,
      1
    );
    assert.equal((report.cells[0].evidence.events as any).ordered, true);
    assert.deepEqual(report.scope.exercised, [
      "C03",
      "C05.public_ordered_terminal",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner proves post-native-write Python EOF remains uncertain and is never replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-conformance-python-eof-"));
  try {
    const { registry, pluginId } = await pythonCrashArtifact(root);
    const report = await runLocalConformance({
      registryPath: registry,
      pluginId,
      config: { mode: "crash-submit" },
      fixture: {
        version: 1,
        cells: [
          {
            id: "python-post-write-eof",
            kind: "post_native_eof",
            operationId: "python-eof",
            text: "lost native response",
            effect: {
              file: "native-calls.jsonl",
              contains: '"kind": "submit", "operationId": "python-eof"',
              expectedOccurrences: 1,
            },
            expect: {
              status: 202,
              execution: "unknown",
              observation: "reconciliation_required",
            },
          },
        ],
      },
    });
    assert.deepEqual(
      report.cells.map((cell) => cell.status),
      ["passed"]
    );
    assert.equal((report.cells[0].evidence.nativeEffects as any).count, 1);
    assert.equal(report.cells[0].evidence.noCompletedAssistant as any, true);
    assert.deepEqual(report.scope.exercised, [
      "C04.post_write_eof",
      "C05.post_write_eof_recovery",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner isolates malformed Python plugin frames while healthy binding completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-conformance-malformed-"));
  try {
    const { registry, pluginId } = await pythonCrashArtifact(root);
    for (const mode of [
      "malformed-json",
      "malformed-event",
      "oversize",
      "nonfinite",
      "stdout-log",
    ]) {
      const operationId = `bad-${mode}`;
      const report = await runLocalConformance({
        registryPath: registry,
        pluginId,
        config: { mode },
        healthy: {
          pluginId: "org.example.healthy",
          config: { mode: "normal" },
        },
        fixture: {
          version: 1,
          cells: [
            {
              id: mode,
              kind: "malformed_plugin",
              operationId,
              text: "isolate",
              effect: {
                file: "native-calls.jsonl",
                contains: `\"kind\": \"malformed\", \"mode\": \"${mode}\", \"operationId\": \"${operationId}\"`,
                expectedOccurrences: 1,
              },
              expect: {
                status: 202,
                execution: "unknown",
                observation: "reconciliation_required",
              },
            },
          ],
        },
      });
      assert.equal(report.cells[0].status, "passed", JSON.stringify(report));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner preserves a valid LF-split plugin event and keeps a healthy peer responsive", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-conformance-split-lf-"));
  try {
    const { registry, pluginId } = await pythonCrashArtifact(root);
    const report = await runLocalConformance({
      registryPath: registry,
      pluginId,
      config: { mode: "split-lf" },
      healthy: { pluginId: "org.example.healthy", config: { mode: "normal" } },
      fixture: {
        version: 1,
        cells: [
          {
            id: "valid-lf-split",
            kind: "split_lf",
            operationId: "split-lf",
            text: "valid split frame",
            effect: {
              file: "native-calls.jsonl",
              contains: '"kind": "submit", "operationId": "split-lf"',
              expectedOccurrences: 1,
            },
            events: { minFrames: 3, terminalFinals: 1 },
            expect: {
              status: 202,
              execution: "ended",
              observation: "complete",
            },
          },
        ],
      },
    });
    assert.equal(report.cells[0].status, "passed", JSON.stringify(report));
    assert.equal(
      (report.cells[0].evidence.events as any).terminalFinalCount,
      1
    );
    assert.equal(
      (report.cells[0].evidence.healthyReceipt as any).execution,
      "ended"
    );
    assert.ok(
      (report.scope.exercised as string[]).includes("C02.lf_split_valid_frame")
    );
    assert.ok(
      (report.scope.notRun as string[]).includes(
        "C02.other_plugin_frame_variants"
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marker plus ordinary Python crash cannot certify malformed-frame isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-conformance-marker-crash-"));
  try {
    const { registry, pluginId } = await pythonCrashArtifact(root);
    const operationId = "marker-crash";
    const report = await runLocalConformance({
      registryPath: registry,
      pluginId,
      config: { mode: "marker-crash" },
      healthy: {
        pluginId: "org.example.healthy",
        config: { mode: "normal" },
      },
      fixture: {
        version: 1,
        cells: [
          {
            id: "marker-crash",
            kind: "malformed_plugin",
            operationId,
            text: "must not certify",
            effect: {
              file: "native-calls.jsonl",
              contains: `"kind": "malformed", "mode": "marker-crash", "operationId": "${operationId}"`,
              expectedOccurrences: 1,
            },
            expect: {
              status: 202,
              execution: "unknown",
              observation: "reconciliation_required",
            },
          },
        ],
      },
    });
    assert.equal(report.cells[0].status, "failed", JSON.stringify(report));
    assert.equal(report.cells[0].evidence.protocolRejection, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner proves scoped REST cancellation outcomes without replaying native effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-conformance-cancel-"));
  try {
    const { registry, pluginId } = await pythonCrashArtifact(root);
    for (const [mode, target] of [
      ["cancel-ack", { execution: "cancelled", observation: "complete" }],
      [
        "cancel-delayed",
        {
          execution: "cancel_requested",
          observation: "complete",
        },
      ],
      [
        "cancel-lost",
        { execution: "unknown", observation: "reconciliation_required" },
      ],
    ] as const) {
      const operationId = `target-${mode}`;
      const cancelOperationId = `cancel-${mode}`;
      const report = await runLocalConformance({
        registryPath: registry,
        pluginId,
        config: { mode },
        fixture: {
          version: 1,
          allowedUncertainty:
            mode === "cancel-lost" ? ["native_cancel_response_lost"] : [],
          cells: [
            {
              id: `L03.${mode}`,
              kind: "cancel",
              operationId,
              text: "hold for cancellation",
              effect: {
                file: "native-calls.jsonl",
                contains: `"kind": "submit", "operationId": "${operationId}"`,
                expectedOccurrences: 1,
              },
              cancel: {
                operationId: cancelOperationId,
                effect: {
                  file: "native-calls.jsonl",
                  contains: `"kind": "cancel", "operationId": "${cancelOperationId}", "targetOperationId": "${operationId}"`,
                  expectedOccurrences: 1,
                },
                expect:
                  mode === "cancel-lost"
                    ? {
                        execution: "unknown",
                        observation: "reconciliation_required",
                      }
                    : { execution: "ended", observation: "complete" },
              },
              expect: { status: 202, ...target },
            },
          ],
        },
      });
      assert.equal(report.cells[0].status, "passed", JSON.stringify(report));
      assert.ok(
        (report.scope.exercised as unknown[]).includes("L03.cancel_rest"),
        JSON.stringify(report)
      );
      assert.ok(
        (report.scope.notRun as unknown[]).includes(
          "L03.cancel_impossible_or_unsupported"
        ),
        JSON.stringify(report)
      );
      const evidence = report.cells[0].evidence as {
        nativeEffects: { submitCount: number; cancelCount: number };
      };
      assert.equal(
        evidence.nativeEffects.submitCount,
        1,
        JSON.stringify(report)
      );
      assert.equal(
        evidence.nativeEffects.cancelCount,
        1,
        JSON.stringify(report)
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped conformance export loads its runtime entrypoint", async () => {
  const runtime = await import(
    new URL("../src/conformance.mjs", import.meta.url).href
  );
  assert.equal(typeof runtime.runLocalConformance, "function");
});

test("conformance trace normalization preserves ID relationships and event correlation rejects a foreign terminal", () => {
  const normalized = normalizeConformanceTrace({
    operationId: "same",
    targetOperationId: "same",
    bindingId: "other",
    createdAt: "2026-01-01",
  }) as any;
  assert.equal(normalized.operationId, normalized.targetOperationId);
  assert.notEqual(normalized.operationId, normalized.bindingId);
  assert.equal(normalized.createdAt, "<clock>");
  const messageReceipt = {
    fleetId: "fleet",
    botId: "bot",
    conversationId: "conversation",
    bindingId: "binding",
    bindingRevision: "revision",
    operationId: "op",
    userEntryId: "entry-a",
  };
  assert.equal(
    immutableReceiptMatches(messageReceipt, {
      ...messageReceipt,
      userEntryId: "entry-b",
    }),
    false
  );
  assert.equal(
    immutableReceiptMatches(messageReceipt, {
      ...messageReceipt,
      userEntryId: undefined,
    }),
    false
  );
  const expected = { minFrames: 2, terminalFinals: 1 as const };
  const mismatched = [
    { seq: 1, type: "append", entry: { operationId: "op", turnId: "turn-a" } },
    { seq: 2, type: "bubble", phase: "final", turnId: "turn-b" },
  ];
  assert.equal(publicEventEvidence(mismatched, "op", expected), undefined);
  const matched = [
    ...mismatched.slice(0, 1),
    { seq: 2, type: "bubble", phase: "final", turnId: "turn-a" },
  ];
  assert.equal(
    (publicEventEvidence(matched, "op", expected) as any).terminalFinalCount,
    1
  );
  const withUnrelatedRosters = [
    { seq: 1, type: "roster", counts: { active: 1 } },
    ...matched,
    { seq: 3, type: "roster", counts: { active: 0 } },
  ];
  const evidence = publicEventEvidence(
    withUnrelatedRosters,
    "op",
    expected
  ) as any;
  assert.equal(evidence.frameCount, 2);
  assert.deepEqual(
    evidence.trace.map((frame: any) => frame.seq),
    ["<sequence:1>", "<sequence:2>"]
  );
});

test("EOF public completion evidence ignores unrelated finals and rejects the correlated assistant turn", () => {
  assert.equal(
    noCompletedAssistant(
      [
        { type: "append", entry: { operationId: "op", role: "user" } },
        { type: "bubble", phase: "final", turnId: "unrelated" },
      ],
      "op"
    ),
    true
  );
  assert.equal(
    noCompletedAssistant(
      [
        {
          type: "append",
          entry: { operationId: "op", role: "assistant", turnId: "turn-op" },
        },
        { type: "bubble", phase: "final", turnId: "turn-op" },
      ],
      "op"
    ),
    false
  );
});

test("post-native EOF matching rejects false completion and a second native write", () => {
  const receipt = {
    fleetId: "fleet",
    botId: "bot",
    conversationId: "conversation",
    bindingId: "binding",
    bindingRevision: "revision",
    operationId: "op",
    userEntryId: "entry",
    execution: "unknown",
    observation: "reconciliation_required",
  };
  const expected = {
    status: 202,
    execution: "unknown" as const,
    observation: "reconciliation_required" as const,
  };
  assert.equal(
    postNativeEofMatches(
      { status: 202, body: receipt },
      receipt,
      { ...receipt, execution: "ended" },
      expected,
      ["native"],
      ["native"],
      true
    ),
    false
  );
  assert.equal(
    postNativeEofMatches(
      { status: 202, body: receipt },
      receipt,
      receipt,
      expected,
      ["native"],
      ["native", "native"],
      true
    ),
    false
  );
  assert.equal(
    postNativeEofMatches(
      { status: 202, body: receipt },
      receipt,
      receipt,
      expected,
      ["native"],
      ["native"],
      false
    ),
    false
  );
});

test("operation-scoped fixture effect matching tolerates unrelated RPCs and detects repeats", () => {
  const operation = '"method":"operation.submit","operationId":"same"';
  const benign = '{"method":"events.ack"}\n{' + operation + "}\n";
  assert.equal(matchingEffectLines(benign, operation).length, 1);
  assert.equal(
    matchingEffectLines(benign + "{" + operation + "}\n", operation).length,
    2
  );
});

test("malformed frame evidence rejects ordinary plugin EOF despite a fixture marker", () => {
  const identity = {
    botName: "fixture",
    bindingId: "binding",
    instanceId: "instance",
    leaseGeneration: 1,
  };
  assert.equal(
    malformedPluginFaultMatches(
      "malformed-json",
      { ...identity, code: "plugin_eof" },
      identity
    ),
    false
  );
  assert.equal(
    malformedPluginFaultMatches(
      "malformed-json",
      { ...identity, code: "invalid_frame" },
      { ...identity, instanceId: "stale-instance" }
    ),
    false
  );
  assert.equal(
    malformedPluginFaultMatches(
      "oversize",
      { ...identity, code: "resource_limit" },
      { ...identity, leaseGeneration: 2 }
    ),
    false
  );
  assert.equal(
    malformedPluginFaultMatches(
      "oversize",
      { ...identity, code: "resource_limit" },
      identity
    ),
    true
  );
});

test("malformed frame cell selects the latest matching ready instance", () => {
  const first = {
    botName: "fixture",
    bindingId: "binding",
    instanceId: "old-instance",
    leaseGeneration: 1,
  };
  const active = {
    ...first,
    instanceId: "active-instance",
    leaseGeneration: 2,
  };
  const selected = latestPluginInstance(
    [first, { ...first, botName: "healthy" }, active],
    "fixture",
    "binding"
  );
  assert.equal(selected?.instanceId, "active-instance");
  assert.equal(selected?.leaseGeneration, 2);
  assert.equal(
    malformedPluginFaultMatches(
      "malformed-json",
      { ...first, code: "invalid_frame" },
      selected
    ),
    false
  );
});

test("cancellation receipt matching rejects wrong target and control association", () => {
  const target = {
    fleetId: "fleet",
    botId: "bot",
    conversationId: "conversation",
    bindingId: "binding",
    bindingRevision: "revision",
    operationId: "target",
    userEntryId: "entry",
  };
  const control = {
    fleetId: "fleet",
    botId: "bot",
    conversationId: "conversation",
    bindingId: "binding",
    bindingRevision: "revision",
    operationId: "cancel",
    kind: "cancel",
    result: { status: "requested" },
  };
  assert.equal(
    cancellationReceiptsMatch(
      target,
      target,
      control,
      control,
      control,
      control,
      target,
      true,
      true
    ),
    true
  );
  assert.equal(
    cancellationReceiptsMatch(
      target,
      { ...target, operationId: "wrong-target" },
      control,
      control,
      control,
      control,
      target,
      true,
      true
    ),
    false
  );
  assert.equal(
    cancellationReceiptsMatch(
      target,
      target,
      control,
      { ...control, kind: "message" },
      control,
      control,
      target,
      true,
      true
    ),
    false
  );
  assert.equal(
    cancellationReceiptsMatch(
      target,
      target,
      control,
      control,
      control,
      control,
      target,
      false,
      true
    ),
    false
  );
});
