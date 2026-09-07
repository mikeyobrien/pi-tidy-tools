#!/usr/bin/env node
import readline from "node:readline";

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
let pending;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === "prompt") {
    send({
      type: "response",
      id: request.id,
      command: "prompt",
      success: true,
    });
    const mode = String(request.message);
    const requestFrame =
      mode === "editor"
        ? {
            type: "extension_ui_request",
            id: "ui-editor",
            method: "editor",
            title: "Notes",
            prefill: "seed",
          }
        : mode === "timeout"
          ? {
              type: "extension_ui_request",
              id: "ui-timeout",
              method: "input",
              title: "Short",
              timeout: 250,
            }
          : mode === "timeout-zero"
            ? {
                type: "extension_ui_request",
                id: "ui-zero",
                method: "input",
                title: "No deadline",
                timeout: 0,
              }
            : mode === "timeout-bad"
              ? {
                  type: "extension_ui_request",
                  id: "ui-bad",
                  method: "input",
                  title: "Bad",
                  timeout: -1,
                }
              : {
                  type: "extension_ui_request",
                  id: "ui-select",
                  method: "select",
                  title: "Window",
                  options: ["AM", "PM"],
                };
    pending = requestFrame.id;
    send(requestFrame);
  } else if (
    request.type === "extension_ui_response" &&
    request.id === pending
  ) {
    pending = undefined;
    send({ type: "agent_end" });
    send({ type: "agent_settled" });
  }
}
