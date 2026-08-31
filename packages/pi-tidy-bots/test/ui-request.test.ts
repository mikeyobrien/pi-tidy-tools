import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoUiAnswer,
  describeUiAnswer,
  isFireAndForgetUiMethod,
  isInteractiveUiMethod,
  uiResponseFrame,
} from "../src/rpc.ts";

test("interactive UI methods need an answer; notify and status do not", () => {
  for (const method of ["select", "confirm", "input", "editor"])
    assert.equal(isInteractiveUiMethod(method), true);
  for (const method of [
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
    "",
  ])
    assert.equal(isInteractiveUiMethod(method), false);
});

test("fire-and-forget UI methods are known and never await an answer", () => {
  for (const method of [
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
  ])
    assert.equal(isFireAndForgetUiMethod(method), true);
  for (const method of [
    "select",
    "confirm",
    "input",
    "editor",
    "future_modal",
    "",
  ])
    assert.equal(isFireAndForgetUiMethod(method), false);
});

test("uiResponseFrame selects the exact wire shape per answer kind", () => {
  assert.deepEqual(uiResponseFrame("id-1", { value: "B" }), {
    type: "extension_ui_response",
    id: "id-1",
    value: "B",
  });
  assert.deepEqual(uiResponseFrame("id-2", { confirmed: false }), {
    type: "extension_ui_response",
    id: "id-2",
    confirmed: false,
  });
  assert.deepEqual(uiResponseFrame("id-3", { cancel: true }), {
    type: "extension_ui_response",
    id: "id-3",
    cancelled: true,
  });
  // Empty answer degrades to an empty value, never a malformed frame.
  assert.deepEqual(uiResponseFrame("id-4", {}), {
    type: "extension_ui_response",
    id: "id-4",
    value: "",
  });
});

test("autoUiAnswer never wedges: every method gets a deterministic answer", () => {
  assert.deepEqual(autoUiAnswer("select", ["A", "B"]), { value: "A" });
  assert.deepEqual(autoUiAnswer("select"), { value: "" });
  assert.deepEqual(autoUiAnswer("confirm"), { confirmed: true });
  assert.deepEqual(autoUiAnswer("input"), { value: "" });
  assert.deepEqual(autoUiAnswer("editor"), { cancel: true });
  assert.deepEqual(autoUiAnswer("unknown"), { cancel: true });
});

test("describeUiAnswer renders human resolutions per method", () => {
  assert.equal(describeUiAnswer("select", { value: "B" }), "B");
  assert.equal(describeUiAnswer("input", { value: "hello" }), "hello");
  assert.equal(describeUiAnswer("confirm", { confirmed: true }), "confirmed");
  assert.equal(describeUiAnswer("confirm", { confirmed: false }), "declined");
  assert.equal(describeUiAnswer("editor", { cancel: true }), "cancelled");
  assert.equal(describeUiAnswer("select", { value: "" }), "");
});
