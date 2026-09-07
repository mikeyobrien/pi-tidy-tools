import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeConformanceTrace,
  runLocalConformance,
  type LocalConformanceReport,
  type LocalConformanceFixture,
} from "./conformance.ts";
import { nonempty, object, type JsonObject } from "./gateway/protocol.ts";
import { digestArtifact } from "./gateway/registry.ts";

export interface CommunityPythonExampleOptions {
  /** Optional portable Python executable; defaults to python3. */
  pythonExecutable?: string;
  /** Retained caller-owned output path for the generated receipt. */
  receiptPath?: string;
}

export interface CommunityPythonExampleReceipt extends JsonObject {
  format: "pi-tidy-community-conformance-receipt";
  version: 2;
  provenance: JsonObject;
  report: JsonObject;
}

interface CommunityScenario {
  id: string;
  config: JsonObject;
  healthy?: JsonObject;
  /** Scenario-specific limits not derivable from generic runner cell kinds. */
  notRun?: string[];
  fixture: LocalConformanceFixture;
  lifecycle?: {
    file: string;
    expected: Array<{ contains: string; expectedOccurrences: number }>;
  };
}

interface CommunityFixture {
  version: 1;
  scenarios: CommunityScenario[];
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = join(packageRoot, "examples", "community-python");
const bundledSdk = join(packageRoot, "sdk", "python", "tidy_backend_sdk");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizedReport(
  report: LocalConformanceReport,
  artifactDigest: string,
  scenarioNotRun: readonly string[] = []
): JsonObject {
  const normalized = normalizeConformanceTrace(report) as JsonObject;
  const scope = object(normalized.scope) ? normalized.scope : {};
  const artifact = object(scope.artifact) ? scope.artifact : {};
  scope.registryPath = "<generated-registry>";
  scope.artifact = {
    ...artifact,
    artifactPath: "<prepared-community-python-artifact>",
    sha256: artifactDigest,
  };
  if (scenarioNotRun.length)
    scope.notRun = [
      ...new Set([
        ...(Array.isArray(scope.notRun) ? scope.notRun : []),
        ...scenarioNotRun,
      ]),
    ];
  return { ...normalized, scope };
}

function normalizedReceipt(
  scenarios: Array<{
    id: string;
    report: LocalConformanceReport;
    notRun?: string[];
  }>,
  fixtureBytes: string,
  artifactDigest: string
): CommunityPythonExampleReceipt {
  const reports = scenarios.map(({ id, report, notRun }) => ({
    id,
    report: normalizedReport(report, artifactDigest, notRun),
  }));
  const exercised = [
    ...new Set(
      reports.flatMap(({ report }) => {
        const scope = object(report.scope) ? report.scope : {};
        return Array.isArray(scope.exercised)
          ? scope.exercised.filter(nonempty)
          : [];
      })
    ),
  ];
  return {
    format: "pi-tidy-community-conformance-receipt",
    version: 2,
    provenance: {
      bundle: "community-python",
      bundleVersion: "1.0.0",
      artifactDigest,
      fixtureDigest: `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`,
      installation: "registry_digest_pinned",
      supervisor: "startFleet",
      nativeProvider: "not-certified",
      assets: "package_relative",
    },
    report: {
      scope: {
        mode: "external_registry_only_disposable",
        supervisor: "startFleet",
        scenarios: reports.map(({ id }) => id),
        exercised,
        nativeProvider: "not-run",
        note: "Each scenario retains its own precise notRun scope; no matrix-wide certification is inferred.",
      },
      scenarios: reports,
    },
  };
}

function fixture(value: unknown): CommunityFixture {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.scenarios) ||
    !value.scenarios.length ||
    value.scenarios.some(
      (scenario) =>
        !object(scenario) ||
        !nonempty(scenario.id) ||
        !object(scenario.config) ||
        (scenario.healthy !== undefined && !object(scenario.healthy)) ||
        (scenario.notRun !== undefined &&
          (!Array.isArray(scenario.notRun) ||
            !scenario.notRun.every(nonempty))) ||
        !object(scenario.fixture) ||
        (scenario.lifecycle !== undefined &&
          (!object(scenario.lifecycle) ||
            !/^[A-Za-z0-9_.-]+$/.test(String(scenario.lifecycle.file)) ||
            !Array.isArray(scenario.lifecycle.expected)))
    )
  )
    throw new Error("Invalid community Python conformance fixture");
  return value as unknown as CommunityFixture;
}

/** Executes only the packaged independent Python example through the shipped supervisor. */
export async function runCommunityPythonExample(
  options: CommunityPythonExampleOptions = {}
): Promise<CommunityPythonExampleReceipt> {
  const fixtureBytes = await readFile(
    join(exampleRoot, "conformance.fixture.json"),
    "utf8"
  );
  const communityFixture = fixture(JSON.parse(fixtureBytes));
  const directory = await mkdtemp(join(tmpdir(), "tidy-community-example-"));
  try {
    const artifact = join(directory, "community-python");
    await cp(exampleRoot, artifact, {
      recursive: true,
      filter: (path) => !path.endsWith("conformance.receipt.json"),
    });
    await mkdir(join(artifact, "sdk"), { recursive: true });
    await cp(bundledSdk, join(artifact, "sdk", "tidy_backend_sdk"), {
      recursive: true,
      filter: (path) => !path.includes("__pycache__"),
    });
    if (options.pythonExecutable) {
      await writeFile(
        join(artifact, "plugin"),
        `#!/bin/sh\nexec ${shellQuote(options.pythonExecutable)} -B "$(dirname "$0")/backend.py"\n`,
        { mode: 0o700 }
      );
    }
    const artifactDigest = await digestArtifact(artifact);
    const registryPath = join(directory, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        registryVersion: 1,
        plugins: [
          {
            id: "org.example.tidy-community-python",
            version: "1.0.0",
            artifactPath: "community-python",
            sha256: artifactDigest,
            enabled: true,
          },
        ],
      })
    );
    const reports: Array<{
      id: string;
      report: LocalConformanceReport;
      notRun?: string[];
    }> = [];
    for (const scenario of communityFixture.scenarios) {
      reports.push({
        id: scenario.id,
        notRun: scenario.notRun,
        report: await runLocalConformance({
          registryPath,
          pluginId: "org.example.tidy-community-python",
          config: scenario.config,
          ...(scenario.healthy
            ? {
                healthy: {
                  pluginId: "org.example.tidy-community-python",
                  config: scenario.healthy,
                },
              }
            : {}),
          ...(scenario.lifecycle ? { lifecycle: scenario.lifecycle } : {}),
          fixture: scenario.fixture,
        }),
      });
    }
    const receipt = normalizedReceipt(reports, fixtureBytes, artifactDigest);
    if (options.receiptPath) {
      await mkdir(dirname(options.receiptPath), { recursive: true });
      await writeFile(
        options.receiptPath,
        `${JSON.stringify(receipt, null, 2)}\n`
      );
    }
    return receipt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
