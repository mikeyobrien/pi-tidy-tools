import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import ts from "typescript";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const gatewayRoot = join(packageRoot, "src/gateway");
const legacyRuntimeFiles = new Set(["rpc", "events", "daemon", "server"]);
const nativePackage =
  /(?:^|[/@-])(?:hermes|pi-coding-agent|pi-agent-core|pi-ai|pi-mcp-adapter|acp-sdk)(?:$|[/@-])|@mariozechner\//i;
const nativeCommand =
  /(?:^|\/)(?:tidy\.)?(?:pi|hermes)(?:$|\s)|^(?:RpcSession|HermesAgent|AIAgent|assistantMessageEvent)$/;

/** Type-only references to the public entry's interfaces do not load its runtime. */
function importsTypesOnly(
  node: ts.ImportDeclaration | ts.ExportDeclaration
): boolean {
  if (ts.isExportDeclaration(node)) {
    return (
      node.isTypeOnly ||
      (!!node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((entry) => entry.isTypeOnly))
    );
  }
  const clause = node.importClause;
  return (
    !!clause &&
    (clause.isTypeOnly ||
      (!clause.name &&
        !!clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((entry) => entry.isTypeOnly)))
  );
}

function boundaryViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations: string[] = [];
  const dependency = (specifier: string, typeOnly: boolean) => {
    if (typeOnly) return;
    const local = specifier.startsWith(".") || isAbsolute(specifier);
    const target = local ? resolve(dirname(file), specifier) : specifier;
    if (
      nativePackage.test(specifier) ||
      (local &&
        dirname(target) !== gatewayRoot &&
        legacyRuntimeFiles.has(basename(target).replace(/\.[cm]?[jt]s$/, "")))
    )
      violations.push(`runtime dependency ${specifier}`);
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      dependency(node.moduleSpecifier.text, importsTypesOnly(node));
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    )
      dependency(node.moduleReference.expression.text, node.isTypeOnly);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument))
        dependency(argument.text, false);
      else
        violations.push(
          "computed runtime import prevents dependency-boundary verification"
        );
    }
    if (ts.isStringLiteralLike(node) && nativeCommand.test(node.text))
      violations.push(`native command or discriminator ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

test("neutral gateway has no native-engine runtime dependencies or command discriminators", async () => {
  const files = (await readdir(gatewayRoot)).filter((file) =>
    file.endsWith(".ts")
  );
  assert.ok(
    files.includes("application.ts") &&
      files.includes("plugin-host.ts") &&
      files.includes("server.ts"),
    "Inspect the shipped gateway orchestration and supervisor"
  );
  const problems: string[] = [];
  for (const name of files) {
    const path = join(gatewayRoot, name);
    problems.push(
      ...boundaryViolations(path, await readFile(path, "utf8")).map(
        (problem) => `${name}: ${problem}`
      )
    );
  }
  assert.deepEqual(problems, []);
});

test("boundary inspection catches static, dynamic and re-export regressions while allowing erased entry types", () => {
  const file = join(gatewayRoot, "boundary-example.ts");
  const samples = [
    'import { RpcSession } from "../rpc.ts";',
    'export { handleEvent } from "../events.ts";',
    'await import("../daemon.ts");',
    'const server = require("../server.ts");',
    'const server = require("../server.js");',
    'import { Agent } from "@mariozechner/pi-agent-core";',
    'const backend = "tidy.hermes";',
    'spawn("hermes", ["acp"]);',
    'spawn("/opt/runtime/bin/hermes", ["acp"]);',
    "await import(computedPath);",
  ];
  for (const sample of samples)
    assert.ok(boundaryViolations(file, sample).length > 0, sample);
  assert.deepEqual(
    boundaryViolations(
      file,
      'import type { FleetHandle } from "../daemon.ts"; import { type StartFleetOptions } from "../daemon.ts"; export type { FleetHandle } from "../daemon.ts"; import { PluginHost } from "./plugin-host.ts";'
    ),
    []
  );
});

test("all public protocol schemas compile strictly and belong to the installed package allowlist", async () => {
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8")
  ) as { files: string[] };
  // This is the npm files allowlist, not a claim that an installation was published.
  assert.ok(packageJson.files.includes("src/gateway/schema/*.json"));
  const schemaDirectory = join(gatewayRoot, "schema");
  const names = (await readdir(schemaDirectory)).filter((name) =>
    name.endsWith(".json")
  );
  assert.deepEqual(names.sort(), [
    "capabilities.schema.json",
    "event.schema.json",
    "manifest.schema.json",
    "protocol.schema.json",
    "receipt.schema.json",
    "registry.schema.json",
  ]);
  const ajv = new Ajv({ strict: true, allErrors: true });
  for (const name of names) {
    const schema = JSON.parse(
      await readFile(join(schemaDirectory, name), "utf8")
    );
    assert.ok(
      ajv.compile(schema),
      `${name} must be portable, valid Draft-07 JSON Schema`
    );
  }
});
