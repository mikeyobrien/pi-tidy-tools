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
