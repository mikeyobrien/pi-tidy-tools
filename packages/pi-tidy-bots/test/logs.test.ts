import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRotatingLogWriter } from "../src/logs.ts";
import { isPortHeld, healthCheck, waitPortReleased } from "../src/cli-core.ts";
import { createServer } from "node:http";

test("rotating log writer caps size and keeps generations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-logs-"));
  try {
    const writer = createRotatingLogWriter(dir, "daemon.log", 200, 3);
    for (let i = 0; i < 40; i++) writer.write(`line ${i} ${"x".repeat(20)}`);
    // Current + up to 3 generations exist; content preserved in order.
    const gens = [1, 2, 3]
      .map((n) => join(dir, `daemon.log.${n}`))
      .filter(existsSync);
    assert.ok(gens.length >= 1, "at least one rotation happened");
    const all = ["daemon.log", ...gens.map((g) => g.split("/").pop()!)]
      .reverse()
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("");
    assert.match(all, /line 39/, "newest line present");
    assert.ok(!all.includes("line 0 "), "oldest lines aged out (keep=3)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "waitPortReleased resolves when the port frees",
  { timeout: 10000 },
  async () => {
    const { createServer } = await import("node:http");
    const server = createServer(() => {});
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const port = (server.address() as { port: number }).port;
    assert.equal(await isPortHeld(port), true, "held while listening");
    const close = new Promise<void>((resolve) => server.close(() => resolve()));
    const released = await waitPortReleased(port, 3000);
    await close;
    assert.equal(released, true, "port released after close");
  }
);

test("healthCheck accepts any HTTP response and fails on connection error", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  assert.equal(await healthCheck(`http://127.0.0.1:${port}/api/fleet`), true);
  server.close();
  assert.equal(
    await healthCheck(`http://127.0.0.1:1/api/fleet`),
    false,
    "connection refused is unhealthy"
  );
});
