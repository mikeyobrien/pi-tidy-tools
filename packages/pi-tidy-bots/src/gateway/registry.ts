import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import {
  nonempty,
  object,
  ProtocolError,
  type JsonObject,
} from "./protocol.ts";

export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  version: string;
  protocol: { major: number; minMinor: number; maxMinor: number };
  entrypoint: { path: string; args: string[] };
  configSchema: string;
  runtime: { name: string; testedVersion: string; transport: string };
  requestedAccess: {
    workspace: "none" | "read" | "read-write";
    nativeProfile: boolean;
    network: boolean;
    gatewayTools: string[];
  };
}
export interface PluginRegistryEntry {
  id: string;
  version: string;
  artifactPath: string;
  sha256: string;
  enabled: boolean;
}
export interface RegistryPolicy {
  workspace?: "none" | "read" | "read-write";
  nativeProfile?: boolean;
  network?: boolean;
  gatewayTools?: string[];
}
export interface PluginInstallation {
  root: string;
  manifest: PluginManifest;
  digest: string;
  executable: string;
  args: readonly string[];
  configSchema: JsonObject;
  validateConfig: ValidateFunction;
  policy: RegistryPolicy;
}
function fail(message: string): never {
  throw new ProtocolError("invalid_config", message);
}
function keys(value: JsonObject, allowed: string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`Unknown configuration key ${key}`);
}
export function validateManifest(value: unknown): PluginManifest {
  if (!object(value)) return fail("Plugin manifest must be an object");
  keys(value, [
    "manifestVersion",
    "id",
    "version",
    "protocol",
    "entrypoint",
    "configSchema",
    "runtime",
    "requestedAccess",
  ]);
  if (
    value.manifestVersion !== 1 ||
    !nonempty(value.id) ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.id) ||
    !nonempty(value.version) ||
    !nonempty(value.configSchema)
  )
    return fail("Invalid manifest identity or version");
  if (
    !object(value.protocol) ||
    !object(value.entrypoint) ||
    !object(value.runtime) ||
    !object(value.requestedAccess)
  )
    return fail("Missing manifest sections");
  keys(value.protocol, ["major", "minMinor", "maxMinor"]);
  keys(value.entrypoint, ["path", "args"]);
  keys(value.runtime, ["name", "testedVersion", "transport"]);
  keys(value.requestedAccess, [
    "workspace",
    "nativeProfile",
    "network",
    "gatewayTools",
  ]);
  const { major, minMinor, maxMinor } = value.protocol;
  if (
    major !== 1 ||
    !Number.isSafeInteger(minMinor) ||
    Number(minMinor) < 0 ||
    !Number.isSafeInteger(maxMinor) ||
    Number(maxMinor) < Number(minMinor) ||
    Number(minMinor) > 0
  )
    return fail("Incompatible plugin protocol version");
  if (
    !nonempty(value.entrypoint.path) ||
    isAbsolute(value.entrypoint.path) ||
    !Array.isArray(value.entrypoint.args) ||
    !value.entrypoint.args.every(
      (v) => typeof v === "string" && !v.includes("\0")
    )
  )
    return fail("Invalid executable path or argv");
  if (
    ![
      value.runtime.name,
      value.runtime.testedVersion,
      value.runtime.transport,
    ].every(nonempty)
  )
    return fail("Missing runtime identity");
  const scope = value.requestedAccess;
  if (
    !["none", "read", "read-write"].includes(String(scope.workspace)) ||
    typeof scope.nativeProfile !== "boolean" ||
    typeof scope.network !== "boolean" ||
    !Array.isArray(scope.gatewayTools) ||
    !scope.gatewayTools.every((v) =>
      [
        "fleet.discover",
        "fleet.send",
        "operator.enqueue",
        "artifact.read",
      ].includes(String(v))
    )
  )
    return fail("Invalid requested access");
  return value as unknown as PluginManifest;
}
async function contained(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.includes("\0"))
    return fail("Artifact paths must be relative");
  const absolute = await realpath(resolve(root, path));
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return fail("Artifact path escapes installation root");
  return absolute;
}
/** The digest includes each sorted UTF-8 relative path and exact file bytes. No exclusions. */
export async function digestArtifact(path: string): Promise<string> {
  const root = await realpath(path);
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const child = join(directory, name);
      const info = await lstat(child);
      const rel = relative(root, child).split(sep).join("/");
      if (info.isSymbolicLink())
        return fail(`Artifact symlinks are not supported: ${rel}`);
      if (info.isDirectory()) await visit(child);
      else if (info.isFile()) {
        const bytes = await readFile(child);
        hash.update(`${Buffer.byteLength(rel, "utf8")}:`);
        hash.update(rel);
        hash.update(`:${bytes.length}:`);
        hash.update(bytes);
      } else return fail(`Unsupported artifact entry ${rel}`);
    }
  };
  await visit(root);
  return `sha256:${hash.digest("hex")}`;
}
function checkAccess(manifest: PluginManifest, policy: RegistryPolicy): void {
  const request = manifest.requestedAccess;
  const level = { none: 0, read: 1, "read-write": 2 };
  if (
    level[request.workspace] > level[policy.workspace ?? "none"] ||
    (request.nativeProfile && !policy.nativeProfile) ||
    (request.network && !policy.network) ||
    request.gatewayTools.some((name) => !policy.gatewayTools?.includes(name))
  )
    fail("Plugin access declaration exceeds explicit operator policy");
}
function assertLocalSchema(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertLocalSchema);
    return;
  }
  if (!object(value)) return;
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#"))
    fail("Configuration schema cannot resolve external references");
  for (const entry of Object.values(value)) assertLocalSchema(entry);
}
export async function loadInstallation(
  entry: PluginRegistryEntry,
  registryDirectory: string,
  policy: RegistryPolicy = {}
): Promise<PluginInstallation> {
  if (!entry.enabled)
    return fail(`Plugin ${entry.id} is not explicitly enabled`);
  if (!/^sha256:[a-f0-9]{64}$/.test(entry.sha256))
    return fail("Plugin requires an exact sha256 artifact pin");
  const root = await realpath(resolve(registryDirectory, entry.artifactPath));
  const digest = await digestArtifact(root);
  if (digest !== entry.sha256)
    return fail("Plugin artifact digest does not match the registry pin");
  const manifest = validateManifest(
    JSON.parse(await readFile(await contained(root, "backend.json"), "utf8"))
  );
  if (manifest.id !== entry.id || manifest.version !== entry.version)
    return fail("Manifest identity differs from pinned registry identity");
  checkAccess(manifest, policy);
  const executable = await contained(root, manifest.entrypoint.path);
  if (!(await lstat(executable)).isFile())
    return fail("Entrypoint must be a regular file");
  await access(executable, constants.X_OK);
  const schemaValue: unknown = JSON.parse(
    await readFile(await contained(root, manifest.configSchema), "utf8")
  );
  if (
    !object(schemaValue) ||
    schemaValue.type !== "object" ||
    schemaValue.additionalProperties !== false
  )
    return fail(
      "Configuration schema must be an object with additionalProperties=false"
    );
  assertLocalSchema(schemaValue);
  const validateConfig = new Ajv({
    strict: true,
    allErrors: true,
    ownProperties: true,
  }).compile(schemaValue);
  return {
    root,
    manifest,
    digest,
    executable,
    args: Object.freeze([...manifest.entrypoint.args]),
    configSchema: schemaValue,
    validateConfig,
    policy: structuredClone(policy),
  };
}
export class PluginRegistry {
  private readonly installations: Map<string, PluginInstallation>;
  private constructor(installations: Map<string, PluginInstallation>) {
    this.installations = installations;
  }
  static async load(
    path: string,
    options: { policy?: RegistryPolicy } = {}
  ): Promise<PluginRegistry> {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object(value)) return fail("Registry must be an object");
    keys(value, ["registryVersion", "plugins"]);
    if (value.registryVersion !== 1 || !Array.isArray(value.plugins))
      return fail("Invalid registry version or plugins");
    const installations = new Map<string, PluginInstallation>();
    const ids = new Set<string>();
    for (const record of value.plugins) {
      if (!object(record)) return fail("Invalid registry entry");
      keys(record, ["id", "version", "artifactPath", "sha256", "enabled"]);
      if (
        ![record.id, record.version, record.artifactPath, record.sha256].every(
          nonempty
        ) ||
        typeof record.enabled !== "boolean"
      )
        return fail("Incomplete registry entry");
      const entry = record as unknown as PluginRegistryEntry;
      if (ids.has(entry.id))
        return fail(`Duplicate registered plugin ${entry.id}`);
      ids.add(entry.id);
      if (entry.enabled)
        installations.set(
          entry.id,
          await loadInstallation(entry, dirname(resolve(path)), options.policy)
        );
    }
    return new PluginRegistry(installations);
  }
  resolve(id: string): PluginInstallation {
    const installation = this.installations.get(id);
    if (!installation)
      return fail(`Backend ${id} is not installed and explicitly enabled`);
    return installation;
  }
  ids(): string[] {
    return [...this.installations.keys()];
  }
}
