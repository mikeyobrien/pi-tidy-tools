import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadTidyMode,
  loadTidyState,
  parseEnabled,
  saveTidyEnabled,
  saveTidyMode,
} from "../config.js";

async function withTempConfig(
  run: (configPath: string, root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-tidy-tools-"));
  try {
    await run(join(root, "config.json"), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("parseEnabled accepts every documented boolean form", () => {
  for (const value of [true, "1", "true", "on", "yes"]) {
    assert.equal(
      parseEnabled(value),
      true,
      `${JSON.stringify(value)} should enable`
    );
  }
  for (const value of [false, "0", "false", "off", "no"]) {
    assert.equal(
      parseEnabled(value),
      false,
      `${JSON.stringify(value)} should disable`
    );
  }
});

test("parseEnabled normalizes string case and surrounding whitespace", () => {
  assert.equal(parseEnabled("  YeS\t"), true);
  assert.equal(parseEnabled("\nOFF  "), false);
});

test("parseEnabled rejects unknown strings and every non-boolean type", () => {
  for (const value of ["", "maybe", "2", 1, 0, null, undefined, {}, []]) {
    assert.equal(
      parseEnabled(value),
      undefined,
      `${JSON.stringify(value)} should not override config`
    );
  }
});

test("missing config defaults to enabled", () => {
  const state = loadTidyState({
    envValue: "",
    configPath: join(tmpdir(), `missing-tidy-${process.pid}.json`),
  });
  assert.deepEqual(state, { enabled: true, source: "default" });
});

test("file booleans are loaded with file provenance", async () => {
  await withTempConfig(async (configPath) => {
    for (const enabled of [true, false]) {
      await writeFile(configPath, JSON.stringify({ enabled }));
      assert.deepEqual(loadTidyState({ envValue: "", configPath }), {
        enabled,
        source: "file",
      });
    }
  });
});

test("only a boolean enabled property is a valid file setting", async () => {
  await withTempConfig(async (configPath) => {
    for (const contents of [
      JSON.stringify({}),
      JSON.stringify({ enabled: "false" }),
      JSON.stringify({ enabled: 0 }),
      JSON.stringify({ enabled: null }),
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify([false]),
      "not json",
    ]) {
      await writeFile(configPath, contents);
      assert.deepEqual(
        loadTidyState({ envValue: "", configPath }),
        { enabled: true, source: "default" },
        contents
      );
    }
  });
});

test("a valid environment setting takes precedence over either file value", async () => {
  await withTempConfig(async (configPath) => {
    for (const [fileEnabled, envValue, expected] of [
      [false, "on", true],
      [true, "0", false],
    ] as const) {
      await writeFile(configPath, JSON.stringify({ enabled: fileEnabled }));
      assert.deepEqual(loadTidyState({ envValue, configPath }), {
        enabled: expected,
        source: "environment",
      });
    }
  });
});

test("an invalid environment setting falls through to file then default", async () => {
  await withTempConfig(async (configPath) => {
    await writeFile(configPath, JSON.stringify({ enabled: false }));
    assert.deepEqual(loadTidyState({ envValue: "invalid", configPath }), {
      enabled: false,
      source: "file",
    });
    await writeFile(configPath, "malformed");
    assert.deepEqual(loadTidyState({ envValue: "invalid", configPath }), {
      enabled: true,
      source: "default",
    });
  });
});

test("loadTidyMode accepts only the two non-default persisted modes", async () => {
  await withTempConfig(async (configPath) => {
    for (const mode of ["reasoning", "result"] as const) {
      await writeFile(configPath, JSON.stringify({ mode }));
      assert.equal(loadTidyMode(configPath), mode);
    }
  });
});

test("loadTidyMode defaults for missing, malformed, default, and wrong-type values", async () => {
  await withTempConfig(async (configPath) => {
    assert.equal(loadTidyMode(configPath), "default");
    for (const contents of [
      "not json",
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify({}),
      JSON.stringify({ mode: "default" }),
      JSON.stringify({ mode: "Reasoning" }),
      JSON.stringify({ mode: true }),
    ]) {
      await writeFile(configPath, contents);
      assert.equal(loadTidyMode(configPath), "default", contents);
    }
  });
});

test("persistent config creates parent directories and writes exact JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tidy-tools-"));
  const configPath = join(root, ".pi", "agent", "pi-tidy-tools.json");
  try {
    await saveTidyEnabled(false, configPath);
    assert.deepEqual(loadTidyState({ envValue: "", configPath }), {
      enabled: false,
      source: "file",
    });
    assert.equal(
      await readFile(configPath, "utf8"),
      '{\n  "enabled": false\n}\n'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saves preserve sibling settings while replacing owned values exactly", async () => {
  await withTempConfig(async (configPath) => {
    await writeFile(
      configPath,
      JSON.stringify({
        sibling: { nested: [1, "two"] },
        enabled: true,
        mode: "reasoning",
      })
    );
    await saveTidyEnabled(false, configPath);
    await saveTidyMode("result", configPath);
    assert.equal(loadTidyMode(configPath), "result");
    assert.equal(
      await readFile(configPath, "utf8"),
      '{\n  "sibling": {\n    "nested": [\n      1,\n      "two"\n    ]\n  },\n  "enabled": false,\n  "mode": "result"\n}\n'
    );
  });
});

test("object, array, primitive, and malformed configs are handled safely when saving", async () => {
  await withTempConfig(async (configPath) => {
    const cases = [
      [
        JSON.stringify({ sibling: "kept" }),
        '{\n  "sibling": "kept",\n  "enabled": true\n}\n',
      ],
      [JSON.stringify(["discarded"]), '{\n  "enabled": true\n}\n'],
      [JSON.stringify("discarded"), '{\n  "enabled": true\n}\n'],
      [JSON.stringify(7), '{\n  "enabled": true\n}\n'],
      [JSON.stringify(null), '{\n  "enabled": true\n}\n'],
      ["malformed", '{\n  "enabled": true\n}\n'],
    ] as const;
    for (const [contents, expected] of cases) {
      await writeFile(configPath, contents);
      await saveTidyEnabled(true, configPath);
      assert.equal(await readFile(configPath, "utf8"), expected, contents);
    }
  });
});

test("a failed atomic rename rejects and removes its temporary file", async () => {
  await withTempConfig(async (configPath, root) => {
    await mkdir(configPath);
    const originalNow = Date.now;
    Date.now = () => 1_234_567_890;
    try {
      await assert.rejects(saveTidyEnabled(false, configPath));
      assert.deepEqual(await readdir(root), ["config.json"]);
    } finally {
      Date.now = originalNow;
    }
  });
});
