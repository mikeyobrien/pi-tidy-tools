let buffer = "";
process.stdin.on("data", (chunk) => {
 buffer += chunk.toString("utf8");
 const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
 for (let line of lines) {
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (!line) continue;
  const command = JSON.parse(line);
  if (command.type === "abort") { process.exitCode = 0; setTimeout(() => process.exit(), 5); continue; }
  if (command.type !== "prompt") continue;
  const prompt = command.message;
  const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  if (prompt === "reject") { send({ type: "response", id: command.id, command: "prompt", success: false, error: "prompt rejected" }); continue; }
  send({ type: "response", id: command.id, command: "prompt", success: true });
  send({ type: "agent_start" });
  if (prompt === "hang") continue;
  if (prompt === "crash") { process.stderr.write("provider failed"); process.exit(7); continue; }
  if (prompt === "stream") {
   let count = 0;
   const timer = setInterval(() => {
    send({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: `part${count++} ` } });
    if (count === 40) {
     clearInterval(timer);
     send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stream complete" }], usage: {} } });
     send({ type: "agent_settled" });
    }
   }, 5);
   continue;
  }
  if (prompt === "usage") {
   send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 1_250_000, output: 69_000, cacheRead: 11_000, cacheWrite: 2_000 } } });
   send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "usage complete" }], usage: { input: 2_250_000, output: 100_000, cache_read: 22_000, cache_write: 3_000 } } });
   send({ type: "agent_settled" });
   continue;
  }
  send({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "working frag" } });
  send({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "ments\n\nnext line" } });
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working fragments\n\nnext line" }], usage: {} } });
  send({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts", reasoning: "inspect the source" } });
  send({ type: "tool_execution_start", toolCallId: "b", toolName: "mystery", args: { name: "b" } });
  send({ type: "tool_execution_end", toolCallId: "b", toolName: "mystery", result: { content: [{ type: "text", text: "RAW OMIT" }] }, isError: false });
  send({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "RAW OMIT" }] }, isError: false });
  const text = prompt === "empty" ? "" : `# Result\n\n${prompt} ]]> kept`;
  send({ type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } } });
  send({ type: "agent_settled" });
 }
});
setInterval(() => {}, 1000);
