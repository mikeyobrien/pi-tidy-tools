import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./imagegen-fixture.js"; // registers the fake providers — zero core edits
import {
  registerImageProvider,
  getImageProvider,
  listImageProviders,
} from "../imagegen/registry.js";
import { buildGenerateImageTool } from "../imagegen/tool.js";
import {
  GROK_ASPECTS,
  getXaiApiKey,
} from "../imagegen/providers/grok-build.js";

// Issue 132: generate_image — provider seam open/closed, typed errors,
// path-only outputs, grok-build auth-gated without creds.

test("registry: fake providers register and resolve without core edits", () => {
  assert.ok(getImageProvider("fake-a"), "fake-a registered via fixture import");
  assert.ok(getImageProvider("fake-b"), "SECOND fake — open/closed proven");
  assert.ok(listImageProviders().includes("grok-build"), "default present");
  // Inline registration works too (third fake, still no core file touched).
  registerImageProvider({
    id: "fake-c",
    maxCount: 1,
    generate: async () => ({
      ok: true,
      images: [{ buffer: Buffer.from("c"), mediaType: "image/png" }],
    }),
  });
  assert.ok(getImageProvider("fake-c"));
});

test("tool: fake provider writes files, returns paths only", async () => {
  const out = mkdtempSync(join(tmpdir(), "ptb-img-tool-"));
  try {
    const tool = buildGenerateImageTool({
      providerId: "fake-a",
      outputRoot: out,
    });
    const result = (await (tool as { execute: (id: string, params: unknown) => Promise<unknown> }).execute("t1", {
      prompt: "a tidy diagram",
      count: 2,
    })) as {
      content: { text: string }[];
      details: { images: { path: string; mediaType: string }[] };
    };
    const paths = result.details.images.map((image) => image.path);
    assert.equal(paths.length, 2, "count honored");
    for (const path of paths) {
      assert.ok(existsSync(path), `file written: ${path}`);
      assert.match(path, /\.png$/, "mediaType-derived extension");
      assert.ok(!path.includes(process.env.HOME ?? "/Users"), "under output root");
    }
    assert.equal(result.content[0]?.text, paths.join("\n"), "paths on the wire");
    assert.ok(
      !JSON.stringify(result).includes(Buffer.from("fake").toString("base64")),
      "no inline image data"
    );
    const listing = result.details.images;
    assert.equal(listing[0]?.mediaType, "image/png");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("tool: typed errors — unsupported size, provider failure, missing auth", async () => {
  const out = mkdtempSync(join(tmpdir(), "ptb-img-err-"));
  try {
    const exec = async (
      providerId: string,
      params: Record<string, unknown>
    ) => {
      const tool = buildGenerateImageTool({ providerId, outputRoot: out });
      return (await (tool as { execute: (id: string, params: unknown) => Promise<unknown> }).execute("t", params)) as {
        details: { error: string };
      };
    };
    const aspect = await exec("fake-a", { prompt: "x", aspect: "7:1" });
    assert.equal(aspect.details.error, "unsupported_size");
    const failure = await exec("fake-b", { prompt: "boom" });
    assert.equal(failure.details.error, "provider_failure");
    // grok-build without creds (auth cache disabled for determinism).
    const prevDisable = process.env.PI_GROK_BUILD_DISABLE_GROK_AUTH_CACHE;
    const prevKey = process.env.XAI_API_KEY;
    const prevKey2 = process.env.GROK_CODE_XAI_API_KEY;
    process.env.PI_GROK_BUILD_DISABLE_GROK_AUTH_CACHE = "1";
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;
    try {
      assert.equal(getXaiApiKey(process.env), undefined, "no creds path");
      const noAuth = await exec("grok-build", { prompt: "x" });
      assert.equal(noAuth.details.error, "missing_auth", "auth-gated, skipped");
    } finally {
      if (prevDisable !== undefined)
        process.env.PI_GROK_BUILD_DISABLE_GROK_AUTH_CACHE = prevDisable;
      else delete process.env.PI_GROK_BUILD_DISABLE_GROK_AUTH_CACHE;
      if (prevKey) process.env.XAI_API_KEY = prevKey;
      if (prevKey2) process.env.GROK_CODE_XAI_API_KEY = prevKey2;
    }
    assert.ok(GROK_ASPECTS.includes("16:9"), "provider-constrained aspects");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
