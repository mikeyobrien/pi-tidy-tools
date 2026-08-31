import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import {
  TranscriptEntrySchema,
  RosterPayloadSchema,
  WsEventSchema,
  VersionResponseSchema,
  versionPayload,
} from "../src/contract.ts";

const compile = (schema: unknown) => Compile(schema as never);

test("transcript entry schema accepts a real-shaped entry and rejects junk", () => {
  const check = compile(TranscriptEntrySchema);
  assert.equal(
    check.Check({
      id: "id-1",
      role: "assistant",
      origin: "bot",
      originFrom: "forge",
      text: "All green.",
      ts: new Date().toISOString(),
      steps: [{ name: "bash", duration: 12.5 }],
    }),
    true
  );
  assert.equal(
    check.Check({
      id: "id-2",
      role: "user",
      origin: "operator",
      text: "hi",
      ts: new Date().toISOString(),
      delivering: false,
    }),
    true
  );
  assert.equal(check.Check({ id: "x", role: "robot", text: "" }), false);
});

test("roster and ws event schemas validate the daemon's payloads", () => {
  const roster = {
    type: "roster",
    bots: [
      {
        name: "forge",
        avatar: "🔨",
        online: true,
        active: false,
        lastActive: new Date().toISOString(),
        queued: 2,
      },
    ],
    counts: { total: 1, active: 0 },
  };
  const rosterCheck = compile(RosterPayloadSchema);
  assert.equal(rosterCheck.Check(roster), true);
  const wsCheck = compile(WsEventSchema);
  assert.equal(wsCheck.Check(roster), true);
  assert.equal(
    wsCheck.Check({ type: "hello", fleet: "/f", bootId: "b", seq: 0 }),
    true
  );
  assert.equal(
    wsCheck.Check({
      type: "bubble",
      bot: "forge",
      turnId: null,
      phase: "delta",
      text: "working text",
    }),
    true
  );
  assert.equal(wsCheck.Check({ type: "unknown" }), false);
});

test("version payload carries the package version and capabilities", () => {
  const payload = versionPayload();
  assert.equal(compile(VersionResponseSchema).Check(payload), true);
  assert.equal(payload.version.length > 0, true);
  assert.ok(payload.capabilities.includes("images"));
  assert.ok(payload.capabilities.includes("ws-auth-bearer"));
});
