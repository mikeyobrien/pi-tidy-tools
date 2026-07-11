#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir, realpath, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const fail = (message, code = 1) => { console.error(`worktree-audit: ${message}`); process.exit(code); };
const git = (...args) => { const result = spawnSync("git", args, { encoding: null }); if (result.status !== 0) fail(result.stderr.toString("utf8").trim() || `git ${args.join(" ")} failed`); return result.stdout; };
const digest = (parts) => { const hash = createHash("sha256"); for (const part of parts) hash.update(part); return hash.digest("hex"); };
const safePath = (value) => { if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) fail(`path must be repository-relative: ${value}`); const normalized = posix.normalize(value); if (normalized !== value.replace(/\/$/, "") || normalized === "." || normalized === ".." || normalized.startsWith("../")) fail(`path must be normalized and repository-relative: ${value}`); return normalized; };
const uniqueSafePaths = (values, label) => { const paths = values.map(safePath); if (new Set(paths).size !== paths.length) fail(`${label} paths must be unique`); return paths; };
const withinAllowed = (path, roots) => roots.some((root) => path.equals(root) || (path.length > root.length && path.subarray(0, root.length).equals(root) && path[root.length] === 0x2f));
const modeOf = (stat) => stat.mode & 0o7777;
const encode = (value) => Buffer.from(value).toString("base64");
const decode = (value, label) => { if (typeof value !== "string") fail(`invalid ${label}`); const result = Buffer.from(value, "base64"); if (result.toString("base64") !== value) fail(`invalid ${label}`); return result; };
const joinBufferPath = (parent, name) => Buffer.concat([parent, Buffer.from("/"), name]);

async function repositoryRoot() {
  const root = await realpath(git("rev-parse", "--show-toplevel").toString("utf8").trim());
  if (root !== await realpath(".")) fail("run from the repository root");
  return root;
}

async function rejectSymlinkAncestors(root, path) {
  let current = root;
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail(`owned path has symlink ancestor: ${path}`);
      if (!stat.isDirectory()) return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function fingerprint(root, path) {
  await rejectSymlinkAncestors(root, path);
  const absolute = resolve(root, path);
  try {
    const stat = await lstat(absolute), mode = modeOf(stat);
    if (stat.isSymbolicLink()) return { path, kind: "symlink", mode, sha256: digest([await readlink(absolute, { encoding: "buffer" })]) };
    if (stat.isFile()) return { path, kind: "file", mode, sha256: digest([await readFile(absolute)]) };
    if (stat.isDirectory()) {
      const entries = [];
      async function walk(directory, relative) {
        const names = await readdir(directory, { encoding: "buffer" });
        names.sort(Buffer.compare);
        for (const name of names) {
          const childAbsolute = joinBufferPath(directory, name), childRelative = relative.length ? Buffer.concat([relative, Buffer.from("/"), name]) : name;
          const childStat = await lstat(childAbsolute), childMode = modeOf(childStat);
          if (childStat.isDirectory()) {
            entries.push(Buffer.concat([Buffer.from(`D\0${childMode.toString(8)}\0`), childRelative, Buffer.from("\0")]));
            await walk(childAbsolute, childRelative);
          } else if (childStat.isSymbolicLink()) {
            entries.push(Buffer.concat([Buffer.from(`L\0${childMode.toString(8)}\0`), childRelative, Buffer.from("\0"), await readlink(childAbsolute, { encoding: "buffer" }), Buffer.from("\0")]));
          } else if (childStat.isFile()) {
            entries.push(Buffer.concat([Buffer.from(`F\0${childMode.toString(8)}\0`), childRelative, Buffer.from("\0"), await readFile(childAbsolute), Buffer.from("\0")]));
          } else fail(`unsupported special entry beneath owned path: ${path}`);
        }
      }
      await walk(Buffer.from(absolute), Buffer.alloc(0));
      return { path, kind: "directory", mode, sha256: digest(entries) };
    }
    fail(`unsupported special owned path: ${path}`);
  } catch (error) {
    if (error?.code === "ENOENT") return { path, kind: "missing", mode: null, sha256: null };
    throw error;
  }
}

function parseIndex(rawIndex) {
  const records = [];
  for (const record of rawIndex.subarray(0, rawIndex.length - (rawIndex.at(-1) === 0 ? 1 : 0)).toString("latin1").split("\0")) {
    if (!record.length) continue;
    const bytes = Buffer.from(record, "latin1"), tab = bytes.indexOf(0x09);
    if (tab < 0) fail("malformed index record");
    const metadata = bytes.subarray(0, tab).toString("ascii"), match = metadata.match(/^(. )([0-7]{6}) [0-9a-f]+ ([0-3])$/);
    if (!match) fail("malformed index metadata");
    const path = bytes.subarray(tab + 1);
    if (!path.length) fail("malformed empty index path");
    records.push({ pathBase64: encode(path), recordBase64: encode(bytes), flag: match[1][0], mode: match[2], stage: Number(match[3]) });
  }
  return records;
}

function parseDebugFlags(raw) {
  const records = [], marker = Buffer.from("\tflags: ");
  let offset = 0;
  while (offset < raw.length) {
    const nul = raw.indexOf(0, offset); if (nul < 0) fail("malformed debug index path");
    const path = raw.subarray(offset, nul), flagsAt = raw.indexOf(marker, nul + 1); if (!path.length || flagsAt < 0) fail("malformed debug index record");
    const end = raw.indexOf(0x0a, flagsAt + marker.length); if (end < 0) fail("malformed debug index flags");
    const extendedFlags = raw.subarray(flagsAt + marker.length, end).toString("ascii"); if (!/^[0-9a-f]+$/.test(extendedFlags)) fail("malformed debug index flags");
    records.push({ pathBase64: encode(path), extendedFlags }); offset = end + 1;
  }
  return records;
}

async function snapshot(paths) {
  const root = await repositoryRoot(), safePaths = uniqueSafePaths(paths, "owned"), owned = [];
  for (const path of safePaths) owned.push(await fingerprint(root, path));
  const rawIndex = git("ls-files", "--stage", "-v", "-z"), indexEntries = parseIndex(rawIndex), debugEntries = parseDebugFlags(git("ls-files", "--debug", "-z"));
  if (indexEntries.length !== debugEntries.length) fail("index and debug record counts differ");
  indexEntries.forEach((entry, index) => { if (entry.pathBase64 !== debugEntries[index].pathBase64) fail("index and debug paths differ"); entry.extendedFlags = debugEntries[index].extendedFlags; });
  const indexDigest = indexEntries.flatMap((entry) => [decode(entry.recordBase64, "index record"), Buffer.from(`\0${entry.extendedFlags}\0`)]);
  return { schemaVersion: 2, repositoryRoot: root, indexSha256: digest(indexDigest), indexEntries, statusPorcelain: git("status", "--porcelain=v1", "-z").toString("base64"), owned };
}

function validateBaseline(value, currentRoot) {
  if (!value || value.schemaVersion !== 2 || value.repositoryRoot !== currentRoot || !/^[0-9a-f]{64}$/.test(value.indexSha256) || !Array.isArray(value.owned) || !Array.isArray(value.indexEntries)) fail("unsupported or foreign baseline schema");
  decode(value.statusPorcelain, "baseline status");
  const paths = uniqueSafePaths(value.owned.map((item) => item?.path), "baseline owned");
  for (let index = 0; index < value.owned.length; index++) {
    const item = value.owned[index], missing = item.kind === "missing";
    if (item.path !== paths[index] || !["missing", "file", "directory", "symlink"].includes(item.kind) || (missing ? item.mode !== null || item.sha256 !== null : !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o7777 || !/^[0-9a-f]{64}$/.test(item.sha256))) fail("invalid baseline owned record");
  }
  const indexKeys = new Set(), rawRecords = [];
  for (const entry of value.indexEntries) {
    const path = decode(entry?.pathBase64, "baseline index path"), record = decode(entry?.recordBase64, "baseline index record");
    const parsed = parseIndex(Buffer.concat([record, Buffer.from("\0")]))[0], key = `${entry.pathBase64}:${entry.stage}`;
    if (!path.length || !parsed || indexKeys.has(key) || parsed.pathBase64 !== entry.pathBase64 || parsed.recordBase64 !== entry.recordBase64 || parsed.flag !== entry.flag || parsed.mode !== entry.mode || parsed.stage !== entry.stage || !/^[0-9a-f]+$/.test(entry.extendedFlags)) fail("invalid baseline index record");
    indexKeys.add(key); rawRecords.push(record, Buffer.from(`\0${entry.extendedFlags}\0`));
  }
  if (digest(rawRecords) !== value.indexSha256) fail("invalid baseline index digest");
}

const [command, file, ...rawPaths] = process.argv.slice(2);
if (!command || !file || !["snapshot", "compare"].includes(command)) fail("usage: worktree-audit.mjs snapshot <output.json> [owned-path ...] | compare <baseline.json> [allowed-index-path ...]", 2);
if (command === "snapshot") {
  const state = await snapshot(rawPaths); await writeFile(resolve(file), `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" }); console.log(JSON.stringify({ ok: true, command, output: resolve(file), owned: state.owned.length }));
} else {
  const root = await repositoryRoot(), baseline = JSON.parse(await readFile(resolve(file), "utf8")); validateBaseline(baseline, root);
  const current = await snapshot(baseline.owned.map((item) => item.path)), allowedIndexPaths = uniqueSafePaths(rawPaths, "allowed index"), allowed = allowedIndexPaths.map((path) => Buffer.from(path));
  const retained = (entries) => entries.filter((entry) => !withinAllowed(decode(entry.pathBase64, "index path"), allowed));
  const currentByPathStage = new Map(current.indexEntries.map((entry) => [`${entry.pathBase64}:${entry.stage}`, entry]));
  const allowedFlagsPreserved = baseline.indexEntries.filter((entry) => withinAllowed(decode(entry.pathBase64, "baseline index path"), allowed)).every((entry) => { const found = currentByPathStage.get(`${entry.pathBase64}:${entry.stage}`); return !found || (found.flag === entry.flag && found.extendedFlags === entry.extendedFlags); });
  const indexPreserved = JSON.stringify(retained(current.indexEntries)) === JSON.stringify(retained(baseline.indexEntries)) && allowedFlagsPreserved;
  const ownedPreserved = JSON.stringify(current.owned) === JSON.stringify(baseline.owned);
  const result = { ok: indexPreserved && ownedPreserved, command, indexPreserved, ownedPreserved, allowedIndexPaths, allowedFlagsPreserved, changedOwnedPaths: baseline.owned.filter((item, index) => JSON.stringify(item) !== JSON.stringify(current.owned[index])).map((item) => item.path) };
  console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
}
