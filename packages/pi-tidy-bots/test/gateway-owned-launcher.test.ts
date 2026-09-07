import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import {
  ownedProcessIdentity,
  ownedGroupHasExited,
} from "../src/gateway/process-ownership.ts";

const launcher = fileURLToPath(
  new URL("../src/gateway/owned-launcher.mjs", import.meta.url)
);
const candidate = "/opt/homebrew/opt/python@3.14/bin/python3.14";
const python =
  process.env.TIDY_TEST_PYTHON ??
  (existsSync(candidate) ? candidate : "/usr/bin/python3");
function completion(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
  );
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Launcher fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
for (const scenario of ["success", "failure", "signal", "missing-executable"]) {
  test(`owned launcher preserves native ${scenario} after group cleanup`, async () => {
    const token = `tidy-launch-${randomUUID()}`;
    const child = spawn(
      process.execPath,
      [
        launcher,
        token,
        scenario === "missing-executable"
          ? "/tidy-missing-executable"
          : process.execPath,
        "-e",
        scenario === "signal"
          ? "process.kill(process.pid, 'SIGTERM')"
          : `process.exit(${scenario === "failure" ? 37 : 0})`,
      ],
      { env: {}, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe"] }
    );
    const closed = completion(child);
    child.stderr!.resume();
    const control = child.stdio[3] as Writable;
    try {
      await ownedProcessIdentity(child.pid!, token);
      control.write(JSON.stringify({ activate: token, env: {} }) + "\n");
      const result = await closed;
      assert.deepEqual(
        result,
        scenario === "signal"
          ? { code: null, signal: "SIGTERM" }
          : {
              code:
                scenario === "failure"
                  ? 37
                  : scenario === "missing-executable"
                    ? 127
                    : 0,
              signal: null,
            }
      );
      assert.equal(await ownedGroupHasExited(child.pid!), true);
    } finally {
      control.end();
      await closed;
    }
  });
}

test("Python pass_fds uses a private activation pipe without leaking it into native stdio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidy-python-launch-"));
  const marker = join(dir, "effect");
  const token = `tidy-launch-${randomUUID()}`;
  const script = `import os, sys, subprocess, json
occupied = [os.open(os.devnull, os.O_RDONLY) for _ in range(4)]
read_fd, write_fd = os.pipe()
native = "import os,sys,json;from pathlib import Path\\nPath(" + repr(sys.argv[4]) + ").write_text('started')\\ntry:\\n os.fstat(" + str(read_fd) + "); leaked=True\\nexcept OSError:\\n leaked=False\\nprint(json.dumps({'input':sys.stdin.read(),'leaked':leaked}),flush=True)\\nsys.exit(37)"
child = subprocess.Popen([sys.argv[1],sys.argv[2],sys.argv[3],"--control-fd="+str(read_fd),sys.executable,"-I","-c",native], start_new_session=True, pass_fds=(read_fd,), env={}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
os.close(read_fd)
for fd in occupied:
 os.close(fd)
print(json.dumps({'pid':child.pid,'fd':read_fd}),flush=True)
try:
 activation = sys.stdin.readline().encode()
 os.write(write_fd, activation)
 output, error = child.communicate(b'native input', timeout=5)
 print(json.dumps({'returncode':child.returncode,'output':output.decode(),'error':error.decode()}),flush=True)
finally:
 os.close(write_fd)
 if child.poll() is None:
  child.wait(timeout=12)
`;
  const driver = spawn(
    python,
    ["-I", "-c", script, process.execPath, launcher, token, marker],
    {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const closed = completion(driver);
  let output = "",
    error = "",
    pid: number | undefined;
  driver.stdout!.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  driver.stderr!.setEncoding("utf8").on("data", (chunk) => {
    error += chunk;
  });
  try {
    await until(() => output.includes("\n") || driver.exitCode !== null);
    assert.equal(error, "");
    const prepared = JSON.parse(output.split("\n")[0]);
    assert.ok(prepared.fd > 3);
    pid = prepared.pid;
    await ownedProcessIdentity(pid!, token);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    driver.stdin!.write(JSON.stringify({ activate: token, env: {} }) + "\n");
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.equal(error, "");
    const result = JSON.parse(output.trim().split("\n")[1]);
    assert.equal(result.error, "");
    assert.equal(result.returncode, 37);
    assert.deepEqual(JSON.parse(result.output), {
      input: "native input",
      leaked: false,
    });
    assert.equal(await ownedGroupHasExited(pid!), true);
  } finally {
    driver.stdin!.end();
    if (driver.exitCode === null && driver.signalCode === null)
      driver.kill("SIGTERM");
    await closed;
    if (pid) await until(() => ownedGroupHasExited(pid!));
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid control descriptors are rejected before native activation", async () => {
  for (const descriptor of ["0", "1", "2", "-1", "65536", "3extra"]) {
    const child = spawn(
      process.execPath,
      [
        launcher,
        `tidy-launch-${randomUUID()}`,
        `--control-fd=${descriptor}`,
        process.execPath,
        "-e",
        "process.exit(99)",
      ],
      { env: {}, stdio: "ignore" }
    );
    assert.deepEqual(await completion(child), { code: 64, signal: null });
  }
});

for (const signal of ["SIGPIPE", "SIGUSR1"]) {
  test(`native ${signal} cannot strand the supervisor or open a debugger`, async () => {
    const token = `tidy-launch-${randomUUID()}`;
    const child = spawn(
      process.execPath,
      [
        launcher,
        token,
        python,
        "-I",
        "-c",
        `import os,signal;signal.signal(signal.${signal},signal.SIG_DFL);os.kill(os.getpid(),signal.${signal})`,
      ],
      {
        env: {},
        detached: true,
        stdio: ["ignore", "ignore", "pipe", "pipe"],
      }
    );
    let diagnostics = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk) => {
      diagnostics += chunk;
    });
    const closed = completion(child);
    const control = child.stdio[3] as Writable;
    try {
      await ownedProcessIdentity(child.pid!, token);
      control.write(JSON.stringify({ activate: token, env: {} }) + "\n");
      const result = await closed;
      assert.deepEqual(
        result,
        signal === "SIGUSR1"
          ? { code: 128 + constants.signals.SIGUSR1, signal: null }
          : { code: null, signal }
      );
      assert.equal(diagnostics, "");
      assert.equal(await ownedGroupHasExited(child.pid!), true);
    } finally {
      control.end();
      await closed;
    }
  });
}
