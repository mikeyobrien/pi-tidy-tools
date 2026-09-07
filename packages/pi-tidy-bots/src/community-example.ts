import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeConformanceTrace,
  runLocalConformance,
  type LocalConformanceFixture,
} from "./conformance.ts";
import { object, type JsonObject } from "./gateway/protocol.ts";
import { digestArtifact } from "./gateway/registry.ts";

export interface CommunityPythonExampleOptions {
  /** Optional portable Python executable; defaults to python3. */
  pythonExecutable?: string;
  /** Retained caller-owned output path for the generated receipt. */
  receiptPath?: string;
}

export interface CommunityPythonExampleReceipt extends JsonObject {
  format: "pi-tidy-community-conformance-receipt";
  version: 1;
  provenance: JsonObject;
  report: JsonObject;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = join(packageRoot, "examples", "community-python");
const bundledSdk = join(packageRoot, "sdk", "python", "tidy_backend_sdk");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizedReceipt(
  report: JsonObject,
  fixtureBytes: string,
  artifactDigest: string
): CommunityPythonExampleReceipt {
  const normalized = normalizeConformanceTrace(report) as JsonObject;
  const scope = object(normalized.scope) ? normalized.scope : {};
  const artifact = object(scope.artifact) ? scope.artifact : {};
  scope.registryPath = "<generated-registry>";
  scope.artifact = {
    ...artifact,
    artifactPath: "<prepared-community-python-artifact>",
    sha256: artifactDigest,
  };
  return {
    format: "pi-tidy-community-conformance-receipt",
    version: 1,
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
    report: { ...normalized, scope },
  };
}

/** Executes only the packaged independent Python example through the shipped supervisor. */
export async function runCommunityPythonExample(
  options: CommunityPythonExampleOptions = {}
): Promise<CommunityPythonExampleReceipt> {
  const fixtureBytes = await readFile(
    join(exampleRoot, "conformance.fixture.json"),
    "utf8"
  );
  const fixture = JSON.parse(fixtureBytes) as LocalConformanceFixture;
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
    const report = await runLocalConformance({
      registryPath,
      pluginId: "org.example.tidy-community-python",
      config: { mode: "normal" },
      fixture,
    });
    const receipt = normalizedReceipt(
      report as unknown as JsonObject,
      fixtureBytes,
      artifactDigest
    );
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
