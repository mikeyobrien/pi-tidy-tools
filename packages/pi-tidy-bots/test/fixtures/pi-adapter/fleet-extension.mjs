import { createInterface } from "node:readline";
import extension from "../../../backends/pi/fleet-extension.mjs";

const handlers = new Map(),
  tools = new Map();
const ctx = { sessionManager: { getSessionId: () => "native-session" } };
extension({
  on: (name, handler) => handlers.set(name, handler),
  registerTool: (tool) => tools.set(tool.name, tool),
  getActiveTools: () => [...tools.keys()],
  getAllTools: () => [...tools.values()],
});
await handlers.get("session_start")({}, ctx);
const reader = createInterface({ input: process.stdin });
reader.on("line", async (line) => {
  const request = JSON.parse(line);
  try {
    let result = {};
    if (request.method === "start") await handlers.get("agent_start")({}, ctx);
    else if (request.method === "end") await handlers.get("agent_end")({}, ctx);
    else if (request.method === "call") {
      const abort = new AbortController();
      if (request.aborted) abort.abort();
      result = await tools
        .get(request.name ?? "fleet_send")
        .execute(
          request.toolCallId ?? "native-call",
          request.args ?? { target: "peer", text: "fixture" },
          abort.signal,
          undefined,
          request.foreign
            ? { sessionManager: { getSessionId: () => "foreign" } }
            : ctx
        );
    }
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ id: request.id, error: error.message }) + "\n"
    );
  }
});
reader.on("close", () => handlers.get("session_shutdown")({}, ctx));
