import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const PYTHON_VERSION = "3.14.6";
export const SQLITE_VERSION = "3.53.4";
export const SQLITE_SOURCES = Object.freeze([
  Object.freeze({
    name: "sqlite3.c",
    url: "https://raw.githubusercontent.com/nodejs/node/v26.7.0/deps/sqlite/sqlite3.c",
    bytes: 9515341,
    sha256: "b1dd5d74ec7f29055a6684fa06fb3c2f6821c87dd38f9a458dfd2e8a1db28189",
  }),
  Object.freeze({
    name: "sqlite3.h",
    url: "https://raw.githubusercontent.com/nodejs/node/v26.7.0/deps/sqlite/sqlite3.h",
    bytes: 690838,
    sha256: "919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d",
  }),
]);

export function verifySource(source, bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== source.bytes || digest !== source.sha256) {
    throw new Error(
      `${source.name}: source size/SHA256 mismatch (${bytes.length}, ${digest})`
    );
  }
  return bytes;
}

export async function downloadSource(source, fetchSource = fetch) {
  const response = await fetchSource(source.url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`${source.name}: download failed (${response.status})`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > source.bytes) {
      throw new Error(`${source.name}: download exceeds pinned source size`);
    }
    chunks.push(chunk);
  }
  return verifySource(source, Buffer.concat(chunks));
}

function safePath(value) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error(
      "Runtime paths must be absolute and contain no line breaks or NUL"
    );
  }
  return value;
}

function libraryPath(value) {
  safePath(value);
  if (value.includes(":"))
    throw new Error("Runtime library paths must not contain a colon");
  return value;
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function interpreterWrapper({
  python,
  sqliteDirectory,
  pythonLibraryDirectory,
}) {
  safePath(python);
  libraryPath(sqliteDirectory);
  libraryPath(pythonLibraryDirectory);
  // Capture the interpreter's own LIBDIR: plugin tests intentionally run without
  // the setup-python action's inherited environment. No global linker changes.
  return `#!/bin/sh
if [ ! -r ${quote(join(sqliteDirectory, "libsqlite3.so.0"))} ]; then
  echo 'Certified SQLite runtime is missing' >&2
  exit 1
fi
LD_LIBRARY_PATH=${quote(`${sqliteDirectory}:${pythonLibraryDirectory}`)}
export LD_LIBRARY_PATH
exec ${quote(python)} "$@"
`;
}

export function verifyRuntime(runtime, requireSqlite = true) {
  if (
    runtime.python !== PYTHON_VERSION ||
    runtime.implementation !== "CPython"
  ) {
    throw new Error(
      `Certified CPython ${PYTHON_VERSION} is required; got ${runtime.implementation} ${runtime.python}`
    );
  }
  if (requireSqlite && runtime.sqlite !== SQLITE_VERSION) {
    throw new Error(
      `Certified SQLite ${SQLITE_VERSION} is required; got ${runtime.sqlite}`
    );
  }
}

const describePython = `import json, platform, sys, sysconfig
print(json.dumps({"python": platform.python_version(), "implementation": platform.python_implementation(), "executable": sys.executable, "libdir": sysconfig.get_config_var("LIBDIR")}))`;
const describeSqlite = `import json, platform, sqlite3, tempfile
with tempfile.TemporaryDirectory() as directory:
    db = sqlite3.connect(directory + "/certification.db")
    assert db.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
    db.execute("PRAGMA synchronous=FULL")
    assert db.execute("PRAGMA synchronous").fetchone()[0] == 2
    db.execute("CREATE TABLE certification (value TEXT) STRICT")
    db.execute("INSERT INTO certification VALUES (?)", ("durable",))
    db.commit()
    db.close()
    db = sqlite3.connect(directory + "/certification.db")
    assert db.execute("SELECT value FROM certification").fetchone()[0] == "durable"
    db.close()
print(json.dumps({"python": platform.python_version(), "implementation": platform.python_implementation(), "sqlite": sqlite3.sqlite_version}))`;

export async function setupRuntime(
  { python, directory, githubEnv },
  dependencies = {}
) {
  const platform = dependencies.platform ?? process.platform;
  const run = dependencies.execute ?? execute;
  if (platform !== "linux")
    throw new Error(
      "The isolated shared-library build is supported only on Linux"
    );
  safePath(python);
  libraryPath(directory);
  if (githubEnv !== undefined) safePath(githubEnv);
  const base = JSON.parse(
    (
      await run(python, ["-I", "-c", describePython], {
        encoding: "utf8",
        timeout: 30_000,
      })
    ).stdout
  );
  verifyRuntime(base, false);
  safePath(base.executable);
  libraryPath(base.libdir);

  // Verify every downloaded byte before invoking the compiler or publishing an
  // interpreter. The official Node source tag matches the gateway's SQL engine.
  const sources = await Promise.all(
    SQLITE_SOURCES.map((source) => downloadSource(source, dependencies.fetch))
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(join(directory, "runtime-"));
  try {
    const lib = join(output, "lib");
    await mkdir(lib, { mode: 0o700 });
    await Promise.all(
      SQLITE_SOURCES.map((source, index) =>
        writeFile(join(output, source.name), sources[index], {
          flag: "wx",
          mode: 0o600,
        })
      )
    );
    await run(
      "/usr/bin/cc",
      [
        "-O2",
        "-fPIC",
        "-shared",
        "-Wl,-soname,libsqlite3.so.0",
        "-DSQLITE_THREADSAFE=1",
        "-DSQLITE_ENABLE_COLUMN_METADATA",
        "-DSQLITE_ENABLE_FTS5",
        "-DSQLITE_ENABLE_RTREE",
        "-DSQLITE_ENABLE_DBSTAT_VTAB",
        "-DSQLITE_ENABLE_MATH_FUNCTIONS",
        join(output, "sqlite3.c"),
        "-o",
        join(lib, "libsqlite3.so.0"),
        "-ldl",
        "-lpthread",
        "-lm",
      ],
      { encoding: "utf8", timeout: 300_000, maxBuffer: 1024 * 1024 }
    );
    const interpreter = join(output, "python");
    await writeFile(
      interpreter,
      interpreterWrapper({
        python: base.executable,
        sqliteDirectory: lib,
        pythonLibraryDirectory: base.libdir,
      }),
      { flag: "wx", mode: 0o700 }
    );
    await chmod(interpreter, 0o700);
    const certified = JSON.parse(
      (
        await run(interpreter, ["-I", "-c", describeSqlite], {
          encoding: "utf8",
          timeout: 30_000,
        })
      ).stdout
    );
    verifyRuntime(certified);
    if (githubEnv !== undefined)
      await appendFile(githubEnv, `TIDY_TEST_PYTHON=${interpreter}\n`, {
        mode: 0o600,
      });
    return { interpreter, ...certified };
  } catch (error) {
    await rm(output, { force: true, recursive: true });
    throw error;
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === "--verify-sources") {
    for (const source of SQLITE_SOURCES) {
      await downloadSource(source);
      console.log(`${source.name}: ${source.sha256} verified`);
    }
    return;
  }
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--python", "--directory", "--github-env"].includes(args[index]) ||
      !args[index + 1] ||
      values[args[index]]
    ) {
      throw new Error(
        "Usage: --python /path/to/python --directory /isolated/output [--github-env /path/to/GITHUB_ENV], or --verify-sources"
      );
    }
    values[args[index]] = args[index + 1];
  }
  const result = await setupRuntime({
    python: values["--python"],
    directory: values["--directory"],
    githubEnv: values["--github-env"],
  });
  console.log(
    `Certified CPython ${result.python}, SQLite ${result.sqlite}: ${result.interpreter}`
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
