import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildDefaultRoutingConfig,
  clearRoutingConfig,
  defaultThinkingForTask,
  formatRoutingGuidance,
  listAuthenticatedModels,
  loadRoutingConfig,
  resolveTaskSelection,
  ROUTING_CONFIG_VERSION,
  routingConfigPath,
  saveRoutingConfig,
  STANDARD_TASK_CLASSES,
  type RoutingConfig,
} from "../index.js";

async function withAgentDir<T>(
  run: (agentDir: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "tidy-subagents-config-"));
  try {
    return await run(join(root, "agent"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeRouting(agentDir: string, value: unknown): Promise<void> {
  const path = routingConfigPath(agentDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value)
  );
}

test("routing constants, path, classes, and thinking defaults are exact", () => {
  assert.equal(ROUTING_CONFIG_VERSION, 1);
  assert.equal(
    routingConfigPath("/agent-root"),
    join("/agent-root", "pi-tidy-subagents", "routing.json")
  );
  assert.deepEqual(STANDARD_TASK_CLASSES, [
    "bounded-lookup",
    "mechanical-implementation",
    "ordinary-review",
    "architectural-judgment",
    "concurrency-analysis",
    "cost-sensitive",
    "similarly-named-models",
    "cross-provider",
  ]);
  assert.deepEqual(
    Object.fromEntries(
      [...STANDARD_TASK_CLASSES, "project-specific"].map((taskClass) => [
        taskClass,
        defaultThinkingForTask(taskClass),
      ])
    ),
    {
      "bounded-lookup": "minimal",
      "mechanical-implementation": "low",
      "ordinary-review": "medium",
      "architectural-judgment": "high",
      "concurrency-analysis": "high",
      "cost-sensitive": "minimal",
      "similarly-named-models": undefined,
      "cross-provider": undefined,
      "project-specific": undefined,
    }
  );
});

test("default routing config contains every and only applicable class", () => {
  assert.deepEqual(buildDefaultRoutingConfig(), {
    version: 1,
    taskClasses: {
      "bounded-lookup": { thinking: "minimal" },
      "mechanical-implementation": { thinking: "low" },
      "ordinary-review": { thinking: "medium" },
      "architectural-judgment": { thinking: "high" },
      "concurrency-analysis": { thinking: "high" },
      "cost-sensitive": { thinking: "minimal" },
    },
  });
  assert.deepEqual(
    buildDefaultRoutingConfig({
      "bounded-lookup": "",
      "ordinary-review": "Stryker was here!",
      "similarly-named-models": "provider/similar",
      "cross-provider": "provider/cross",
      unknown: "provider/ignored",
    }),
    {
      version: 1,
      taskClasses: {
        "bounded-lookup": { thinking: "minimal" },
        "mechanical-implementation": { thinking: "low" },
        "ordinary-review": { thinking: "medium", model: "Stryker was here!" },
        "architectural-judgment": { thinking: "high" },
        "concurrency-analysis": { thinking: "high" },
        "cost-sensitive": { thinking: "minimal" },
        "similarly-named-models": { model: "provider/similar" },
        "cross-provider": { model: "provider/cross" },
      },
    }
  );
});

test("loading rejects malformed documents and unsupported versions", async () =>
  withAgentDir(async (agentDir) => {
    assert.equal(loadRoutingConfig(agentDir), undefined);
    for (const malformed of ["{", "null", "[]", "true", "1", '"text"']) {
      await writeRouting(agentDir, malformed);
      assert.equal(loadRoutingConfig(agentDir), undefined, malformed);
    }
    for (const malformed of [
      {},
      { version: 0, taskClasses: {} },
      { version: 2, taskClasses: {} },
      { version: "1", taskClasses: {} },
    ]) {
      await writeRouting(agentDir, malformed);
      assert.equal(
        loadRoutingConfig(agentDir),
        undefined,
        JSON.stringify(malformed)
      );
    }
  }));

test("loading parses valid selections and ignores malformed nested shapes", async () =>
  withAgentDir(async (agentDir) => {
    await writeRouting(agentDir, {
      version: 1,
      defaults: { model: "  provider/default  ", thinking: "low", extra: true },
      taskClasses: {
        missing: null,
        array: [],
        scalar: "provider/model",
        empty: {},
        malformed: { model: 42, thinking: "turbo" },
        model: { model: "  provider/model  ", thinking: null },
        thinking: { model: "   ", thinking: "high" },
        both: { model: "provider/both", thinking: "minimal", extra: "ignored" },
      },
    });
    assert.deepEqual(loadRoutingConfig(agentDir), {
      version: 1,
      defaults: { model: "provider/default", thinking: "low" },
      taskClasses: {
        empty: {},
        malformed: {},
        model: { model: "provider/model" },
        thinking: { thinking: "high" },
        both: { model: "provider/both", thinking: "minimal" },
      },
    });

    for (const nested of [
      { version: 1 },
      { version: 1, taskClasses: null, defaults: null },
      { version: 1, taskClasses: [], defaults: [] },
      { version: 1, taskClasses: "bad", defaults: {} },
      {
        version: 1,
        taskClasses: {},
        defaults: { model: " ", thinking: "invalid" },
      },
    ]) {
      await writeRouting(agentDir, nested);
      assert.deepEqual(loadRoutingConfig(agentDir), {
        version: 1,
        taskClasses: {},
      });
    }
  }));

test("save writes normalized JSON atomically without temporary files", async () =>
  withAgentDir(async (agentDir) => {
    const path = await saveRoutingConfig(
      {
        version: 1,
        defaults: { thinking: "medium", model: "provider/default" },
        taskClasses: { custom: { model: "provider/custom", thinking: "high" } },
      },
      agentDir
    );
    assert.equal(path, routingConfigPath(agentDir));
    assert.equal(
      await readFile(path, "utf8"),
      `${JSON.stringify(
        {
          version: 1,
          defaults: { thinking: "medium", model: "provider/default" },
          taskClasses: {
            custom: { model: "provider/custom", thinking: "high" },
          },
        },
        null,
        2
      )}\n`
    );
    assert.deepEqual(await readdir(dirname(path)), ["routing.json"]);

    await saveRoutingConfig(
      {
        version: 1,
        defaults: {},
        taskClasses: undefined,
      } as unknown as RoutingConfig,
      agentDir
    );
    assert.equal(
      await readFile(path, "utf8"),
      `${JSON.stringify({ version: 1, taskClasses: {} }, null, 2)}\n`
    );
    assert.deepEqual(await readdir(dirname(path)), ["routing.json"]);
  }));

test("atomic save removes its temporary file when replacement fails", async () =>
  withAgentDir(async (agentDir) => {
    const path = routingConfigPath(agentDir);
    await mkdir(path, { recursive: true });

    await assert.rejects(
      saveRoutingConfig({ version: 1, taskClasses: {} }, agentDir),
      (error: NodeJS.ErrnoException) =>
        error.code === "EISDIR" || error.code === "ENOTDIR"
    );
    assert.deepEqual(await readdir(dirname(path)), ["routing.json"]);
  }));

test("clear distinguishes removed, missing, and filesystem errors", async () =>
  withAgentDir(async (agentDir) => {
    await writeRouting(agentDir, { version: 1, taskClasses: {} });
    assert.equal(await clearRoutingConfig(agentDir), true);
    assert.equal(await clearRoutingConfig(agentDir), false);

    const path = routingConfigPath(agentDir);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "keep"), "occupied");
    await assert.rejects(clearRoutingConfig(agentDir));
    assert.deepEqual(await readdir(path), ["keep"]);
  }));

test("authenticated models prefer valid available entries and deduplicate refs", () => {
  assert.deepEqual(listAuthenticatedModels(undefined), []);
  assert.deepEqual(listAuthenticatedModels(null), []);
  assert.deepEqual(listAuthenticatedModels({}), []);

  const models = listAuthenticatedModels({
    getAvailable: () =>
      [
        null,
        { provider: "", id: "empty-provider" },
        { provider: "provider", id: "" },
        { provider: "provider", id: "first" },
        { provider: "provider", id: "first" },
        { provider: "other", id: "second" },
      ] as unknown as Array<{ provider: string; id: string }>,
    getAll: () => {
      throw new Error("available models must prevent fallback");
    },
  });
  assert.deepEqual(models, [
    { provider: "provider", id: "first", ref: "provider/first" },
    { provider: "other", id: "second", ref: "other/second" },
  ]);
});

test("authenticated model fallback validates shape and optional auth", () => {
  const unfiltered = listAuthenticatedModels({
    getAvailable: () => [],
    getAll: () =>
      [
        null,
        { provider: "", id: "missing-provider" },
        { provider: "provider", id: "" },
        { provider: "provider", id: "open" },
        { provider: "provider", id: "open" },
      ] as unknown as Array<{ provider: string; id: string }>,
  });
  assert.deepEqual(unfiltered, [
    { provider: "provider", id: "open", ref: "provider/open" },
  ]);

  const checked: string[] = [];
  const filtered = listAuthenticatedModels({
    getAll: () => [
      { provider: "provider", id: "allowed" },
      { provider: "provider", id: "blocked" },
    ],
    hasConfiguredAuth: (model) => {
      checked.push(model.id);
      return model.id === "allowed";
    },
  });
  assert.deepEqual(checked, ["allowed", "blocked"]);
  assert.deepEqual(filtered, [
    { provider: "provider", id: "allowed", ref: "provider/allowed" },
  ]);
});

test("routing guidance missing-map text is exact", () => {
  const expected = [
    "No agent-dir routing map yet. Run /tidy-subagents-routing to build a task→{thinking,model?} map from authenticated models (thinking-primary; model omit=inherit).",
  ];
  assert.deepEqual(formatRoutingGuidance(undefined), expected);
  assert.deepEqual(
    formatRoutingGuidance({ version: 1, taskClasses: {} }),
    expected
  );
});

test("routing guidance renders defaults and every selection form exactly", () => {
  const config: RoutingConfig = {
    version: 1,
    defaults: { thinking: "low" },
    taskClasses: {
      "bounded-lookup": { thinking: "minimal", model: "provider/fast" },
      "mechanical-implementation": { thinking: "low" },
      "ordinary-review": { model: "provider/reviewer" },
      "architectural-judgment": {},
      "project-lookup": { thinking: "high", model: "provider/custom" },
      "project-empty": {},
    },
  };
  assert.deepEqual(formatRoutingGuidance(config), [
    "User routing map (agent-dir pi-tidy-subagents/routing.json). Thinking is primary; model omit inherits parent. Exact provider/model-id only — no aliases/profiles/fuzzy.",
    "defaults: thinking=low",
    "bounded-lookup: thinking=minimal model=provider/fast",
    "mechanical-implementation: thinking=low model=inherit",
    "ordinary-review: model=provider/reviewer",
    "architectural-judgment: model=inherit",
    "project-lookup: thinking=high model=provider/custom",
    "project-empty: model=inherit",
  ]);

  assert.deepEqual(
    formatRoutingGuidance({
      version: 1,
      defaults: { model: "provider/default" },
      taskClasses: { "cross-provider": { model: "other/exact" } },
    }),
    [
      "User routing map (agent-dir pi-tidy-subagents/routing.json). Thinking is primary; model omit inherits parent. Exact provider/model-id only — no aliases/profiles/fuzzy.",
      "defaults: model=provider/default",
      "cross-provider: model=other/exact",
    ]
  );
});

test("task selection resolves absent values, defaults, and entry precedence", () => {
  assert.deepEqual(resolveTaskSelection(undefined, "anything"), {});
  assert.deepEqual(
    resolveTaskSelection({ version: 1, taskClasses: {} }, "anything"),
    {}
  );

  const config: RoutingConfig = {
    version: 1,
    defaults: { model: "provider/default", thinking: "low" },
    taskClasses: {
      model: { model: "provider/override" },
      thinking: { thinking: "high" },
      both: { model: "provider/both", thinking: "minimal" },
      empty: {},
    },
  };
  assert.deepEqual(resolveTaskSelection(config, "missing"), {
    model: "provider/default",
    thinking: "low",
  });
  assert.deepEqual(resolveTaskSelection(config, "model"), {
    model: "provider/override",
    thinking: "low",
  });
  assert.deepEqual(resolveTaskSelection(config, "thinking"), {
    model: "provider/default",
    thinking: "high",
  });
  assert.deepEqual(resolveTaskSelection(config, "both"), {
    model: "provider/both",
    thinking: "minimal",
  });
  assert.deepEqual(resolveTaskSelection(config, "empty"), {
    model: "provider/default",
    thinking: "low",
  });
});
