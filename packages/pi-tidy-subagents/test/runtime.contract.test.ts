import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBatchRuntime,
  resolveTaskSelection,
  RuntimeResolutionError,
  wrapPiRegistry,
  type ModelAuthRegistry,
  type RoutingConfig,
  type ThinkingCapableModel,
} from "../index.js";
import { formatDiagnostics, parseExactModelRef } from "../runtime.js";

type Entry = ThinkingCapableModel & { auth?: boolean };

function registry(entries: Entry[]): ModelAuthRegistry {
  const models = new Map(
    entries.map((entry) => [`${entry.provider}\0${entry.id}`, entry])
  );
  return {
    find(provider, modelId) {
      return models.get(`${provider}\0${modelId}`);
    },
    hasConfiguredAuth(model) {
      return models.get(`${model.provider}\0${model.id}`)?.auth !== false;
    },
  };
}

const parent = {
  provider: "parent",
  modelId: "base/model",
  thinking: "medium",
};
const ordinary: Entry = {
  provider: "parent",
  id: "base/model",
  reasoning: true,
};
const selected: Entry = {
  provider: "other",
  id: "nested/model",
  reasoning: true,
};

function resolutionError(run: () => unknown): RuntimeResolutionError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof RuntimeResolutionError);
    return error;
  }
  assert.fail("expected RuntimeResolutionError");
}

test("parseExactModelRef trims both identities and splits only the first slash", () => {
  assert.deepEqual(parseExactModelRef("  provider / model/variant  "), {
    provider: "provider",
    modelId: "model/variant",
  });
  assert.deepEqual(parseExactModelRef("p/m"), { provider: "p", modelId: "m" });
  for (const invalid of [
    "",
    "   ",
    "bare",
    "/model",
    " /model",
    "provider/",
    "provider/   ",
  ]) {
    assert.equal(
      parseExactModelRef(invalid),
      undefined,
      JSON.stringify(invalid)
    );
  }
});

test("formatDiagnostics includes only supplied request fields in stable child order", () => {
  const diagnostics = [
    { index: 0, label: "agent", message: "first" },
    {
      index: 2,
      label: 'quoted "label"',
      requestedModel: "p/m",
      message: "second",
    },
    { index: 3, label: "thinker", requestedThinking: "high", message: "third" },
    {
      index: 4,
      label: "both",
      requestedModel: "x/y",
      requestedThinking: "low",
      message: "fourth",
    },
  ];
  assert.equal(
    formatDiagnostics(diagnostics),
    [
      'child[0] label="agent": first',
      'child[2] label="quoted \\"label\\"" model="p/m": second',
      'child[3] label="thinker" thinking="high": third',
      'child[4] label="both" model="x/y" thinking="low": fourth',
    ].join("\n")
  );
  const error = new RuntimeResolutionError(diagnostics);
  assert.equal(error.name, "RuntimeResolutionError");
  assert.equal(error.message, formatDiagnostics(diagnostics));
  assert.equal(error.diagnostics, diagnostics);
});

test("wrapPiRegistry normalizes nullable finds and preserves capabilities", () => {
  const calls: unknown[][] = [];
  const map = { off: null, low: "low" } as any;
  const wrapped = wrapPiRegistry({
    find(provider, modelId) {
      calls.push(["find", provider, modelId]);
      if (modelId === "missing") return null;
      if (modelId === "stub") return { provider, id: modelId };
      return { provider, id: modelId, reasoning: false, thinkingLevelMap: map };
    },
    hasConfiguredAuth(model) {
      calls.push(["auth", model]);
      return model.id === "stub";
    },
  });
  assert.equal(wrapped.find("p", "missing"), undefined);
  assert.deepEqual(wrapped.find("p", "stub"), {
    provider: "p",
    id: "stub",
    reasoning: true,
    thinkingLevelMap: undefined,
  });
  assert.deepEqual(wrapped.find("p", "full"), {
    provider: "p",
    id: "full",
    reasoning: false,
    thinkingLevelMap: map,
  });
  const identity = { provider: "p", id: "stub" };
  assert.equal(wrapped.hasConfiguredAuth(identity), true);
  assert.deepEqual(calls, [
    ["find", "p", "missing"],
    ["find", "p", "stub"],
    ["find", "p", "full"],
    ["auth", identity],
  ]);
});

test("inherited runtime remains exact without a capability registry", () => {
  assert.deepEqual(
    resolveBatchRuntime(
      [{ label: "first" }, {}, { model: "", thinking: "" }],
      parent,
      undefined
    ),
    [
      {
        provider: "parent",
        modelId: "base/model",
        model: "parent/base/model",
        thinking: "medium",
        provenance: "parent",
        thinkingProvenance: "parent",
        resolvedThinking: "medium",
      },
      {
        provider: "parent",
        modelId: "base/model",
        model: "parent/base/model",
        thinking: "medium",
        provenance: "parent",
        thinkingProvenance: "parent",
        resolvedThinking: "medium",
      },
      {
        provider: "parent",
        modelId: "base/model",
        model: "parent/base/model",
        thinking: "medium",
        provenance: "parent",
        thinkingProvenance: "parent",
        resolvedThinking: "medium",
      },
    ]
  );
  assert.deepEqual(resolveBatchRuntime([], parent, undefined), []);
});

test("explicit exact model records request provenance and nested model identity", () => {
  const plans = resolveBatchRuntime(
    [{ label: "chosen", model: "other/nested/model", thinking: "high" }],
    parent,
    registry([ordinary, selected])
  );
  assert.deepEqual(plans, [
    {
      provider: "other",
      modelId: "nested/model",
      model: "other/nested/model",
      thinking: "high",
      provenance: "request",
      requestedModel: "other/nested/model",
      thinkingProvenance: "request",
      requestedThinking: "high",
      resolvedThinking: "high",
    },
  ]);
});

test("thinking-only request looks up inherited model capabilities", () => {
  const finds: string[] = [];
  const reg: ModelAuthRegistry = {
    find(provider, modelId) {
      finds.push(`${provider}/${modelId}`);
      return ordinary;
    },
    hasConfiguredAuth() {
      throw new Error("auth is only for explicit models");
    },
  };
  assert.deepEqual(resolveBatchRuntime([{ thinking: "low" }], parent, reg), [
    {
      provider: "parent",
      modelId: "base/model",
      model: "parent/base/model",
      thinking: "low",
      provenance: "parent",
      thinkingProvenance: "request",
      requestedThinking: "low",
      resolvedThinking: "low",
    },
  ]);
  assert.deepEqual(finds, ["parent/base/model"]);
});

test("thinking-only request retries a temporarily unavailable inherited capability", () => {
  let calls = 0;
  const reg: ModelAuthRegistry = {
    find() {
      calls++;
      return calls === 1 ? undefined : ordinary;
    },
    hasConfiguredAuth() {
      return true;
    },
  };
  assert.equal(
    resolveBatchRuntime([{ thinking: "high" }], parent, reg)[0]!
      .resolvedThinking,
    "high"
  );
  assert.equal(calls, 2);

  const absent: ModelAuthRegistry = {
    find: () => undefined,
    hasConfiguredAuth: () => true,
  };
  const error = resolutionError(() =>
    resolveBatchRuntime([{ thinking: "minimal" }], parent, absent)
  );
  assert.deepEqual(error.diagnostics, [
    {
      index: 0,
      label: "agent",
      requestedModel: undefined,
      requestedThinking: "minimal",
      message:
        "model capability surface is unavailable; cannot validate explicit thinking selection",
    },
  ]);
});

test("inherited thinking uses canonical clamps and precise adjustment reasons", () => {
  const nonReasoning: Entry = {
    provider: "other",
    id: "plain",
    reasoning: false,
  };
  const alwaysThinking: Entry = {
    provider: "other",
    id: "always",
    reasoning: true,
    thinkingLevelMap: { off: null },
  };
  assert.deepEqual(
    resolveBatchRuntime(
      [{ model: "other/plain" }],
      parent,
      registry([nonReasoning])
    ),
    [
      {
        provider: "other",
        modelId: "plain",
        model: "other/plain",
        thinking: "off",
        provenance: "request",
        requestedModel: "other/plain",
        thinkingProvenance: "parent",
        resolvedThinking: "off",
        thinkingAdjustment: {
          from: "medium",
          to: "off",
          reason: "non-reasoning",
        },
      },
    ]
  );
  assert.deepEqual(
    resolveBatchRuntime(
      [{ model: "other/always" }],
      { ...parent, thinking: "off" },
      registry([alwaysThinking])
    ),
    [
      {
        provider: "other",
        modelId: "always",
        model: "other/always",
        thinking: "minimal",
        provenance: "request",
        requestedModel: "other/always",
        thinkingProvenance: "parent",
        resolvedThinking: "minimal",
        thinkingAdjustment: {
          from: "off",
          to: "minimal",
          reason: "inherited-clamp",
        },
      },
    ]
  );
});

test("invalid inherited parent thinking falls back to off only with capabilities", () => {
  assert.deepEqual(
    resolveBatchRuntime([{}], { ...parent, thinking: "turbo" }, undefined)[0],
    {
      provider: "parent",
      modelId: "base/model",
      model: "parent/base/model",
      thinking: "turbo",
      provenance: "parent",
      thinkingProvenance: "parent",
      resolvedThinking: "turbo",
    }
  );
  assert.deepEqual(
    resolveBatchRuntime(
      [{}],
      { ...parent, thinking: "turbo" },
      registry([ordinary])
    )[0],
    {
      provider: "parent",
      modelId: "base/model",
      model: "parent/base/model",
      thinking: "off",
      provenance: "parent",
      thinkingProvenance: "parent",
      resolvedThinking: "off",
      thinkingAdjustment: {
        from: "turbo",
        to: "off",
        reason: "inherited-clamp",
      },
    }
  );
});

test("invalid model value and every exact-reference failure have precise diagnostics", () => {
  const cases: Array<[unknown, string]> = [
    [42, "model must be an exact provider/model-id string"],
    [
      "alias",
      "model must be an exact registered provider/model-id (parsed at the first '/'; fuzzy patterns, aliases, and profiles are rejected)",
    ],
    [
      "/missing",
      "model must be an exact registered provider/model-id (parsed at the first '/'; fuzzy patterns, aliases, and profiles are rejected)",
    ],
  ];
  for (const [model, message] of cases) {
    const error = resolutionError(() =>
      resolveBatchRuntime(
        [{ label: "bad", model: model as string, thinking: "high" }],
        parent,
        registry([ordinary])
      )
    );
    assert.deepEqual(error.diagnostics, [
      {
        index: 0,
        label: "bad",
        requestedModel: String(model),
        requestedThinking: "high",
        message,
      },
    ]);
  }
  const unavailable = resolutionError(() =>
    resolveBatchRuntime(
      [{ model: "other/nested/model", thinking: "low" }],
      parent,
      undefined
    )
  );
  assert.deepEqual(unavailable.diagnostics, [
    {
      index: 0,
      label: "agent",
      requestedModel: "other/nested/model",
      requestedThinking: "low",
      message:
        "model registry is unavailable; cannot validate explicit model selection",
    },
  ]);
});

test("unknown, remapped, and unauthenticated models are rejected independently", () => {
  const unknown = resolutionError(() =>
    resolveBatchRuntime(
      [{ label: "u", model: "other/missing" }],
      parent,
      registry([])
    )
  );
  assert.deepEqual(unknown.diagnostics, [
    {
      index: 0,
      label: "u",
      requestedModel: "other/missing",
      requestedThinking: undefined,
      message: 'unknown model "other/missing"; exact registry match required',
    },
  ]);

  for (const found of [
    { provider: "alias", id: "nested/model", reasoning: true },
    { provider: "other", id: "different", reasoning: true },
  ]) {
    const reg: ModelAuthRegistry = {
      find: () => found,
      hasConfiguredAuth: () => true,
    };
    const error = resolutionError(() =>
      resolveBatchRuntime([{ model: "other/nested/model" }], parent, reg)
    );
    assert.equal(
      error.diagnostics[0]!.message,
      'model "other/nested/model" is not an exact registered identity'
    );
  }
  const unauthenticated = resolutionError(() =>
    resolveBatchRuntime(
      [{ label: "locked", model: "other/nested/model", thinking: "minimal" }],
      parent,
      registry([{ ...selected, auth: false }])
    )
  );
  assert.deepEqual(unauthenticated.diagnostics, [
    {
      index: 0,
      label: "locked",
      requestedModel: "other/nested/model",
      requestedThinking: "minimal",
      message: 'model "other/nested/model" has no configured authentication',
    },
  ]);
});

test("explicit thinking validates vocabulary, capability presence, and support", () => {
  const invalid = resolutionError(() =>
    resolveBatchRuntime(
      [{ label: "vocab", thinking: 7 as any }],
      parent,
      registry([ordinary])
    )
  );
  assert.deepEqual(invalid.diagnostics, [
    {
      index: 0,
      label: "vocab",
      requestedModel: undefined,
      requestedThinking: "7",
      message:
        "thinking must be one of Pi's native levels: off, minimal, low, medium, high, xhigh, max",
    },
  ]);

  const unavailable = resolutionError(() =>
    resolveBatchRuntime([{ thinking: "high" }], parent, undefined)
  );
  assert.deepEqual(unavailable.diagnostics, [
    {
      index: 0,
      label: "agent",
      requestedModel: undefined,
      requestedThinking: "high",
      message:
        "model capability surface is unavailable; cannot validate explicit thinking selection",
    },
  ]);

  const nonReasoning: Entry = {
    provider: "other",
    id: "plain",
    reasoning: false,
  };
  const unsupported = resolutionError(() =>
    resolveBatchRuntime(
      [{ label: "think", model: "other/plain", thinking: "high" }],
      parent,
      registry([nonReasoning])
    )
  );
  assert.deepEqual(unsupported.diagnostics, [
    {
      index: 0,
      label: "think",
      requestedModel: "other/plain",
      requestedThinking: "high",
      message:
        'thinking "high" is not supported by "other/plain"; supported: off',
    },
  ]);

  const inheritedUnsupported = resolutionError(() =>
    resolveBatchRuntime(
      [{ label: "inherited-model", thinking: "high" }],
      { provider: "other", modelId: "plain", thinking: "medium" },
      registry([nonReasoning])
    )
  );
  assert.equal(
    inheritedUnsupported.diagnostics[0]!.message,
    'thinking "high" is not supported by "other/plain"; supported: off'
  );
  assert.equal(
    inheritedUnsupported.diagnostics[0]!.requestedModel,
    "other/plain"
  );

  const noLevels: Entry = {
    provider: "other",
    id: "none",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    },
  };
  const emptyAlternatives = resolutionError(() =>
    resolveBatchRuntime(
      [{ model: "other/none", thinking: "low" }],
      parent,
      registry([noLevels])
    )
  );
  assert.equal(
    emptyAlternatives.diagnostics[0]!.message,
    'thinking "low" is not supported by "other/none"; supported: (none)'
  );
});

test("batch errors aggregate all offenders atomically and discard valid plans", () => {
  const error = resolutionError(() =>
    resolveBatchRuntime(
      [
        { label: "valid", model: "other/nested/model", thinking: "low" },
        { label: "missing", model: "other/nope" },
        { thinking: "turbo" as any },
      ],
      parent,
      registry([ordinary, selected])
    )
  );
  assert.equal(error.diagnostics.length, 2);
  assert.deepEqual(
    error.diagnostics.map((item) => [item.index, item.label]),
    [
      [1, "missing"],
      [2, "agent"],
    ]
  );
  assert.equal(
    error.message,
    [
      'child[1] label="missing" model="other/nope": unknown model "other/nope"; exact registry match required',
      'child[2] label="agent" thinking="turbo": thinking must be one of Pi\'s native levels: off, minimal, low, medium, high, xhigh, max',
    ].join("\n")
  );
});

test("resolveTaskSelection applies field-wise entry precedence without inventing fields", () => {
  const config: RoutingConfig = {
    version: 1,
    defaults: { model: "default/model", thinking: "low" },
    taskClasses: {
      modelOnly: { model: "task/model" },
      thinkingOnly: { thinking: "high" },
      both: { model: "task/both", thinking: "minimal" },
      empty: {},
    },
  };
  assert.deepEqual(resolveTaskSelection(undefined, "both"), {});
  assert.deepEqual(resolveTaskSelection(config, "missing"), {
    model: "default/model",
    thinking: "low",
  });
  assert.deepEqual(resolveTaskSelection(config, "modelOnly"), {
    model: "task/model",
    thinking: "low",
  });
  assert.deepEqual(resolveTaskSelection(config, "thinkingOnly"), {
    model: "default/model",
    thinking: "high",
  });
  assert.deepEqual(resolveTaskSelection(config, "both"), {
    model: "task/both",
    thinking: "minimal",
  });
  assert.deepEqual(resolveTaskSelection(config, "empty"), {
    model: "default/model",
    thinking: "low",
  });
  assert.deepEqual(
    resolveTaskSelection({ version: 1, taskClasses: {} }, "missing"),
    {}
  );
});
