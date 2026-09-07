import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  DEFAULT_LIMITS,
  FrameDecoder,
  encodeFrame,
  nonempty,
  object,
  validateLimits,
} from "@mobrienv/pi-tidy-bots/plugin-protocol";

const names = ["ask_user_question", "fleet_discover", "fleet_send"];
const valid = (value) =>
  nonempty(value) &&
  value.trim() &&
  value.length <= 256 &&
  !value.includes("\0");
const unavailable = () =>
  new Error("Fleet tool unavailable; task completion is not confirmed");

/** Explicit Pi 0.85 extension. FD 3 is supplied only by the owning adapter.
 * No credentials, task text or gateway operation IDs enter argv or environment.
 * The adapter must use --tools ask_user_question,fleet_discover,fleet_send: no-builtin-tools alone
 * disables built-ins but retains their definitions in Pi's getAllTools().
 */
export default function fleetExtension(pi) {
  const socket = new Socket({ fd: 3, readable: true, writable: true });
  let limits = DEFAULT_LIMITS;
  const decoder = new FrameDecoder();
  let initialized = false,
    closed = false,
    initId;
  let sessionId, armed, active;
  const pending = new Map();
  const retired = new Set();
  const fail = () => {
    if (closed) return;
    closed = true;
    armed = active = undefined;
    for (const call of [...pending.values()]) call.reject(unavailable());
    socket.destroy();
  };
  const write = (message) => {
    if (closed) throw unavailable();
    const frame = encodeFrame(message, limits.maxFrameBytes);
    if (socket.writableLength + frame.length > 2 * limits.maxFrameBytes) {
      fail();
      throw unavailable();
    }
    socket.write(frame);
  };
  const prove = () => {
    const registered = pi
      .getAllTools()
      .map((tool) => tool.name)
      .sort();
    const enabled = [...pi.getActiveTools()].sort();
    if (
      JSON.stringify(registered) !== JSON.stringify(names) ||
      JSON.stringify(enabled) !== JSON.stringify(names)
    )
      throw unavailable();
  };
  const ready = () => {
    if (!initId || !sessionId) return;
    prove();
    write({
      jsonrpc: "2.0",
      id: initId,
      result: {
        nativeSessionId: sessionId,
        tools: ["fleet_discover", "fleet_send"],
        bridgeVersion: 1,
      },
    });
    initId = undefined;
    initialized = true;
  };
  socket.on("error", fail);
  socket.on("end", fail);
  socket.on("close", fail);
  socket.on("data", (bytes) => {
    try {
      decoder.push(bytes, (message) => {
        encodeFrame(message, limits.maxFrameBytes);
        if (!message.method) {
          const call = pending.get(message.id);
          if (!call) {
            if (retired.has(message.id)) return;
            throw unavailable();
          }
          if (message.error) call.reject(unavailable());
          else call.resolve(message.result);
          return;
        }
        if (!message.id || !object(message.params)) throw unavailable();
        if (message.method === "initialize" && !initialized && !initId) {
          if (Object.keys(message.params).some((key) => key !== "limits"))
            throw unavailable();
          limits = validateLimits(message.params.limits);
          initId = message.id;
          ready();
          return;
        }
        if (
          message.method === "activate" &&
          initialized &&
          !armed &&
          !active &&
          message.params.nativeSessionId === sessionId &&
          valid(message.params.promptId) &&
          Object.keys(message.params).length === 2
        ) {
          prove();
          armed = message.params.promptId;
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: { status: "armed", promptId: armed },
          });
          return;
        }
        if (
          message.method === "disarm" &&
          initialized &&
          armed &&
          !active &&
          message.params.promptId === armed &&
          Object.keys(message.params).length === 1
        ) {
          armed = undefined;
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: { status: "disarmed" },
          });
          return;
        }
        throw unavailable();
      });
    } catch {
      fail();
    }
  });
  pi.on("session_start", (_event, ctx) => {
    try {
      if (sessionId || closed) throw unavailable();
      const id = ctx.sessionManager.getSessionId();
      if (!valid(id)) throw unavailable();
      sessionId = id;
      ready();
    } catch {
      fail();
    }
  });
  pi.on("agent_start", () => {
    try {
      if (!initialized || !armed || active || closed) throw unavailable();
      prove();
      active = armed;
      armed = undefined;
    } catch {
      fail();
    }
  });
  pi.on("agent_end", () => {
    if (pending.size) fail();
    active = undefined;
  });
  pi.on("session_shutdown", fail);

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user question",
    description:
      "Ask one bounded generic UI question; this is not tool permission approval.",
    parameters: Type.Object(
      {
        method: Type.Union([
          Type.Literal("select"),
          Type.Literal("confirm"),
          Type.Literal("input"),
          Type.Literal("editor"),
        ]),
        title: Type.String(),
        options: Type.Optional(Type.Array(Type.String())),
        message: Type.Optional(Type.String()),
        placeholder: Type.Optional(Type.String()),
        prefill: Type.Optional(Type.String()),
      },
      { additionalProperties: false }
    ),
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      if (
        closed ||
        !initialized ||
        !active ||
        !valid(toolCallId) ||
        ctx.sessionManager.getSessionId() !== sessionId ||
        signal?.aborted ||
        !object(args) ||
        typeof args.method !== "string" ||
        !["select", "confirm", "input", "editor"].includes(args.method) ||
        typeof args.title !== "string" ||
        args.title.length > 16384
      )
        throw unavailable();
      const allowed = new Set([
        "method",
        "title",
        "options",
        "message",
        "placeholder",
        "prefill",
      ]);
      if (Object.keys(args).some((key) => !allowed.has(key)))
        throw unavailable();
      if (args.method === "select") {
        if (
          !Array.isArray(args.options) ||
          args.options.length < 1 ||
          args.options.length > 32 ||
          !args.options.every(
            (value) => typeof value === "string" && value.length <= 4096
          ) ||
          new Set(args.options).size !== args.options.length
        )
          throw unavailable();
      } else if (args.options !== undefined) throw unavailable();
      for (const key of ["message", "placeholder", "prefill"])
        if (
          args[key] !== undefined &&
          (typeof args[key] !== "string" || args[key].length > 16384)
        )
          throw unavailable();
      if (!ctx.ui) throw unavailable();
      let result;
      if (args.method === "select")
        result = await ctx.ui.select(args.title, args.options, { signal });
      else if (args.method === "confirm")
        result = await ctx.ui.confirm(args.title, args.message ?? "", {
          signal,
        });
      else if (args.method === "input")
        result = await ctx.ui.input(args.title, args.placeholder, { signal });
      else result = await ctx.ui.editor(args.title, args.prefill);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "answered",
              method: args.method,
              result: result ?? null,
            }),
          },
        ],
        details: {},
      };
    },
  });

  for (const name of ["fleet_discover", "fleet_send"])
    pi.registerTool({
      name,
      label: name === "fleet_send" ? "Send fleet task" : "Discover fleet peers",
      description:
        name === "fleet_send"
          ? "Admit a task for a permitted peer. Admission is not completion; the completion arrives separately."
          : "List the fleet peers this bot may contact.",
      parameters:
        name === "fleet_send"
          ? Type.Object(
              { target: Type.String(), text: Type.String() },
              { additionalProperties: false }
            )
          : Type.Object({}, { additionalProperties: false }),
      async execute(toolCallId, args, signal, _onUpdate, ctx) {
        if (
          closed ||
          !initialized ||
          !active ||
          !valid(toolCallId) ||
          ctx.sessionManager.getSessionId() !== sessionId ||
          signal?.aborted ||
          pending.size >= limits.maxPendingRequests ||
          retired.size >= 4096 ||
          !object(args)
        )
          throw unavailable();
        if (
          name === "fleet_discover"
            ? Object.keys(args).length !== 0
            : Object.keys(args).length !== 2 ||
              !valid(args.target) ||
              !nonempty(args.text) ||
              !args.text.trim() ||
              Buffer.byteLength(args.text) > 65536
        )
          throw unavailable();
        const id = randomUUID();
        const result = await new Promise((resolve, reject) => {
          const finish = (callback, value) => {
            if (!pending.delete(id)) return;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            retired.add(id);
            callback(value);
          };
          const abort = () => finish(reject, unavailable());
          const timer = setTimeout(abort, limits.commandTimeoutMs);
          pending.set(id, {
            resolve: (value) => finish(resolve, value),
            reject: (error) => finish(reject, error),
          });
          signal?.addEventListener("abort", abort, { once: true });
          try {
            write({
              jsonrpc: "2.0",
              id,
              method: "fleet.call",
              params: {
                nativeSessionId: sessionId,
                promptId: active,
                nativeToolCallId: toolCallId,
                name: name === "fleet_send" ? "fleet.send" : "fleet.discover",
                arguments: args,
              },
            });
          } catch {
            abort();
          }
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result ?? { status: "unknown" }),
            },
          ],
          details: {},
        };
      },
    });
}
