/**
 * Phone pairing for the fleet console (issue 20 item 8): LAN pairing URLs,
 * token storage at `.fleet/token`, and `--rotate-token` support.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface LanIpSource {
  addresses: { address: string; family: string; internal: boolean }[];
}

/** First non-internal IPv4 address, in interface order. */
export function pickLanIp(source: LanIpSource): string | undefined {
  const hit = source.addresses.find((a) => a.family === "IPv4" && !a.internal);
  return hit?.address;
}

/**
 * Pairing URL: the token rides in the hash fragment so it never reaches the
 * server or access logs — the console reads it from location.hash.
 */
export function buildPairingUrl(
  ip: string,
  port: number,
  token: string
): string {
  return `http://${ip}:${port}/#token=${encodeURIComponent(token)}`;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Loopback binds can never serve a phone/LAN client. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
const UNSPECIFIED_HOSTS = new Set(["0.0.0.0", "::"]);

/**
 * Which IP should the QR advertise?
 * - loopback-only bind: skip (a phone can never reach it)
 * - unspecified bind (0.0.0.0/::): the detected LAN IP
 * - specific bind: that address itself
 */
export function resolvePairingTarget(
  host: string,
  lanIp: string | undefined
): { ok: true; ip: string } | { ok: false; reason: string } {
  if (LOOPBACK_HOSTS.has(host))
    return {
      ok: false,
      reason: `host is ${host} — a phone cannot reach loopback; restart with --host 0.0.0.0 to pair`,
    };
  if (UNSPECIFIED_HOSTS.has(host))
    return lanIp
      ? { ok: true, ip: lanIp }
      : {
          ok: false,
          reason: "no non-internal IPv4 address found to advertise",
        };
  return { ok: true, ip: host };
}

function tokenFile(fleetDir: string): string {
  return join(fleetDir, ".fleet", "token");
}

function writeToken(fleetDir: string, token: string): string {
  mkdirSync(join(fleetDir, ".fleet"), { recursive: true });
  writeFileSync(tokenFile(fleetDir), `${token}\n`);
  return token;
}

/**
 * Token for this run: an explicit --token wins and is persisted; otherwise the
 * stored `.fleet/token` is reused; a --qr run without either generates one so
 * pairing always authenticates.
 */
export function ensureStoredToken(
  fleetDir: string,
  explicit?: string,
  generate = false
): { token: string; generated: boolean } {
  if (explicit)
    return { token: writeToken(fleetDir, explicit), generated: false };
  const file = tokenFile(fleetDir);
  if (!generate && existsSync(file)) {
    const stored = readFileSync(file, "utf8").trim();
    if (stored) return { token: stored, generated: false };
  }
  return { token: writeToken(fleetDir, randomUUID()), generated: true };
}

/** `--rotate-token`: mint a fresh stored token and return it. */
export function rotateStoredToken(fleetDir: string): string {
  return writeToken(fleetDir, randomUUID());
}
