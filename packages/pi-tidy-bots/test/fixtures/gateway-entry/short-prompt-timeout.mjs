// Fault injection for the spawned test daemon only. Keep the real RpcSession
// timeout path, without making the parity suite wait ten minutes. No production
// module or other timer is replaced, and the fake native child does not import
// this module. The test asserts that this boundary was actually armed.
import { appendFileSync } from "node:fs";

const original = globalThis.setTimeout;
globalThis.setTimeout = function (callback, delay, ...args) {
  if (delay === 10 * 60_000) {
    appendFileSync(process.env.GATEWAY_ENTRY_TIMEOUT_TRACE, "armed\n");
    return original(callback, 2000, ...args);
  }
  return original(callback, delay, ...args);
};
