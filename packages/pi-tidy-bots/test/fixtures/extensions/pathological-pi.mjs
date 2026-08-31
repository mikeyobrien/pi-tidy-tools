// Pathological child runner (issue 46 conformance suite): a stand-in for
// `pi --mode rpc` that exhibits extension pathologies at the daemon boundary.
// Behavior is selected per bot via EXT_MODE_DIR/<PI_TIDY_BOTS_NAME>.mode so a
// single fleet can mix healthy and pathological children.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const name = process.env.PI_TIDY_BOTS_NAME ?? "unknown";
const modeDir = process.env.PI_TIDY_BOTS_EXT_MODE_DIR ?? ".";
const modeFile = join(modeDir, `${name}.mode`);
const mode = existsSync(modeFile)
  ? readFileSync(modeFile, "utf8").trim()
  : "silent";
// Conformance trace (issue 46): fixed path so the suite can diagnose misses.
writeFileSync(
  "/tmp/ptb-runner-trace.log",
  `${new Date().toISOString()} name=${name} mode=${mode} modeFile=${modeFile}\n`,
  { flag: "a" }
);
const mark = (file) => writeFileSync(join(modeDir, file), String(Date.now()));

switch (mode) {
  case "crash-then-recover": {
    const countFile = join(modeDir, `${name}.count`);
    const count = existsSync(countFile)
      ? Number(readFileSync(countFile, "utf8"))
      : 0;
    writeFileSync(countFile, String(count + 1));
    if (count < 2) process.exit(1); // crash twice, then recover.
    mark(`${name}.recovered`);
    setInterval(
      () => console.log(JSON.stringify({ type: "warp_core_breach", deck: 12 })),
      500
    );
    break;
  }
  case "unknown-events":
    mark(`${name}.up`);
    setInterval(
      () => console.log(JSON.stringify({ type: "warp_core_breach" })),
      300
    );
    break;
  case "flood":
    mark(`${name}.up`);
    setInterval(() => process.stdout.write("F".repeat(65536) + "\n"), 200);
    break;
  case "garbage-ui":
    mark(`${name}.up`);
    setInterval(() => {
      console.log(
        JSON.stringify({
          type: "extension_ui_request",
          id: `garbage-${Date.now()}`,
          method: "rm_rf_family",
          title: "Wipe every disk?",
          message: "trust me",
        })
      );
    }, 1000);
    break;
  case "hang":
    // Prints nothing, never exits: hangs degrade to RPC timeouts.
    break;
}

// Keep non-exiting modes alive for the duration of the test.
setInterval(() => {}, 1 << 30);
