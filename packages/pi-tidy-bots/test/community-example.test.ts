import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const packageDir = new URL("..", import.meta.url).pathname;
const pythonCandidate = "/opt/homebrew/opt/python@3.14/bin/python3.14";
const python =
  process.env.TIDY_TEST_PYTHON ??
  (existsSync(pythonCandidate) ? pythonCandidate : "python3");

function semanticReceipt(receipt: any): unknown {
  return {
    format: receipt.format,
    version: receipt.version,
    provenance: {
      ...receipt.provenance,
      artifactDigest: "<executed-artifact-digest>",
    },
    report: {
      scope: receipt.report.scope,
      scenarios: receipt.report.scenarios.map((scenario: any) => ({
        id: scenario.id,
        scope: {
          exercised: scenario.report.scope.exercised,
          notRun: scenario.report.scope.notRun,
          nativeProvider: scenario.report.scope.nativeProvider,
        },
        cells: scenario.report.cells.map((cell: any) => ({
          status: cell.status,
        })),
      })),
    },
  };
}

test("packed community example runs from an extracted registry-only artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-community-packed-"));
  try {
    const packed = JSON.parse(
      (
        await execFile("npm", ["pack", "--json", "--pack-destination", root], {
          cwd: packageDir,
        })
      ).stdout
    ) as Array<{ filename: string }>;
    const tarball = join(root, packed[0].filename);
    const consumer = join(root, "consumer");
    await writeFile(join(root, "consumer-package.json"), '{"private":true}\n');
    await execFile("mkdir", [consumer]);
    await execFile("mv", [
      join(root, "consumer-package.json"),
      join(consumer, "package.json"),
    ]);
    await execFile(
      "npm",
      [
        "install",
        tarball,
        "--ignore-scripts",
        "--omit=peer",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: consumer }
    );
    const installed = join(
      consumer,
      "node_modules",
      "@mobrienv",
      "pi-tidy-bots"
    );
    for (const file of [
      "examples/community-python/backend.json",
      "examples/community-python/config.schema.json",
      "examples/community-python/backend.py",
      "examples/community-python/plugin",
      "examples/community-python/conformance.fixture.json",
      "examples/community-python/conformance.receipt.json",
      "sdk/python/tidy_backend_sdk/runtime.py",
      "src/community-example.mjs",
    ])
      assert.equal(existsSync(join(installed, file)), true, `packed ${file}`);
    const receiptPath = join(root, "generated-receipt.json");
    const runInstalled = async (pythonExecutable: string, output: string) => {
      const program = [
        'import { runCommunityPythonExample } from "@mobrienv/pi-tidy-bots/community-example";',
        `const receipt = await runCommunityPythonExample({ pythonExecutable: ${JSON.stringify(pythonExecutable)}, receiptPath: ${JSON.stringify(output)} });`,
        "process.stdout.write(JSON.stringify(receipt));",
      ].join("\n");
      const result = await execFile(
        process.execPath,
        ["--input-type=module", "--eval", program],
        {
          cwd: consumer,
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          maxBuffer: 2 * 1024 * 1024,
        }
      );
      return JSON.parse(result.stdout) as any;
    };
    const receipt = await runInstalled(python, receiptPath);
    const retained = JSON.parse(await readFile(receiptPath, "utf8"));
    const sample = JSON.parse(
      await readFile(
        join(installed, "examples/community-python/conformance.receipt.json"),
        "utf8"
      )
    );
    assert.deepEqual(receipt, retained);
    assert.equal(receipt.format, "pi-tidy-community-conformance-receipt");
    assert.equal(receipt.version, 2);
    assert.equal(receipt.provenance.installation, "registry_digest_pinned");
    assert.equal(receipt.provenance.assets, "package_relative");
    assert.equal(receipt.provenance.nativeProvider, "not-certified");
    assert.match(receipt.provenance.artifactDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(receipt.report.scope.scenarios, [
      "open-send-stream-close",
      "cancel-acknowledged",
      "malformed-event-isolated",
      "post-write-crash-unknown",
    ]);
    const scenarios = new Map<string, any>(
      receipt.report.scenarios.map((scenario: any): [string, any] => [
        scenario.id,
        scenario.report,
      ])
    );
    assert.equal(scenarios.size, 4);
    for (const [id, report] of scenarios) {
      assert.equal(
        report.scope.artifact.sha256,
        receipt.provenance.artifactDigest,
        "each scenario executes the registry-pinned artifact"
      );
      assert.ok(
        report.cells.every((cell: any) => cell.status === "passed"),
        `scenario failed: ${id}`
      );
    }
    const normal = scenarios.get("open-send-stream-close");
    assert.equal(normal.cells[0].evidence.events.terminalFinalCount, 1);
    assert.equal(normal.cells[1].status, "passed");
    assert.equal(normal.cells[1].evidence.shutdown, "startFleet.handle.stop");
    const cancelled = scenarios.get("cancel-acknowledged").cells[0];
    assert.equal(cancelled.evidence.receipts.target.execution, "cancelled");
    assert.equal(cancelled.evidence.nativeEffects.submitCount, 1);
    assert.equal(cancelled.evidence.nativeEffects.cancelCount, 1);
    const malformed = scenarios.get("malformed-event-isolated").cells[0];
    assert.equal(malformed.evidence.protocolRejection.code, "invalid_event");
    assert.equal(malformed.evidence.healthyReceipt.execution, "ended");
    const crash = scenarios.get("post-write-crash-unknown").cells[0];
    assert.equal(crash.evidence.receipts.after.execution, "unknown");
    assert.equal(crash.evidence.nativeEffects.count, 1);
    assert.equal(crash.evidence.nativeEffects.unchanged, true);
    assert.equal(crash.evidence.healthyReceipt.execution, "ended");
    assert.match(sample.provenance.artifactDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(sample.version, 2);
    assert.equal(
      sample.report.scenarios[0].report.scope.artifact.sha256,
      sample.provenance.artifactDigest,
      "bundled receipt preserves the original packed-run artifact provenance"
    );
    assert.deepEqual(semanticReceipt(sample), semanticReceipt(receipt));
    const alternatePython = join(root, "alternate-python");
    await symlink(await realpath(python), alternatePython);
    const alternate = await runInstalled(
      alternatePython,
      join(root, "alternate-receipt.json")
    );
    assert.notEqual(
      alternate.provenance.artifactDigest,
      receipt.provenance.artifactDigest,
      "an explicit executable override changes the truthfully pinned artifact"
    );
    for (const scenario of alternate.report.scenarios)
      assert.equal(
        scenario.report.scope.artifact.sha256,
        alternate.provenance.artifactDigest
      );
    assert.deepEqual(semanticReceipt(alternate), semanticReceipt(receipt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
