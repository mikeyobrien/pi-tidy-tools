let buffer = "";
let stateSeen = false;
let promptBeforeState = false;

function parseLaunchModel(argv) {
  const index = argv.indexOf("--model");
  if (index < 0 || index + 1 >= argv.length)
    return { provider: "fake", id: "model-x" };
  const ref = String(argv[index + 1] ?? "");
  const slash = ref.indexOf("/");
  if (slash <= 0) return { provider: "fake", id: ref || "model-x" };
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function parseLaunchThinking(argv) {
  const index = argv.indexOf("--thinking");
  if (index < 0 || index + 1 >= argv.length) return "medium";
  return String(argv[index + 1] ?? "medium");
}

const launchModel = parseLaunchModel(process.argv);
const launchThinking = parseLaunchThinking(process.argv);

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (let line of lines) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    const command = JSON.parse(line);
    const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

    if (command.type === "abort") {
      send({ type: "response", id: command.id, command: "abort", success: true });
      process.exitCode = 0;
      setTimeout(() => process.exit(), 5);
      continue;
    }

    if (command.type === "steer") {
      if (!String(command.message ?? "").trim()) {
        send({ type: "response", id: command.id, command: "steer", success: false, error: "steering message is empty" });
      } else {
        send({ type: "response", id: command.id, command: "steer", success: true });
        send({ type: "queue_update", steering: [command.message], followUp: [] });
      }
      continue;
    }

    if (command.type === "get_state") {
      stateSeen = true;
      if (process.env.PI_TIDY_FAKE_RPC_STATE_MODE === "ignore") continue;
      if (process.env.PI_TIDY_FAKE_RPC_STATE_MODE === "exit") {
        process.stderr.write("state probe exited");
        process.exit(6);
      }
      if (process.env.PI_TIDY_FAKE_RPC_MALFORMED_STATE === "1") {
        send({
          type: "response",
          id: command.id,
          command: "get_state",
          success: true,
          data: { thinkingLevel: "medium" },
        });
        continue;
      }
      if (process.env.PI_TIDY_FAKE_RPC_STATE_ERROR === "1") {
        send({
          type: "response",
          id: command.id,
          command: "get_state",
          success: false,
          error: "state unavailable",
        });
        continue;
      }
      let provider = launchModel.provider;
      let id = launchModel.id;
      if (process.env.PI_TIDY_FAKE_RPC_MISMATCH === "1") {
        provider = "other";
        id = "wrong-model";
      } else if (process.env.PI_TIDY_FAKE_RPC_OBSERVED_MODEL) {
        const ref = process.env.PI_TIDY_FAKE_RPC_OBSERVED_MODEL;
        const slash = ref.indexOf("/");
        if (slash > 0) {
          provider = ref.slice(0, slash);
          id = ref.slice(slash + 1);
        } else id = ref;
      }
      // Observed thinking defaults to the launch --thinking arg; env can override for reconciliation tests.
      let thinkingLevel = launchThinking;
      if (process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING) {
        thinkingLevel = process.env.PI_TIDY_FAKE_RPC_OBSERVED_THINKING;
      }
      send({
        type: "response",
        id: command.id,
        command: "get_state",
        success: true,
        data: {
          model: { provider, id, name: id },
          thinkingLevel,
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          sessionId: "fake",
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
      continue;
    }

    if (command.type !== "prompt") continue;
    if (!stateSeen) promptBeforeState = true;
    const prompt = command.message;

    // Per-prompt mismatch / malformed overrides (for mixed-batch tests).
    if (prompt === "state-mismatch" || prompt === "state-malformed") {
      // These prompts are only reached if the runner skipped state checks; treat as crash.
      send({
        type: "response",
        id: command.id,
        command: "prompt",
        success: false,
        error: "prompt arrived without verified state",
      });
      continue;
    }

    if (prompt === "reject") {
      send({
        type: "response",
        id: command.id,
        command: "prompt",
        success: false,
        error: "prompt rejected",
      });
      continue;
    }
    send({
      type: "response",
      id: command.id,
      command: "prompt",
      success: true,
      promptBeforeState,
    });
    send({ type: "agent_start" });
    if (prompt === "hang") continue;
    if (prompt === "crash") {
      process.stderr.write("provider failed");
      process.exit(7);
      continue;
    }
    if (prompt === "tool-crash") {
      send({
        type: "tool_execution_start",
        toolCallId: "crash-tool",
        toolName: "bash",
        args: {
          command: "kill -9 $PPID",
          reasoning: "crash the parent process",
        },
      });
      process.stderr.write("child exited during bash");
      process.exit(9);
      continue;
    }
    if (prompt === "stream") {
      let count = 0;
      const timer = setInterval(() => {
        send({
          type: "message_update",
          message: {},
          assistantMessageEvent: {
            type: "text_delta",
            delta: `part${count++} `,
          },
        });
        if (count === 40) {
          clearInterval(timer);
          send({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "stream complete" }],
              usage: {},
            },
          });
          send({ type: "agent_settled" });
        }
      }, 5);
      continue;
    }
    if (prompt === "usage") {
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          usage: {
            input: 1_250_000,
            output: 69_000,
            cacheRead: 11_000,
            cacheWrite: 2_000,
          },
        },
      });
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "usage complete" }],
          usage: {
            input: 2_250_000,
            output: 100_000,
            cache_read: 22_000,
            cache_write: 3_000,
          },
        },
      });
      send({ type: "agent_settled" });
      continue;
    }
    if (prompt === "delayed") {
      setTimeout(() => {
        send({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "delayed background result" }],
            usage: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0 },
          },
        });
        send({ type: "agent_settled" });
      }, 120);
      continue;
    }
    if (prompt === "runner-branches") {
      send({
        type: "tool_execution_start",
        toolCallId: "active",
        toolName: "read",
        args: { path: "active.ts" },
      });
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: Array.from(
                { length: 20 },
                (_, index) => `line ${index}`
              ).join("\n"),
            },
          ],
          usage: {},
        },
      });
      send({
        type: "tool_execution_end",
        toolCallId: "unmatched",
        toolName: "read",
        result: { content: [] },
        isError: true,
      });
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "branches complete" }],
          usage: {},
        },
      });
      send({ type: "agent_settled" });
      continue;
    }
    send({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "working frag" },
    });
    send({
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "text_delta",
        delta: "ments\n\nnext line",
      },
    });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working fragments\n\nnext line" }],
        usage: {},
      },
    });
    send({
      type: "tool_execution_start",
      toolCallId: "a",
      toolName: "read",
      args: { path: "a.ts", reasoning: "inspect the source" },
    });
    send({
      type: "tool_execution_start",
      toolCallId: "b",
      toolName: "mystery",
      args: { name: "b" },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "b",
      toolName: "mystery",
      result: { content: [{ type: "text", text: "RAW OMIT" }] },
      isError: false,
    });
    send({
      type: "tool_execution_end",
      toolCallId: "a",
      toolName: "read",
      result: { content: [{ type: "text", text: "RAW OMIT" }] },
      isError: false,
    });
    const text = prompt === "empty" ? "" : `# Result\n\n${prompt} ]]> kept`;
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
      },
    });
    send({ type: "agent_settled" });
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
