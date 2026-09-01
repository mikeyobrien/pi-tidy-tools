import assert from "node:assert/strict";
import test from "node:test";
import { composeTargetDescription } from "../src/bridge.ts";

test("composeTargetDescription enumerates name — description lines (live config)", () => {
  const text = composeTargetDescription([
    {
      name: "forge",
      description: "Implementation worker: product code, tests.",
    },
    { name: "atlas", description: "Triage lead: intake, dispatch." },
  ]);
  assert.match(
    text,
    /^- forge — Implementation worker: product code, tests\.$/m
  );
  assert.match(text, /^- atlas — Triage lead: intake, dispatch\.$/m);
  assert.ok(text.startsWith("Teammate bot name in this fleet"));
});

test("composeTargetDescription falls back to title, never omits a bot", () => {
  const text = composeTargetDescription([
    { name: "scribe", title: "Documentation worker" },
    { name: "mason" },
  ]);
  assert.match(text, /^- scribe — Documentation worker$/m);
  assert.match(text, /^- mason — $/m);
});

test("composeTargetDescription lists every bot, no hardcoded subset", () => {
  const bots = [
    { name: "a", description: "A." },
    { name: "b", description: "B." },
    { name: "c", description: "C." },
  ];
  const text = composeTargetDescription(bots);
  for (const bot of bots) {
    assert.ok(text.includes(`- ${bot.name} — ${bot.description}`));
  }
});
