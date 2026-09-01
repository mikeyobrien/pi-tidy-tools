import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  appAssetCacheControl,
  appAssetMimeType,
  isHashedAsset,
  isPublicAssetPath,
  safeAppAssetPath,
} from "../src/daemon.ts";

test("app asset mime map covers the flutter web build", () => {
  assert.equal(appAssetMimeType("index.html"), "text/html; charset=utf-8");
  assert.equal(
    appAssetMimeType("main.dart.js"),
    "text/javascript; charset=utf-8"
  );
  assert.equal(appAssetMimeType("assets/fonts/font.ttf"), "font/ttf");
  assert.equal(
    appAssetMimeType("canvaskit/canvaskit.wasm"),
    "application/wasm"
  );
  assert.equal(appAssetMimeType("assets/fonts/icon.woff2"), "font/woff2");
  assert.equal(appAssetMimeType("no-extension"), "application/octet-stream");
});

test("hashed assets cache immutably, entry documents revalidate", () => {
  assert.equal(
    appAssetCacheControl("main.abc12345.js"),
    "public, max-age=31536000, immutable"
  );
  assert.equal(
    appAssetCacheControl("canvaskit/canvaskit.wasm"),
    "public, max-age=300",
    "canvaskit is version-stable, not hash-named"
  );
  assert.equal(appAssetCacheControl("index.html"), "no-store");
  assert.equal(appAssetCacheControl("manifest.json"), "no-store");
  assert.equal(appAssetCacheControl("version.json"), "no-store");
  assert.equal(
    appAssetCacheControl("/srv/app/public/app/index.html"),
    "no-store",
    "resolved mount paths keep the entry-document contract"
  );
  assert.equal(
    appAssetCacheControl("/srv/app/public/app/main.abc12345.js"),
    "public, max-age=31536000, immutable",
    "hashed absolute paths stay immutable"
  );
  assert.equal(
    appAssetCacheControl("main.dart.js"),
    "public, max-age=300",
    "stable-named entry script must revalidate"
  );
  assert.equal(isHashedAsset("assets/abc12345.png"), true);
});

test("safeAppAssetPath mounts under the root and refuses traversal", () => {
  const root = "/srv/app";
  assert.equal(
    safeAppAssetPath("/app/main.dart.js", root),
    join(root, "main.dart.js")
  );
  assert.equal(
    safeAppAssetPath("/app/", root),
    join(root, "index.html"),
    "directory mount serves the entry document"
  );
  assert.equal(
    safeAppAssetPath("/app", root),
    join(root, "index.html"),
    "bare mount serves the entry document"
  );
  assert.equal(safeAppAssetPath("/app/../secrets.txt", root), undefined);
});

test("isPublicAssetPath bypasses auth for asset trees only", () => {
  for (const pub of [
    "/app",
    "/app/",
    "/app/index.html",
    "/app/main.dart.js",
    "/app/assets/NotoSans.woff2",
    "/app.js",
    "/md.js",
    "/parts.js",
    "/style.css",
  ])
    assert.equal(isPublicAssetPath(pub), true, `${pub} must bypass`);
  for (const gated of [
    "/",
    "/console",
    "/api/fleet",
    "/api/ws",
    "/bus/send",
    "/appetizer",
  ])
    assert.equal(isPublicAssetPath(gated), false, `${gated} must stay gated`);
});
