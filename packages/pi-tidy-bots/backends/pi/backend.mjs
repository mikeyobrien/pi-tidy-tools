#!/usr/bin/env node
import "@mobrienv/pi-tidy-bots/plugin-sdk";
const { startPiAdapter } = await import("./adapter.ts");
const result = await startPiAdapter().done;
process.exit(result.cleanup === "complete" ? 0 : 2);
