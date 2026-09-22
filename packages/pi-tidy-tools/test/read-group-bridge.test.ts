import assert from "node:assert/strict";
import test from "node:test";
import {
  installReadGroupBridge,
  type ReadGroupConstructor,
} from "../read-group-bridge.js";

function fakeGroup(): ReadGroupConstructor {
  return class {
    updateArgs() {}
    updateResult() {}
    renameEntry() {}
    removeEntry() {
      return false;
    }
    setExpanded() {}
    render() {
      return ["native Read"];
    }
  };
}

test("install is a no-op when the host has no read group", () => {
  assert.equal(
    installReadGroupBridge({ render: () => ["unused"] }, undefined),
    false
  );
});

test("a grouped filesystem read renders through the supplied tidy block", () => {
  const ctor = fakeGroup();
  assert.equal(
    installReadGroupBridge(
      {
        render: (snapshot) =>
          snapshot.entries.map(
            (entry) => `TIDY ${String(entry.args.path)} ${entry.settled ? "settled" : "running"}`
          ),
      },
      ctor
    ),
    true
  );
  const group = new ctor();
  group.updateArgs({ path: "/tmp/example.ts" }, "call-1");
  group.updateResult(
    { content: [{ type: "text", text: "one" }], isError: false },
    false,
    "call-1"
  );
  assert.deepEqual(group.render(80), ["TIDY /tmp/example.ts settled"]);
});
test("a hidden native group stays hidden", () => {
  const ctor = fakeGroup();
  ctor.prototype.render = () => [];
  installReadGroupBridge({ render: () => ["should-not-show"] }, ctor);
  const group = new ctor();
  group.updateArgs({ path: "/tmp/example.ts" }, "call-1");
  assert.deepEqual(group.render(80), []);
});
