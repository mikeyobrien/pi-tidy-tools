#!/usr/bin/env node
// Deterministic protocol peer. No native engine, user workspace, network or model calls.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let init;
let ack = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const event = (sequence, extra = {}) => ({
  jsonrpc: "2.0",
  method: "event",
  params: {
    bindingId: init.bindingId,
    leaseGeneration: init.leaseGeneration,
    sourceSequence: sequence,
    eventId: `event-${sequence}`,
    type: "session.state",
    payload: { availability: "ready" },
    ...extra,
  },
});
const capabilities = {
  input: { text: true, mediaTypes: [], maxMediaBytes: 0 },
  sessions: { load: false, import: false, continuity: "unverified" },
  output: { text: "snapshots", tools: false, usage: "unknown" },
  operations: {
    nativeDedupe: "none",
    nativeReplay: "none",
    cancel: "unsupported",
    steer: false,
  },
  interactions: { permissions: "none", questions: false },
  configuration: { model: false, thinking: false, compact: false },
  fleetTools: false,
};
const methods = [
  "health",
  "session.open",
  "session.snapshot",
  "operation.submit",
  "operation.inspect",
  "operation.cancel",
  "interaction.respond",
  "events.ack",
  "events.replay",
  "session.close",
  "shutdown",
];
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (init)
    appendFileSync(
      join(init.dataDir, "calls.jsonl"),
      JSON.stringify(msg) + "\n"
    );
  if (msg.method === "initialize") {
    init = msg.params;
    writeFileSync(
      join(init.dataDir, "environment.json"),
      JSON.stringify(process.env)
    );
    if (init.config.mode === "initialize-hang") return;
    const result = {
      protocol: { major: 1, minor: 0 },
      plugin: {
        id: init.expectedPlugin.id,
        version: init.expectedPlugin.version,
      },
      runtime: { name: "fixture", version: "1.0.0" },
      methods,
      capabilities,
      health: "ready",
    };
    if (init.config.mode === "bad-identity")
      result.plugin.id = "org.bad.identity";
    if (init.config.mode === "missing-method") result.methods = ["health"];
    if (init.config.mode === "untruthful-dedupe")
      result.capabilities.operations.nativeDedupe = "durable";
    if (init.config.mode === "preinitialize-event") send(event(1));
    send({ jsonrpc: "2.0", id: msg.id, result });
    if (init.config.mode === "immediate-event") send(event(1));
    return;
  }
  if (msg.method === "events.ack") {
    ack = msg.params.sourceSequence;
    return;
  }
  if (!msg.method) return;
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: { closed: true } });
    return;
  }
  if (msg.method === "fixture.exit-with-child") {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    send({ jsonrpc: "2.0", id: msg.id, result: { childPid: child.pid } });
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (msg.method === "fixture.hang") return;
  if (msg.method === "fixture.numeric-id") {
    send({ jsonrpc: "2.0", id: 42, result: {} });
    return;
  }
  if (msg.method === "fixture.garbage") {
    process.stdout.write("debug output that is not JSON\n");
    return;
  }
  if (msg.method === "fixture.oversize") {
    process.stdout.write("x".repeat(init.limits.maxFrameBytes));
    return;
  }
  if (msg.method === "fixture.stale") {
    send(event(1, { leaseGeneration: init.leaseGeneration - 1 }));
    return;
  }
  if (msg.method === "fixture.stderr")
    process.stderr.write("Bearer very-secret-value\n".repeat(10000));
  if (msg.method === "fixture.events")
    for (const sequence of msg.params.sequences) send(event(sequence));
  if (msg.method === "fixture.host-call")
    send({
      jsonrpc: "2.0",
      id: "reverse-1",
      method: "host.call",
      params: {
        bindingId: init.bindingId,
        leaseGeneration: init.leaseGeneration,
        name: msg.params.name ?? "fleet.send",
        callId: "call-1",
        arguments: {},
      },
    });
  send({
    jsonrpc: "2.0",
    id: msg.id,
    result: { method: msg.method, params: msg.params, ack },
  });
});
