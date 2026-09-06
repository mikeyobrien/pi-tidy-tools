import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  downloadSource,
  interpreterWrapper,
  PYTHON_VERSION,
  setupRuntime,
  SQLITE_SOURCES,
  SQLITE_VERSION,
  verifyRuntime,
  verifySource,
} from "./setup-gateway-python-sqlite.mjs";

const execute = promisify(execFile);
const bytes = Buffer.from("reviewed source bytes\n");
const source = {
  name: "fixture.c",
  url: "https://example.invalid/fixture.c",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

test("both exact Node SQLite amalgamation artifacts have immutable content pins", () => {
  assert.equal(PYTHON_VERSION, "3.14.6");
  assert.equal(SQLITE_VERSION, "3.53.4");
  assert.deepEqual(
    SQLITE_SOURCES.map(({ name, sha256 }) => [name, sha256]),
    [
      [
        "sqlite3.c",
        "b1dd5d74ec7f29055a6684fa06fb3c2f6821c87dd38f9a458dfd2e8a1db28189",
      ],
      [
        "sqlite3.h",
        "919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d",
      ],
    ]
  );
  for (const pin of SQLITE_SOURCES)
    assert.equal(
      pin.url,
      `https://raw.githubusercontent.com/nodejs/node/v26.7.0/deps/sqlite/${pin.name}`
    );
});

test("hash and size checks reject mutations and truncation before compilation", () => {
  assert.equal(verifySource(source, bytes), bytes);
  const mutated = Buffer.from(bytes);
  mutated[0] ^= 1;
  assert.throws(() => verifySource(source, mutated), /SHA256 mismatch/);
  assert.throws(
    () => verifySource(source, bytes.subarray(1)),
    /SHA256 mismatch/
  );
});

test("source downloads reject HTTP failures and oversize bodies, with redirects forbidden", async () => {
  assert.deepEqual(
    await downloadSource(source, async (url, options) => {
      assert.equal(url, source.url);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(bytes);
    }),
    bytes
  );
  await assert.rejects(
    downloadSource(
      source,
      async () => new Response("missing", { status: 404 })
    ),
    /download failed \(404\)/
  );
  await assert.rejects(
    downloadSource(
      source,
      async () => new Response(Buffer.concat([bytes, bytes]))
    ),
    /exceeds pinned source size/
  );
});

test("runtime certification refuses Python, implementation, and SQLite mismatches", () => {
  const certified = {
    python: PYTHON_VERSION,
    implementation: "CPython",
    sqlite: SQLITE_VERSION,
  };
  verifyRuntime(certified);
  verifyRuntime({ ...certified, sqlite: "unexamined" }, false);
  assert.throws(
    () => verifyRuntime({ ...certified, python: "3.14.5" }),
    /CPython 3\.14\.6 is required/
  );
  assert.throws(
    () => verifyRuntime({ ...certified, implementation: "PyPy" }),
    /CPython 3\.14\.6 is required/
  );
  assert.throws(
    () => verifyRuntime({ ...certified, sqlite: "3.53.3" }),
    /SQLite 3\.53\.4 is required/
  );
});

test("shell interpreter preserves all arguments and supplies libraries without inherited environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy runtime 'quoted' "));
  try {
    const sqliteDirectory = join(directory, "sqlite 'lib'");
    const pythonLibraryDirectory = join(directory, "python lib");
    await mkdir(sqliteDirectory);
    await writeFile(join(sqliteDirectory, "libsqlite3.so.0"), "fixture");
    const wrapper = join(directory, "python");
    await writeFile(
      wrapper,
      interpreterWrapper({
        python: process.execPath,
        sqliteDirectory,
        pythonLibraryDirectory,
      }),
      { mode: 0o700 }
    );
    const originalLibraryPath = process.env.LD_LIBRARY_PATH;
    const args = [
      "",
      "plain",
      "spaces and 'quotes'",
      "\nline break",
      "$(do-not-execute)",
      "--flag",
      "雪",
    ];
    const result = await execute(
      wrapper,
      [
        "-e",
        "process.stdout.write(JSON.stringify({args:process.argv.slice(1),libraries:process.env.LD_LIBRARY_PATH}))",
        "--",
        ...args,
      ],
      { env: {}, encoding: "utf8" }
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      args,
      libraries: `${sqliteDirectory}:${pythonLibraryDirectory}`,
    });
    assert.equal(process.env.LD_LIBRARY_PATH, originalLibraryPath);
    await assert.rejects(
      execute(wrapper, ["-e", "process.exit(23)"], { env: {} }),
      { code: 23 }
    );
    await rm(join(sqliteDirectory, "libsqlite3.so.0"));
    await assert.rejects(
      execute(wrapper, ["-e", "process.stdout.write('must not run')"], {
        env: {},
      }),
      (error) =>
        error.code === 1 &&
        error.stdout === "" &&
        /Certified SQLite runtime is missing/.test(error.stderr)
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime paths reject shell environment line breaks and library search separators", () => {
  const paths = {
    python: "/python",
    sqliteDirectory: "/sqlite",
    pythonLibraryDirectory: "/python/lib",
  };
  assert.throws(
    () => interpreterWrapper({ ...paths, python: "/python\nINJECTED=value" }),
    /line breaks/
  );
  assert.throws(
    () =>
      interpreterWrapper({ ...paths, sqliteDirectory: "/sqlite:/unreviewed" }),
    /colon/
  );
  assert.throws(
    () => interpreterWrapper({ ...paths, python: "python3" }),
    /absolute/
  );
});

test("invalid source never invokes compiler, creates runtime, or exports an interpreter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tidy-setup-refusal-"));
  try {
    const destination = join(directory, "runtime");
    const githubEnv = join(directory, "github-env");
    await writeFile(githubEnv, "UNCHANGED=1\n");
    const calls = [];
    await assert.rejects(
      setupRuntime(
        { python: "/certified/python", directory: destination, githubEnv },
        {
          platform: "linux",
          execute: async (...args) => {
            calls.push(args);
            return {
              stdout: JSON.stringify({
                python: PYTHON_VERSION,
                implementation: "CPython",
                executable: "/certified/python",
                libdir: "/certified/lib",
              }),
            };
          },
          fetch: async () => new Response("tampered source"),
        }
      ),
      /SHA256 mismatch/
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "/certified/python");
    await assert.rejects(access(destination), { code: "ENOENT" });
    assert.equal(await readFile(githubEnv, "utf8"), "UNCHANGED=1\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported build hosts fail explicitly without invoking tools", async () => {
  await assert.rejects(
    setupRuntime(
      { python: "/python", directory: "/output" },
      {
        platform: "darwin",
        execute: async () => {
          throw new Error("must not execute");
        },
      }
    ),
    /only on Linux/
  );
});

test("release workflow certifies exact Python and SQLite before workspace tests", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8"
  );
  assert.match(
    workflow,
    /actions\/setup-python@e797f83bcb11b83ae66e0230d6156d7c80228e7c/
  );
  assert.match(workflow, /python-version: 3\.14\.6/);
  assert.match(
    workflow,
    /setup-gateway-python-sqlite\.mjs --python "\$GATEWAY_PYTHON" --directory "\$RUNNER_TEMP\/tidy-gateway-python" --github-env "\$GITHUB_ENV"/
  );
  assert.ok(
    workflow.indexOf("setup-gateway-python-sqlite.mjs") <
      workflow.indexOf("npm test")
  );
  assert.doesNotMatch(workflow, /continue-on-error|LD_LIBRARY_PATH=/);
});
