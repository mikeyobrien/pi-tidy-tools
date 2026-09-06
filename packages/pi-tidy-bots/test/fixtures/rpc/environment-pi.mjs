#!/usr/bin/env node
// Disposable native transport fixture; no provider/runtime calls.
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  process.stdout.write(
    JSON.stringify({
      type: "response",
      id: request.id,
      success: true,
      environment: process.env,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
    }) + "\n"
  );
}
