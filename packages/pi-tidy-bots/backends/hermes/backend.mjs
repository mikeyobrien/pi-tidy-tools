#!/usr/bin/env node
import "@mobrienv/pi-tidy-bots/plugin-sdk";
const { startHermesAdapter } = await import("./adapter.ts");
const result = await startHermesAdapter().done;
process.exit(result.cleanup === "complete" ? 0 : 2);
