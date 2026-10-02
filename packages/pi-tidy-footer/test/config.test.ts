import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_PATH,
  DEFAULT_MOUNTS,
  DEFAULT_WARN_PERCENT,
  defaultConfigPath,
  loadResourceConfig,
} from "../config.js";

function withConfig(content: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-tidy-footer-config-"));
  const path = join(dir, "pi-tidy-footer.json");
  writeFileSync(path, content);
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config path honors the environment redirect", () => {
  const previous = process.env.PI_TIDY_FOOTER_CONFIG;
  try {
    delete process.env.PI_TIDY_FOOTER_CONFIG;
    assert.equal(defaultConfigPath(), CONFIG_PATH);
    assert.ok(
      CONFIG_PATH.endsWith(join(".pi", "agent", "pi-tidy-footer.json"))
    );
    process.env.PI_TIDY_FOOTER_CONFIG = "/tmp/elsewhere.json";
    assert.equal(defaultConfigPath(), "/tmp/elsewhere.json");
  } finally {
    if (previous === undefined) delete process.env.PI_TIDY_FOOTER_CONFIG;
    else process.env.PI_TIDY_FOOTER_CONFIG = previous;
  }
});

test("resources are off by default with default mounts and threshold", () => {
  assert.deepEqual(DEFAULT_MOUNTS, ["/", "/tmp"]);
  assert.equal(DEFAULT_WARN_PERCENT, 85);
  const expected = { enabled: false, mounts: ["/", "/tmp"], warnPercent: 85 };
  assert.deepEqual(loadResourceConfig("/nonexistent/footer.json"), expected);
  withConfig("{not json", (path) =>
    assert.deepEqual(loadResourceConfig(path), expected)
  );
  withConfig("[]", (path) =>
    assert.deepEqual(loadResourceConfig(path), expected)
  );
  withConfig('{"resources": true}', (path) =>
    assert.deepEqual(loadResourceConfig(path), expected)
  );
  withConfig('{"resources": {"enabled": "yes"}}', (path) =>
    assert.deepEqual(loadResourceConfig(path), expected)
  );
});

test("explicit resource config is applied and invalid fields fall back", () => {
  withConfig(
    JSON.stringify({
      resources: { enabled: true, mounts: ["/data", "", 3], warnPercent: 90 },
    }),
    (path) =>
      assert.deepEqual(loadResourceConfig(path), {
        enabled: true,
        mounts: ["/data"],
        warnPercent: 90,
      })
  );
  withConfig(
    JSON.stringify({
      resources: { enabled: true, mounts: [], warnPercent: 100 },
    }),
    (path) =>
      assert.deepEqual(loadResourceConfig(path), {
        enabled: true,
        mounts: ["/", "/tmp"],
        warnPercent: 100,
      })
  );
  for (const warnPercent of [0, -5, 101, "90", null]) {
    withConfig(
      JSON.stringify({
        resources: { enabled: true, mounts: "/", warnPercent },
      }),
      (path) =>
        assert.deepEqual(loadResourceConfig(path), {
          enabled: true,
          mounts: ["/", "/tmp"],
          warnPercent: 85,
        })
    );
  }
});
