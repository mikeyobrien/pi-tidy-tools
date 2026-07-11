import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("real Pi RPC protocol smoke", { skip: process.env.PI_TIDY_REAL_SMOKE !== "1", timeout: 120_000 }, async () => {
 const proc = spawn(process.env.PI_EXECUTABLE || "pi", ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions"], { stdio: ["pipe", "pipe", "pipe"] });
 let buffer = "", stderr = "", settled = false;
 proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
 proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8"); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
  for (let line of lines) {
   if (line.endsWith("\r")) line = line.slice(0, -1);
   if (!line) continue;
   const event = JSON.parse(line);
   if (event.type === "agent_settled") { settled = true; proc.stdin.end(); proc.kill("SIGTERM"); }
  }
 });
 proc.stdin.write(`${JSON.stringify({ id: "smoke", type: "prompt", message: "Reply with exactly: tidy smoke ok" })}\n`);
 const code = await new Promise<number | null>((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
 assert.ok(settled, `Pi did not settle (exit ${code}): ${stderr}`);
});
