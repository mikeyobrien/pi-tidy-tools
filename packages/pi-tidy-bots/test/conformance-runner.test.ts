import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestArtifact } from "../src/gateway/registry.ts";
import {
  immutableReceiptMatches,
  matchingEffectLines,
  normalizeConformanceTrace,
  publicEventEvidence,
  runLocalConformance,
} from "../src/conformance.ts";

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
      "L10",
      "C05.public_ordered_terminal",
    ]);
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
