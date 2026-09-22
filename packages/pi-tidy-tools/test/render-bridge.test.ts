import assert from "node:assert/strict";
import test from "node:test";
import {
  callRenderInfo,
  findTheme,
  resultRenderInfo,
  withBackground,
} from "../render-bridge.js";

const theme = {
  bg(name: string, text: string) {
    return `${name}:${text}`;
  },
};

test("Pi renderCall keeps the theme in the second slot and context in the third", () => {
  const info = callRenderInfo(
    { path: "a.ts", reasoning: "check the gate" },
    theme,
    { isPartial: true, toolCallId: "c1", invalidate() {} }
  );
  assert.equal(info.isPartial, true);
  assert.equal(info.toolCallId, "c1");
  assert.equal(info.args.path, "a.ts");
  assert.equal(findTheme(theme, { isPartial: true }), theme);
});

test("omp renderCall finds the theme in the third slot", () => {
  const info = callRenderInfo(
    { path: "a.ts" },
    { isPartial: true },
    theme
  );
  assert.equal(info.isPartial, true);
  assert.equal(findTheme({ isPartial: true }, theme), theme);
  assert.equal(withBackground(findTheme({ isPartial: true }, theme), "toolPendingBg", "x"), "toolPendingBg:x");
});

test("Pi renderResult reads args from the context and omp reads them from the fourth argument", () => {
  const pi = resultRenderInfo(
    { isError: false },
    { expanded: true },
    { args: { path: "from-context" }, isError: true, toolCallId: "p" }
  );
  assert.equal(pi.args.path, "from-context");
  assert.equal(pi.isError, true);
  assert.equal(pi.expanded, true);

  const omp = resultRenderInfo(
    { isError: true },
    { expanded: false },
    { path: "from-args", reasoning: "see the file" }
  );
  assert.equal(omp.args.path, "from-args");
  assert.equal(omp.isError, true);
  assert.equal(omp.expanded, false);
  assert.equal(omp.isPartial, false);
});

test("Pi renderResult accepts a context whose only marker is nested args", () => {
  const info = resultRenderInfo(
    { output: "one" },
    {},
    { args: { path: "a.ts", reasoning: "inspect source" }, isError: true }
  );
  assert.equal(info.args.path, "a.ts");
  assert.equal(info.isError, true);
});

test("a missing or throwing theme leaves the text unstyled", () => {
  assert.equal(withBackground(undefined, "toolErrorBg", "x"), "x");
  assert.equal(
    withBackground(
      {
        bg() {
          throw new Error("nope");
        },
      },
      "toolErrorBg",
      "x"
    ),
    "x"
  );
});
