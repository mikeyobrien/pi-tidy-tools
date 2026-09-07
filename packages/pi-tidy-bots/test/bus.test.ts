import assert from "node:assert/strict";
import test from "node:test";
import { coerceBusBehavior, coerceMessageImages } from "../src/daemon.ts";

test("coerceBusBehavior accepts the enum values and omission", () => {
  assert.deepEqual(coerceBusBehavior(undefined), {
    ok: true,
    behavior: undefined,
  });
  assert.deepEqual(coerceBusBehavior("steer"), { ok: true, behavior: "steer" });
  assert.deepEqual(coerceBusBehavior("followUp"), {
    ok: true,
    behavior: "followUp",
  });
});

test("coerceBusBehavior rejects anything outside the enum", () => {
  assert.equal(coerceBusBehavior("interrupt").ok, false);
  assert.equal(coerceBusBehavior("Steer").ok, false);
  assert.equal(coerceBusBehavior("").ok, false);
  assert.equal(coerceBusBehavior(7).ok, false);
  assert.equal(coerceBusBehavior(null).ok, false);
});

test("coerceMessageImages accepts one image and omission", () => {
  assert.deepEqual(coerceMessageImages(undefined), {
    ok: true,
    images: undefined,
  });
  assert.deepEqual(coerceMessageImages([]), { ok: true, images: undefined });
  const single = coerceMessageImages([
    { mediaType: "image/png", data: "aGk=" },
  ]);
  assert.equal(single.ok, true);
  if (single.ok)
    assert.deepEqual(single.images, [
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
});

test("coerceHandoffImages forwards every image, no cap (issue 75)", async () => {
  const { coerceHandoffImages } = await import("../src/daemon.ts");
  const many = coerceHandoffImages([
    { mediaType: "image/png", data: "aGk=" },
    { mediaType: "image/jpeg", data: "eHg=" },
    { mediaType: "image/webp", data: "eXo=" },
  ]);
  assert.equal(many.ok, true);
  if (many.ok) {
    assert.equal(many.images?.length, 3, "no cap of one");
    assert.deepEqual(many.images?.[1], {
      type: "image",
      data: "eHg=",
      mimeType: "image/jpeg",
    });
  }
  assert.deepEqual(
    coerceHandoffImages(undefined),
    { ok: true, images: undefined },
    "text-only handoff unchanged"
  );
  assert.equal(
    coerceHandoffImages([{ mediaType: "image/png" }]).ok,
    false,
    "malformed item rejected"
  );
  assert.equal(coerceHandoffImages("nope").ok, false);
});

test("coerceMessageMedia routes video/files to journal records (issue 110)", async () => {
  const { coerceMessageMedia } = await import("../src/daemon.ts");
  // Video → attachment record only; no child images (pi prompt takes
  // ImageContent — the bytes are NOT deliverable to the model; the record
  // is what clients render as a file chip).
  const video = coerceMessageMedia([
    { mediaType: "video/mp4", data: "AAAA", name: "clip.mp4" },
  ]);
  assert.equal(video.ok, true);
  if (video.ok) {
    assert.equal(video.images, undefined, "no child images for video");
    assert.deepEqual(video.attachments, [
      { mediaType: "video/mp4", name: "clip.mp4" },
    ]);
  }
  // application/* → same journaling.
  const pdf = coerceMessageMedia([
    { mediaType: "application/pdf", data: "JVBERiA=" },
  ]);
  assert.equal(pdf.ok, true);
  if (pdf.ok)
    assert.deepEqual(pdf.attachments, [{ mediaType: "application/pdf" }]);
  // image/* still routes to the child prompt unchanged.
  const image = coerceMessageMedia([
    { mediaType: "image/png", data: "aGk=", name: "shot.png" },
  ]);
  assert.equal(image.ok, true);
  if (image.ok) {
    assert.deepEqual(image.images, [
      { type: "image", data: "aGk=", mimeType: "image/png" },
    ]);
    assert.equal(image.attachments, undefined);
  }
  // Composer cap of one total attachment holds; malformed still fails.
  assert.equal(
    coerceMessageMedia([
      { mediaType: "image/png", data: "aGk=" },
      { mediaType: "video/mp4", data: "AAAA" },
    ]).ok,
    false,
    "cap one total attachment"
  );
  assert.equal(coerceMessageMedia([{ mediaType: "video/mp4" }]).ok, false);
});

test("coerceMessageImages rejects multi, empty, and malformed payloads", () => {
  // Composer path stays capped at one (UI contract); the bus path is
  // covered by coerceHandoffImages above.
  assert.equal(
    coerceMessageImages([
      { mediaType: "image/png", data: "aGk=" },
      { mediaType: "image/png", data: "aGk=" },
    ]).ok,
    false,
    "cap: one image per message"
  );
  assert.equal(
    coerceMessageImages([{ mediaType: "", data: "aGk=" }]).ok,
    false
  );
  assert.equal(coerceMessageImages([{ mediaType: "image/png" }]).ok, false);
  assert.equal(coerceMessageImages(["nope"]).ok, false);
  assert.equal(coerceMessageImages("image.png").ok, false);
});

test("wsUpgradeAuthorized accepts bearer header and query param", async () => {
  const { wsUpgradeAuthorized } = await import("../src/daemon.ts");
  const url = (q: string) => new URL(`http://x/api/ws${q}`);
  const req = (auth?: string) => ({ headers: { authorization: auth } });
  // No token configured: everything is allowed.
  assert.equal(
    wsUpgradeAuthorized(req(), url("?token=wrong"), undefined),
    true
  );
  assert.equal(wsUpgradeAuthorized(req(), url(""), undefined), true);
  // Query param (browser idiom).
  assert.equal(
    wsUpgradeAuthorized(req(), url("?token=sekret"), "sekret"),
    true
  );
  assert.equal(wsUpgradeAuthorized(req(), url("?token=nope"), "sekret"), false);
  // Bearer header (native client idiom).
  assert.equal(
    wsUpgradeAuthorized(req("Bearer sekret"), url(""), "sekret"),
    true
  );
  assert.equal(
    wsUpgradeAuthorized(req("Bearer nope"), url(""), "sekret"),
    false
  );
  assert.equal(wsUpgradeAuthorized(req(), url(""), "sekret"), false);
});

test("writeWsAuthFailure completes the upgrade with an HTTP 401 frame", async () => {
  const { writeWsAuthFailure, WS_AUTH_FAILURE_RESPONSE } =
    await import("../src/daemon.ts");
  const written: string[] = [];
  let destroyed = false;
  writeWsAuthFailure({
    write: (chunk) => written.push(chunk),
    destroy: () => {
      destroyed = true;
    },
  });
  assert.deepEqual(written, [WS_AUTH_FAILURE_RESPONSE]);
  assert.match(WS_AUTH_FAILURE_RESPONSE, /^HTTP\/1\.1 401 Unauthorized/);
  assert.match(WS_AUTH_FAILURE_RESPONSE, /Connection: close/);
  assert.equal(destroyed, true, "socket is destroyed after the 401 frame");
});

test("delta throttle emits first frame, then only on 300ms or 256B growth", async () => {
  const { deltaThrottleDue } = await import("../src/daemon.ts");
  // First frame of a turn always emits.
  assert.equal(deltaThrottleDue(null, 10, 1000), true);
  // Below both thresholds: throttled.
  assert.equal(deltaThrottleDue({ at: 1000, chars: 10 }, 20, 1100), false);
  // 300ms elapsed: emits.
  assert.equal(deltaThrottleDue({ at: 1000, chars: 10 }, 20, 1301), true);
  // 256 bytes of growth: emits even with no time gap.
  assert.equal(deltaThrottleDue({ at: 1000, chars: 10 }, 266, 1005), true);
});
