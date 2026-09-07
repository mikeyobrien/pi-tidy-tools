import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// Migration step 1 is exercised through the SHIPPED bin, not the unused
// extracted server/events helpers. These are legacy observations, not gateway
// durability promises; unsafe cases are explicitly labelled in the fixture.
const fixture = fileURLToPath(
  new URL("./fixtures/gateway-entry/", import.meta.url)
);
const bin = fileURLToPath(new URL("../bin/pi-tidy-bots.mjs", import.meta.url));
const expected = JSON.parse(
  readFileSync(join(fixture, "legacy-trace.json"), "utf8")
);
const token = "hermetic-gateway-entry-token";
type Frame = Record<string, any>;

async function until(
  probe: () => boolean | Promise<boolean>,
  description: string,
  timeout = 15000
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class Fleet {
  dir = mkdtempSync(join(tmpdir(), "ptb-gateway-entry-"));
  child?: ChildProcess;
  base = "";
  output = "";
  errors = "";
  sockets: WebSocket[] = [];

  constructor(names = ["aa"]) {
    for (const name of names) {
      mkdirSync(join(this.dir, "bots", name), { recursive: true });
      writeFileSync(
        join(this.dir, "bots", name, "AGENTS.md"),
        `# Fixture ${name}\n`
      );
    }
    mkdirSync(join(this.dir, "home"));
    writeFileSync(
      join(this.dir, "bots.toml"),
      names
        .map((name) => `[[bot]]\nname = "${name}"\ndir = "bots/${name}"\n`)
        .join("\n")
    );
    const wrapper = join(this.dir, "native.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(fixture, "native-pi.mjs"))}\n`
    );
    chmodSync(wrapper, 0o700);
  }

  async start(shortTimeout = false, port = 0) {
    if (this.child) {
      assert.ok(
        this.child.exitCode !== null || this.child.signalCode !== null,
        "restart requires an observed terminal owner"
      );
      assert.equal(
        existsSync(join(this.dir, ".fleet", "lock.json")),
        false,
        "completed shutdown released the fleet lock before exit"
      );
    }
    this.output = "";
    this.errors = "";
    // Deliberately minimal environment: no user provider credentials or Pi
    // settings reach the CLI or native child. Only our temp HOME is visible.
    const env = {
      PATH: process.env.PATH,
      HOME: join(this.dir, "home"),
      PI_TIDY_BOTS_REGISTRY: join(this.dir, "fleets.json"),
      PI_TIDY_BOTS_PI_BIN: join(this.dir, "native.sh"),
      GATEWAY_ENTRY_CONTROL: this.dir,
      GATEWAY_ENTRY_TIMEOUT_TRACE: join(this.dir, "timeout.log"),
    };
    const args = ["--import", "tsx"];
    if (shortTimeout)
      args.push("--import", join(fixture, "short-prompt-timeout.mjs"));
    args.push(
      bin,
      "start",
      this.dir,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--token",
      token,
      "--json"
    );
    this.child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout!.on("data", (data) => {
      this.output += data;
    });
    this.child.stderr!.on("data", (data) => {
      this.errors += data;
    });
    this.child.on("error", (error) => {
      this.errors += String(error);
    });
    await until(() => {
      if (this.child?.exitCode !== null)
        throw new Error(`CLI exited: ${this.errors}`);
      for (const line of this.output.split("\n")) {
        try {
          const ready = JSON.parse(line);
          if (ready.port > 0) {
            assert.equal(
              ready.pid,
              this.child?.pid,
              "shipped bin owns the actual serving process"
            );
            this.base = `http://127.0.0.1:${ready.port}`;
            return true;
          }
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error;
        }
      }
      return false;
    }, "CLI readiness");
  }

  async request(path: string, body?: unknown, bearer: string | null = token) {
    const response = await fetch(this.base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: (await response.json()) as Frame };
  }

  async online() {
    await until(
      async () =>
        (await this.request("/api/fleet")).body.bots.every(
          (bot: Frame) => bot.online
        ),
      "native children online"
    );
  }

  async transcript(bot = "aa"): Promise<Frame[]> {
    return (await this.request(`/api/bots/${bot}/transcript`)).body.transcript;
  }

  native(): Frame[] {
    const file = join(this.dir, "native.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  set(file: string) {
    writeFileSync(join(this.dir, file), "");
  }

  async connect(queryToken = false, since = 0) {
    const frames: Frame[] = [];
    const ws = new WebSocket(
      this.base.replace("http:", "ws:") +
        `/api/ws?since=${since}${queryToken ? `&token=${token}` : ""}`,
      {
        headers: queryToken ? {} : { authorization: `Bearer ${token}` },
      }
    );
    this.sockets.push(ws);
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    // Historical roster events are sequenced. The unsequenced roster is the
    // end-of-replay snapshot; waiting for just any roster raced split packets.
    await until(
      () =>
        frames.some(
          (frame) => frame.type === "roster" && frame.seq === undefined
        ),
      "WS hello, complete replay and roster"
    );
    assert.equal(frames[0].type, "hello");
    assert.equal(typeof frames[0].bootId, "string");
    assert.equal(typeof frames[0].seq, "number");
    return { ws, frames };
  }

  async stop(signal: "SIGTERM" | "SIGINT" = "SIGTERM") {
    for (const socket of this.sockets.splice(0)) socket.terminate();
    if (
      !this.child ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    const child = this.child;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve())
    );
    child.kill(signal);
    const fallback = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(fallback);
    assert.equal(child.exitCode, 0, `CLI shutdown succeeded: ${this.errors}`);
  }

  async dispose() {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

test(
  "active CLI legacy trace: auth, full-text stream, queued acceptance, canonical identity, media and restart",
  { timeout: 45000 },
  async () => {
    const fleet = new Fleet();
    try {
      await fleet.start();
      await fleet.online();
      assert.deepEqual(
        await fleet.request("/api/fleet", undefined, null),
        expected.auth.anonymous
      );
      assert.deepEqual(
        await fleet.request("/api/fleet", undefined, "wrong"),
        expected.auth.wrongBearer
      );
      const unauthorized = new WebSocket(
        fleet.base.replace("http:", "ws:") + "/api/ws"
      );
      const rejected = await new Promise<number>((resolve, reject) => {
        unauthorized.on("error", () => {});
        unauthorized.once("unexpected-response", (_request, response) => {
          resolve(response.statusCode!);
          unauthorized.terminate();
        });
        unauthorized.once("open", () => {
          unauthorized.terminate();
          reject(new Error("anonymous WS opened"));
        });
      });
      assert.equal(rejected, expected.auth.wsAnonymousStatus);
      const live = await fleet.connect();
      const query = await fleet.connect(true);
      assert.equal(query.frames[0].bootId, live.frames[0].bootId);
      assert.deepEqual(
        await fleet.request("/api/bots/aa/message", {
          text: "stream",
          clientMessageId: "operator-1",
        }),
        expected.admission.direct
      );
      await until(
        () =>
          live.frames.some(
            (frame) =>
              frame.phase === "delta" &&
              frame.text === expected.stream.canonicalText
          ),
        "full-text snapshots"
      );
      assert.deepEqual(
        await fleet.request("/api/bots/aa/message", {
          text: "queued",
          clientMessageId: "operator-2",
        }),
        expected.admission.busyFollowUp
      );
      const queued = (await fleet.request("/api/bots/aa/queue")).body.queue;
      assert.equal(queued.length, 1);
      assert.equal(queued[0].id, "operator-2");
      assert.equal(
        (await fleet.transcript()).find((entry) => entry.id === "operator-2")
          ?.delivering,
        true
      );
      const snapshots = live.frames
        .filter((frame) => frame.phase === "delta")
        .map((frame) => frame.text);
      assert.deepEqual(
        [...new Set(snapshots)],
        expected.stream.distinctSnapshots
      );
      fleet.set("finish-stream");
      await until(
        () => live.frames.some((frame) => frame.phase === "final"),
        "canonical append and final"
      );
      const assistant = (await fleet.transcript()).find(
        (entry) =>
          entry.role === "assistant" &&
          entry.text === expected.stream.canonicalText
      )!;
      assert.ok(assistant?.id);
      assert.deepEqual(
        assistant.parts.map((part: Frame) =>
          part.type === "text" ? `text:${part.text}` : `tool:${part.status}`
        ),
        expected.stream.partShapes
      );
      const settlement = live.frames.filter(
        (frame) => frame.entry?.id === assistant.id || frame.phase === "final"
      );
      assert.deepEqual(
        settlement.map((frame) =>
          frame.type === "append" ? "append" : `bubble:${frame.phase}`
        ),
        expected.stream.settlementOrder
      );
      assert.deepEqual(
        settlement[0].entry,
        assistant,
        "WS and REST share the exact canonical entry"
      );
      assert.ok(
        settlement[0].seq < settlement[1].seq,
        "append precedes final in the global cursor"
      );
      const turnIds = new Set(
        live.frames
          .filter((frame) => frame.type === "bubble")
          .map((frame) => frame.turnId)
      );
      assert.equal(
        turnIds.size,
        1,
        "all bubble phases correlate to one native turn"
      );
      fleet.set("release-queue");
      await until(
        async () =>
          (await fleet.transcript()).some(
            (entry) => entry.text === "Reply: queued"
          ),
        "queued follow-up drain"
      );
      assert.equal(
        (await fleet.request("/api/bots/aa/queue")).body.queue.length,
        0
      );
      assert.deepEqual(
        await fleet.request("/api/bots/aa/message", {
          text: "stream",
          clientMessageId: "operator-1",
        }),
        expected.admission.duplicate
      );
      const media = {
        mediaType: "image/png",
        data: Buffer.from("fixture-image-bytes").toString("base64"),
        name: "sample.png",
      };
      assert.deepEqual(
        await fleet.request("/api/bots/aa/message", {
          text: "image",
          clientMessageId: "operator-image",
          images: [media],
        }),
        expected.admission.direct
      );
      await until(
        async () =>
          (await fleet.transcript()).some(
            (entry) => entry.text === "Reply: image"
          ),
        "image turn settled"
      );
      const imageEntry = (await fleet.transcript()).find(
        (entry) => entry.id === "operator-image"
      )!;
      assert.equal(imageEntry.images.length, 1);
      assert.equal(
        imageEntry.images[0].data,
        undefined,
        "public transcript has blob references, not base64"
      );
      const image = await fetch(
        fleet.base + `/api/images/aa/${basename(imageEntry.images[0].path)}`,
        { headers: { authorization: `Bearer ${token}` } }
      );
      assert.equal(image.status, 200);
      assert.equal(
        Buffer.from(await image.arrayBuffer()).toString(),
        "fixture-image-bytes"
      );
      const nativeImage = fleet
        .native()
        .find(
          (entry) => entry.direction === "in" && entry.frame.message === "image"
        )!;
      assert.deepEqual(nativeImage.frame.images, [
        { type: "image", data: media.data, mimeType: media.mediaType },
      ]);
      const reconnect = await fleet.connect(true);
      assert.equal(
        reconnect.frames.some((frame) => frame.type === "bubble"),
        false,
        "fresh replay suppresses retired turn bubbles"
      );
      assert.equal(
        reconnect.frames.filter((frame) => frame.entry?.id === assistant.id)
          .length,
        1
      );
      await fleet.stop();
      await fleet.start();
      await fleet.online();
      const restarted = await fleet.connect();
      assert.notEqual(
        restarted.frames[0].bootId,
        live.frames[0].bootId,
        "daemon restart creates a new public boot epoch"
      );
      const restored = await fleet.transcript();
      assert.equal(
        restored.filter((entry) => entry.id === assistant.id).length,
        1
      );
      assert.equal(
        restored.find((entry) => entry.id === assistant.id)?.text,
        assistant.text
      );
      assert.deepEqual(
        restored.find((entry) => entry.id === "operator-image")?.images,
        imageEntry.images
      );
    } finally {
      await fleet.dispose();
    }
  }
);

test(
  "active CLI releases lock and pidfile before SIGINT or SIGTERM exit; immediate restart succeeds",
  { timeout: 30000 },
  async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const fleet = new Fleet();
      try {
        await fleet.start();
        await fleet.online();
        assert.equal(existsSync(join(fleet.dir, ".fleet", "lock.json")), true);
        assert.equal(existsSync(join(fleet.dir, ".fleet", "daemon.pid")), true);
        await fleet.stop(signal);
        assert.equal(
          existsSync(join(fleet.dir, ".fleet", "lock.json")),
          false,
          `${signal} awaited handle.stop`
        );
        assert.equal(
          existsSync(join(fleet.dir, ".fleet", "daemon.pid")),
          false,
          `${signal} unclaimed its own pidfile`
        );
        await fleet.start();
        await fleet.online();
      } finally {
        await fleet.dispose();
      }
    }
  }
);

test(
  "active CLI legacy trace: authenticated native handoff becomes one completion without prompting the dispatcher",
  { timeout: 25000 },
  async () => {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve()))
    );
    // Current daemonUrl is formed before listen; an explicit ephemeral port is
    // needed for legacy native reverse calls. New gateway code must support 0.
    const fleet = new Fleet(["aa", "bb"]);
    try {
      await fleet.start(false, port);
      await fleet.online();
      assert.deepEqual(
        await fleet.request("/bus/send", {
          from: "aa",
          target: "bb",
          message: "not a native child",
        }),
        { status: 401, body: { delivered: false, reason: "unauthorized" } }
      );
      const live = await fleet.connect();
      await fleet.request("/api/bots/aa/message", {
        text: "handoff",
        clientMessageId: "dispatch-1",
      });
      await until(
        async () =>
          (await fleet.transcript()).some(
            (entry) => entry.kind === "completion"
          ),
        "native handoff completion"
      );
      const sender = await fleet.transcript();
      const target = await fleet.transcript("bb");
      const handoff = target.find((entry) => entry.kind === "handoff")!;
      assert.equal(handoff.originFrom, "aa");
      assert.equal(handoff.text, "fixture brief");
      const completion = sender.find((entry) => entry.kind === "completion")!;
      assert.equal(completion.originFrom, "bb");
      assert.equal(completion.text, "Worker result");
      const nativePrompts = fleet
        .native()
        .filter(
          (entry) =>
            entry.direction === "in" &&
            ["prompt", "follow_up"].includes(entry.frame.type)
        );
      assert.equal(
        nativePrompts.filter((entry) => entry.name === "aa").length,
        1,
        "completion does not prompt source again"
      );
      assert.equal(
        nativePrompts.filter((entry) => entry.name === "bb").length,
        1,
        "one actual native dispatch"
      );
      assert.deepEqual(
        fleet.native().find((entry) => entry.direction === "bus")?.frame,
        { status: 200, body: { delivered: true } }
      );
      assert.equal(
        live.frames.filter((frame) => frame.entry?.id === completion.id).length,
        1
      );
      const replay = await fleet.connect(true);
      assert.equal(
        replay.frames.filter((frame) => frame.entry?.id === completion.id)
          .length,
        1
      );
      assert.equal(
        fleet
          .native()
          .filter(
            (entry) =>
              entry.direction === "in" &&
              ["prompt", "follow_up"].includes(entry.frame.type)
          ).length,
        2,
        "read-only WS replay never executes a handoff"
      );
    } finally {
      await fleet.dispose();
    }
  }
);

test(
  "active CLI legacy trace: exact question response, duplicate answer and child-crash cancellation",
  { timeout: 35000 },
  async () => {
    const fleet = new Fleet();
    try {
      await fleet.start();
      await fleet.online();
      const live = await fleet.connect();
      await fleet.request("/api/bots/aa/message", { text: "question" });
      await until(
        async () =>
          (await fleet.transcript()).some(
            (entry) => entry.ui?.id === "question"
          ),
        "pending question"
      );
      assert.deepEqual(
        await fleet.request("/api/bots/aa/ui/question", { value: "Evening" }),
        expected.question.accepted
      );
      await until(
        () =>
          fleet
            .native()
            .some((entry) => entry.frame.type === "extension_ui_response"),
        "native exact answer"
      );
      assert.deepEqual(
        fleet
          .native()
          .find((entry) => entry.frame.type === "extension_ui_response")?.frame,
        expected.question.nativeResponse
      );
      assert.deepEqual(
        await fleet.request("/api/bots/aa/ui/question", { value: "Morning" }),
        expected.question.alreadyAnswered
      );
      const resolution = (await fleet.transcript()).find(
        (entry) => entry.uiResolved?.id === "question"
      )!;
      assert.deepEqual(resolution.uiResolved, expected.question.resolution);
      assert.ok(live.frames.some((frame) => frame.entry?.id === resolution.id));
      await until(
        async () =>
          (await fleet.transcript()).some(
            (entry) => entry.text === "Selected Evening"
          ),
        "answered turn ended"
      );
      await fleet.request("/api/bots/aa/message", { text: "question-crash" });
      await until(
        async () =>
          (await fleet.transcript()).some(
            (entry) => entry.ui?.id === "question-crash"
          ),
        "question before native crash"
      );
      fleet.set("crash");
      await until(
        async () =>
          (await fleet.transcript()).some(
            (entry) => entry.uiResolved?.id === "question-crash"
          ),
        "native crash cancellation projection"
      );
      const cancelled = (await fleet.transcript()).find(
        (entry) => entry.uiResolved?.id === "question-crash"
      )!;
      assert.deepEqual(cancelled.uiResolved, expected.question.crashResolution);
      assert.deepEqual(
        await fleet.request("/api/bots/aa/ui/question-crash", {
          value: "Morning",
        }),
        expected.question.alreadyAnswered
      );
      await fleet.stop();
      rmSync(join(fleet.dir, "crash"));
      await fleet.start();
      await fleet.online();
      const restored = await fleet.transcript();
      assert.equal(
        restored.filter((entry) => entry.id === resolution.id).length,
        1
      );
      assert.equal(
        restored.filter((entry) => entry.id === cancelled.id).length,
        1
      );
    } finally {
      await fleet.dispose();
    }
  }
);

test(
  "active CLI legacy trace: real prompt timeout is unknown; accepted compaction can be a no-op",
  { timeout: 25000 },
  async () => {
    const fleet = new Fleet();
    try {
      await fleet.start(true);
      await fleet.online();
      assert.deepEqual(
        await fleet.request("/api/bots/aa/message", {
          text: "unknown",
          clientMessageId: "unknown-1",
        }),
        expected.admission.unknown
      );
      assert.equal(
        readFileSync(join(fleet.dir, "timeout.log"), "utf8"),
        "armed\n",
        "actual RpcSession prompt timer was fault-injected once"
      );
      assert.equal(
        fleet
          .native()
          .filter(
            (entry) =>
              entry.direction === "in" && entry.frame.message === "unknown"
          ).length,
        1,
        "no automatic resend after uncertainty"
      );
      const entry = (await fleet.transcript()).find(
        (item) => item.id === "unknown-1"
      )!;
      assert.equal(entry.delivering, true);
      assert.equal(entry.deliveryError, undefined);
      assert.deepEqual(
        await fleet.request("/api/bots/aa/message", {
          text: "unknown",
          clientMessageId: "unknown-1",
        }),
        expected.admission.duplicate
      );
      assert.deepEqual(
        await fleet.request("/api/bots/aa/compact", {}),
        expected.compactionAlreadyDone
      );
      assert.equal(
        fleet
          .native()
          .filter(
            (item) => item.direction === "in" && item.frame.type === "compact"
          ).length,
        1,
        "get_state tokens make fill known so force compact reaches the child once"
      );
      await fleet.request("/api/bots/aa/message", { text: "usage" });
      await until(
        async () =>
          (await fleet.transcript()).some(
            (item) => item.text === "Reply: usage"
          ),
        "settled native usage initializes fill"
      );
      assert.deepEqual(
        await fleet.request("/api/bots/aa/compact", {}),
        expected.compactionAlreadyDone
      );
      const already = (await fleet.transcript()).filter((item) =>
        /already compacted/i.test(item.text)
      );
      assert.ok(already.length >= 1, "terminal no-op is visible once");
      assert.ok(
        fleet
          .native()
          .filter(
            (item) => item.direction === "in" && item.frame.type === "compact"
          ).length <= 2,
        "at most one retry after the first already-compacted refusal"
      );
    } finally {
      await fleet.dispose();
    }
  }
);

test(
  "active CLI legacy trace: offline 202 queues across restart without claiming crash-safe admission",
  { timeout: 30000 },
  async () => {
    const fleet = new Fleet();
    try {
      fleet.set("offline");
      await fleet.start();
      await until(
        async () => !(await fleet.request("/api/fleet")).body.bots[0].online,
        "offline child"
      );
      // Wait for the stub's initial exit to be observed; an immediately spawned
      // process is alive briefly even though the public roster is still offline.
      await until(
        () => fleet.errors.includes("exited (code=0"),
        "native initial exit"
      );
      assert.deepEqual(
        await fleet.request("/api/bots/aa/message", {
          text: "offline-message",
          clientMessageId: "offline-1",
        }),
        expected.admission.offline
      );
      assert.equal(
        (await fleet.request("/api/bots/aa/queue")).body.queue[0].id,
        "offline-1"
      );
      await fleet.stop();
      rmSync(join(fleet.dir, "offline"));
      await fleet.start();
      await fleet.online();
      await until(
        async () =>
          (await fleet.transcript()).some(
            (entry) => entry.text === "Reply: offline-message"
          ),
        "pending journal replay after restart"
      );
      assert.equal(
        (await fleet.request("/api/bots/aa/queue")).body.queue.length,
        0
      );
      assert.equal(
        (await fleet.transcript()).filter((entry) => entry.id === "offline-1")
          .length,
        1
      );
      assert.equal(
        fleet
          .native()
          .filter(
            (entry) =>
              entry.direction === "in" &&
              entry.frame.message === "offline-message"
          ).length,
        1
      );
      // Explicit unsafe baseline: duplicate IDs are only remembered in RAM.
      // The neutral journal must improve this; never use this test as an
      // assertion that restarting makes a fresh POST safe.
      assert.deepEqual(
        await fleet.request("/api/bots/aa/message", {
          text: "reused legacy id",
          clientMessageId: "offline-1",
        }),
        expected.admission.direct
      );
    } finally {
      await fleet.dispose();
    }
  }
);
