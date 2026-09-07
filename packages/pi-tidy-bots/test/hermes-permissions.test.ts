import assert from "node:assert/strict";
import test from "node:test";
import {
  HermesPermissionRequest,
  hermesPermissionOptions,
} from "../backends/hermes/permissions.ts";
const options = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  {
    optionId: "allow_session",
    kind: "allow_always",
    name: "Allow for session",
  },
  { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
  { optionId: "deny", kind: "reject_once", name: "Deny" },
];
const identity = {
  bindingId: "binding",
  instanceId: "instance",
  operationId: "target",
  turnId: "turn",
  interactionId: "interaction",
  revision: "revision",
};
const deadline = Date.parse("2026-09-06T12:00:00Z");
function fixture() {
  const request = new HermesPermissionRequest(
    identity,
    options,
    deadline,
    "native-request-17"
  );
  const decision = {
    ...request.descriptor,
    operationId: "control",
    targetOperationId: "target",
    optionId: "allow_once",
  };
  return { request, decision };
}
test("Hermes options never promote session or persistent approval based on ACP kinds", () => {
  assert.deepEqual(
    hermesPermissionOptions(options).options.map((option) => option.id),
    ["allow_once", "deny"]
  );
  assert.deepEqual(
    hermesPermissionOptions([
      { optionId: "allow_session", kind: "allow_once", name: "Misleading" },
      options[3],
    ]).options.map((option) => option.id),
    ["deny"]
  );
  assert.throws(() => hermesPermissionOptions([options[0]]));
  assert.throws(() => hermesPermissionOptions([...options, options[3]]));
  assert.notEqual(
    hermesPermissionOptions(options).optionsDigest,
    hermesPermissionOptions(options.slice(1)).optionsDigest
  );
});
test("Hermes decision binds every exact descriptor fact and deadline", () => {
  for (const key of [
    "bindingId",
    "instanceId",
    "targetOperationId",
    "turnId",
    "interactionId",
    "revision",
    "optionsDigest",
    "expiresAt",
  ]) {
    const { request, decision } = fixture();
    assert.throws(
      () => request.decide({ ...decision, [key]: "changed" }, deadline - 1),
      { code: "stale_binding" }
    );
  }
  const { request, decision } = fixture();
  assert.throws(() => request.decide(decision, deadline), {
    code: "interaction_expired",
  });
  assert.throws(
    () =>
      fixture().request.decide(
        { ...decision, optionId: "allow_session" },
        deadline - 1
      ),
    { code: "invalid_payload" }
  );
  assert.throws(() => request.decide(decision, deadline - 1), {
    code: "interaction_expired",
  });
  assert.throws(
    () =>
      fixture().request.decide(
        { ...decision, operationId: "target" },
        deadline - 1
      ),
    { code: "invalid_payload" }
  );
});
test("Hermes dispatch selection is single-use and does not claim native application", () => {
  const { request, decision } = fixture();
  request.descriptor.instanceId = "mutated";
  assert.deepEqual(request.decide(decision, deadline - 1), {
    duplicate: false,
    response: {
      jsonrpc: "2.0",
      id: "native-request-17",
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    },
  });
  assert.deepEqual(request.decide(decision, deadline - 1), { duplicate: true });
  assert.throws(
    () => request.decide({ ...decision, optionId: "deny" }, deadline - 1),
    { code: "payload_conflict" }
  );
  request.close();
  assert.throws(() => request.decide(decision, deadline - 1), {
    code: "interaction_expired",
  });
});

test("a decision for an earlier native future cannot answer a later request with the same option IDs", () => {
  const previous = fixture();
  previous.request.close();
  const current = new HermesPermissionRequest(
    {
      ...identity,
      interactionId: "next-interaction",
      revision: "next-revision",
    },
    options,
    deadline,
    18
  );
  assert.throws(() => current.decide(previous.decision, deadline - 1), {
    code: "stale_binding",
  });
  const decision = {
    ...current.descriptor,
    operationId: "next-control",
    targetOperationId: "target",
    optionId: "deny",
  };
  assert.deepEqual(current.decide(decision, deadline - 1), {
    duplicate: false,
    response: {
      jsonrpc: "2.0",
      id: 18,
      result: { outcome: { outcome: "selected", optionId: "deny" } },
    },
  });
});
