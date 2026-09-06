#!/usr/bin/env node
// One in-process loader works both in a checkout and an installed node_modules
// package. Keep argv, PID and signal ownership on the process the CLI launched.
import { register } from "tsx/esm/api";

register();
const { main } = await import(new URL("../src/cli.ts", import.meta.url).href);
await main();
