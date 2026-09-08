#!/usr/bin/env node
import "@mobrienv/pi-tidy-bots/plugin-sdk";
const { startCodexAdapter } = await import("./adapter.ts");
const result = await startCodexAdapter().done;
process.exit(result.cleanup === "complete" ? 0 : 2);
