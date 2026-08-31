import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPairingUrl,
  ensureStoredToken,
  pickLanIp,
  resolvePairingTarget,
  rotateStoredToken,
} from "../src/pairing.ts";

test("pickLanIp returns the first non-internal IPv4", () => {
  assert.equal(
    pickLanIp({
      addresses: [
        { address: "127.0.0.1", family: "IPv4", internal: true },
        { address: "fe80::1", family: "IPv6", internal: false },
        { address: "192.168.1.7", family: "IPv4", internal: false },
      ],
    }),
    "192.168.1.7"
  );
  assert.equal(
    pickLanIp({
      addresses: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    }),
    undefined
  );
});

test("pairing url carries the token in the hash fragment", () => {
  assert.equal(
    buildPairingUrl("192.168.1.7", 4317, "sekret/+/=?"),
    "http://192.168.1.7:4317/#token=sekret%2F%2B%2F%3D%3F"
  );
});

test("resolvePairingTarget skips loopback, needs lan ip for 0.0.0.0", () => {
  assert.equal(resolvePairingTarget("127.0.0.1", "192.168.1.7").ok, false);
  const unspecified = resolvePairingTarget("0.0.0.0", "192.168.1.7");
  assert.deepEqual(unspecified, { ok: true, ip: "192.168.1.7" });
  assert.equal(resolvePairingTarget("0.0.0.0", undefined).ok, false);
  assert.deepEqual(resolvePairingTarget("192.168.1.7", undefined), {
    ok: true,
    ip: "192.168.1.7",
  });
});

test("token storage: explicit persists, stored is reused, rotate mints fresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptb-pairing-"));
  try {
    // --qr with nothing stored generates and persists.
    const first = ensureStoredToken(dir, undefined, true);
    assert.equal(first.generated, true);
    const file = join(dir, ".fleet", "token");
    assert.equal(readFileSync(file, "utf8").trim(), first.token);
    // Plain start reuses the stored token.
    const reused = ensureStoredToken(dir);
    assert.equal(reused.generated, false);
    assert.equal(reused.token, first.token);
    // Explicit --token wins and overwrites the file.
    const explicit = ensureStoredToken(dir, "my-token");
    assert.equal(explicit.token, "my-token");
    assert.equal(readFileSync(file, "utf8").trim(), "my-token");
    // --rotate-token mints a different token and persists it.
    const rotated = rotateStoredToken(dir);
    assert.notEqual(rotated, "my-token");
    assert.equal(readFileSync(file, "utf8").trim(), rotated);
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStartToken auto-enables auth on non-loopback binds only", async () => {
  const { resolveStartToken } = await import("../src/cli-core.ts");
  const dir = mkdtempSync(join(tmpdir(), "ptb-starttoken-"));
  try {
    // 0.0.0.0 without --token: mints + stores (release blocker behavior).
    const lan = resolveStartToken({
      fleetDir: dir,
      host: "0.0.0.0",
      wantsQr: false,
      wantsRotate: false,
    });
    assert.equal(typeof lan.token, "string");
    assert.equal((lan.token as string).length > 0, true);
    assert.equal(existsSync(join(dir, ".fleet", "token")), true);
    // Second run reuses the stored token (stable across restarts).
    const again = resolveStartToken({
      fleetDir: dir,
      host: "0.0.0.0",
      wantsQr: false,
      wantsRotate: false,
    });
    assert.equal(again.token, lan.token);
    // Explicit --token wins even on loopback, but loopback stays opt-in by default.
    const explicit = resolveStartToken({
      fleetDir: dir,
      host: "192.168.1.7",
      explicitToken: "mine",
      wantsQr: false,
      wantsRotate: false,
    });
    assert.equal(explicit.token, "mine");
    const loopback = resolveStartToken({
      fleetDir: dir,
      host: "127.0.0.1",
      wantsQr: false,
      wantsRotate: false,
    });
    assert.equal(loopback.token, undefined);
    // --qr on loopback still generates (pairing needs auth).
    const qrLoopback = resolveStartToken({
      fleetDir: dir,
      host: "127.0.0.1",
      wantsQr: true,
      wantsRotate: false,
    });
    assert.equal(typeof qrLoopback.token, "string");
    // --rotate-token mints a fresh one regardless of bind.
    const rotated = resolveStartToken({
      fleetDir: dir,
      host: "0.0.0.0",
      wantsQr: false,
      wantsRotate: true,
    });
    assert.notEqual(rotated.token, lan.token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("json payloads: init, start readiness, version", async () => {
  const { initJsonPayload, startReadinessPayload, versionJsonPayload } =
    await import("../src/cli-core.ts");
  assert.deepEqual(initJsonPayload("/fleets/demo"), {
    fleetDir: "/fleets/demo",
    created: true,
  });
  const withToken = startReadinessPayload(
    "http://0.0.0.0:4317",
    4317,
    4242,
    "t"
  );
  assert.deepEqual(withToken, {
    url: "http://0.0.0.0:4317",
    port: 4317,
    pid: 4242,
    token: "t",
  });
  // No token: the key is omitted entirely (not null).
  const noToken = startReadinessPayload("http://127.0.0.1:4317", 4317, 4242);
  assert.deepEqual(Object.keys(noToken).sort(), ["pid", "port", "url"]);
  assert.deepEqual(versionJsonPayload("@mobrienv/pi-tidy-bots", "0.1.0"), {
    name: "@mobrienv/pi-tidy-bots",
    version: "0.1.0",
  });
});

test("classifyStartFailure and formatError follow the exit-code contract", async () => {
  const { classifyStartFailure, formatError, CliError } =
    await import("../src/cli-core.ts");
  // Issue 29 item 4 classes: 2 state conflict, 3 port/addr, 4 runtime/auth.
  assert.equal(
    classifyStartFailure(
      "fleet lock held by pid 4242 (acquired …, heartbeat …)."
    ),
    2
  );
  assert.equal(
    classifyStartFailure("port 4317 is already in use — EADDRINUSE"),
    3
  );
  assert.equal(classifyStartFailure("no bots.toml in fleet dir /x"), 4);
  // formatError: one clean line, remedy in brackets when present.
  const err = new CliError("fleet lock held by pid 4242", {
    exitCode: 2,
  });
  assert.equal(formatError(err), "error: fleet lock held by pid 4242");
  const withFix = new CliError("unknown flag", { remedy: "use --token" });
  assert.equal(formatError(withFix), "error: unknown flag [fix: use --token]");
  assert.equal(formatError(new Error("plain")), "error: plain");
});

test("closestFlag suggests the nearest known flag", async () => {
  const { closestFlag } = await import("../src/cli-core.ts");
  assert.equal(closestFlag("tiken", ["token", "port", "host"]), "token");
  assert.equal(closestFlag("jsonn", ["json", "token"]), "json");
  assert.equal(closestFlag("zzzzz", ["token", "port"]), undefined);
});
