import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FrameDecoder, type RpcMessage } from "../src/gateway/protocol.ts";

const candidate = "/opt/homebrew/opt/python@3.14/bin/python3.14";
const python =
  process.env.TIDY_TEST_PYTHON ??
  (existsSync(candidate) ? candidate : "python3");
const guard = fileURLToPath(
  new URL("../backends/hermes/native_guard.py", import.meta.url)
);

async function fixture(
  options: {
    config?: unknown;
    version?: string;
    environment?: Record<string, string>;
    isolate?: boolean;
    checkpoints?: boolean;
  } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "tidy-hermes-guard-"));
  const source = join(dir, "runtime"),
    home = join(dir, "home"),
    profile = join(dir, "profile");
  await Promise.all([mkdir(source), mkdir(home), mkdir(profile)]);
  for (const name of [
    "hermes_cli",
    "acp_adapter",
    "agent_client_protocol-0.9.0.dist-info",
  ])
    await mkdir(join(source, name));
  await copyFile(
    new URL("./fixtures/hermes-native/fixture.py", import.meta.url),
    join(source, "hermes_cli", "fixture.py")
  );
  await writeFile(
    join(source, "hermes_cli", "__init__.py"),
    `__version__ = ${JSON.stringify(options.version ?? "0.20.5")}\nfrom .fixture import install\ninstall()\n`
  );
  await writeFile(join(source, "acp_adapter", "__init__.py"), "");
  await writeFile(
    join(source, "acp_adapter", "server.py"),
    "from hermes_cli.env_loader import load_hermes_dotenv\nload_hermes_dotenv(project_env='unscoped.env')\nfrom hermes_cli.fixture import FakeAgent as HermesACPAgent\n"
  );
  await writeFile(
    join(source, "acp_adapter", "entry.py"),
    "def _setup_logging():\n    pass\n"
  );
  await writeFile(
    join(source, "agent_client_protocol-0.9.0.dist-info", "METADATA"),
    "Name: agent-client-protocol\nVersion: 0.9.0\n"
  );
  const configFile = join(profile, "config.yaml");
  await writeFile(
    configFile,
    JSON.stringify(options.config ?? { approvals: { mode: "manual" } })
  );
  // Launch cwd must not be an import root, even when it contains matching names.
  await writeFile(
    join(dir, "hermes_cli.py"),
    "raise Exception('untrusted cwd import')\n"
  );
  const child = spawn(
    python,
    [
      ...(options.isolate === false ? [] : ["-I"]),
      "-B",
      guard,
      "--source",
      source,
      "--profile",
      profile,
      "--home",
      home,
      ...(options.checkpoints
        ? ["--checkpoint-dir", dir, "--binding-id", "fixture-binding"]
        : []),
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        HERMES_HOME: profile,
        ...options.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const pending = new Map<
    string,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let counter = 0,
    stderr = "";
  const messages: RpcMessage[] = [];
  const parser = new FrameDecoder();
  child.stdout.on("data", (bytes) =>
    parser.push(bytes, (message) => {
      messages.push(message);
      const call = message.id ? pending.get(message.id) : undefined;
      if (!call) return;
      pending.delete(message.id!);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error("native_policy_refusal"));
      else call.resolve(message.result);
    })
  );
  child.stderr.on("data", (bytes) => {
    if (stderr.length < 4096) stderr += bytes.toString();
  });
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("native_closed"));
      }
      pending.clear();
      resolve(code);
    });
  });
  void closed.catch(() => {});
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return reject(new Error("native_closed"));
      const id = `request-${++counter}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("native_timeout"));
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  return {
    dir,
    profile,
    configFile,
    request,
    closed,
    messages,
    async ready() {
      const result = await request("initialize");
      await request("session/new", { cwd: dir });
      return result;
    },
    prompt(text = "inspect the test") {
      return request("session/prompt", { prompt: [{ type: "text", text }] });
    },
    async effects(): Promise<Record<string, unknown>[]> {
      try {
        return (await readFile(join(profile, "effects.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    async cleanup() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

test("owned Hermes guard preserves ACP negotiation and suppresses implicit native environment loading", async () => {
  const f = await fixture();
  try {
    const result = await f.ready();
    assert.equal(result.agentCapabilities.loadSession, false);
    assert.equal(result.agentCapabilities.sessionCapabilities.resume, null);
    assert.deepEqual(result._meta, {
      hermes: { preserved: true },
      tidy: {
        guardVersion: 5,
        approvalPolicy: "ask",
        environment: "explicit",
        ownedWorkers: "local-pipe-v1",
      },
    });
    assert.equal((await f.prompt()).stopReason, "end_turn");
    assert.deepEqual(
      (await f.effects()).map((effect) => effect.kind),
      ["new", "prompt"]
    );
    assert.ok(
      !(await f.request("fixture/environment")).keys.includes(
        "UNSCOPED_DOTENV_SECRET"
      )
    );
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard invalidates previous history before native work and refuses when invalidation fails", async () => {
  const f = await fixture({ checkpoints: true });
  try {
    await f.ready();
    const name =
      "hermes-history-" +
      createHash("sha256")
        .update(JSON.stringify(["fixture-binding", "native-one"]))
        .digest("hex") +
      ".json";
    const path = join(f.dir, name);
    await writeFile(path, "old checkpoint");
    const response = await f.prompt();
    assert.equal(response.stopReason, "end_turn");
    assert.deepEqual(response._meta.tidy.historyCheckpoint, {
      status: "unavailable",
    });
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await mkdir(path);
    const before = await f.effects();
    const refused = await f.prompt();
    assert.equal(refused.stopReason, "refusal");
    assert.equal(refused._meta.tidy.rejectedBeforePrompt, true);
    assert.equal(refused._meta.tidy.code, "continuity_unavailable");
    assert.deepEqual(await f.effects(), before);
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard reports authoritative final text without copying history or reasoning", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (let turn = 0; turn < 2; turn++) {
      const result = await f.prompt();
      assert.deepEqual(result._meta, {
        hermes: { preserved: true },
        tidy: {
          guardVersion: 5,
          historyCheckpoint: { status: "unavailable" },
          turnEvidence: {
            started: true,
            settled: true,
            failed: false,
            interrupted: false,
            observationsComplete: true,
            finalText: "Transformed final answer",
          },
        },
      });
      assert.ok(!JSON.stringify(result).includes("private"));
    }
  } finally {
    await f.cleanup();
  }
});

for (const text of [
  "[executor-error]",
  "[result-error]",
  "[malformed-result]",
]) {
  test(`Hermes guard preserves failed execution despite native end_turn: ${text}`, async () => {
    const f = await fixture();
    try {
      await f.ready();
      const result = await f.prompt(text);
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(result._meta.tidy.turnEvidence, {
        started: true,
        settled: true,
        failed: true,
        interrupted: false,
        observationsComplete: true,
      });
      assert.ok(!JSON.stringify(result).includes("private"));
      assert.equal((await f.prompt())._meta.tidy.turnEvidence.failed, false);
    } finally {
      await f.cleanup();
    }
  });
}

test("Hermes guard detects swallowed native notification failures", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const result = await f.prompt("[update-error]");
    assert.equal(result._meta.tidy.turnEvidence.settled, true);
    assert.equal(result._meta.tidy.turnEvidence.observationsComplete, false);
    assert.ok(!JSON.stringify(result).includes("private"));
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard retains interrupted native evidence independently of ACP stop reason", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const result = await f.prompt("[interrupted]");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result._meta.tidy.turnEvidence.interrupted, true);
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard refuses another prompt when the executor boundary never settled", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const result = await f.prompt("[executor-not-started]");
    assert.equal(result._meta.tidy.turnEvidence.settled, false);
    assert.equal((await f.prompt())._meta.tidy.code, "session_busy");
    assert.equal(
      (await f.effects()).filter((effect) => effect.kind === "prompt").length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

for (const mode of ["off", "smart", false, "auto", "dont_ask"]) {
  test(`Hermes guard refuses unsafe approval configuration ${JSON.stringify(mode)} before native creation`, async () => {
    const f = await fixture({ config: { approvals: { mode } } });
    try {
      assert.equal(await f.closed, 2);
      assert.deepEqual(await f.effects(), []);
      assert.deepEqual(f.messages, []);
    } finally {
      await f.cleanup();
    }
  });
}

test("Hermes guard revalidates changed and unreadable profile configuration before each prompt", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const contents of [
      '{"approvals":{"mode":"off"}}',
      "invalid yaml",
      "null",
    ]) {
      await writeFile(f.configFile, contents);
      const result = await f.prompt();
      assert.equal(result.stopReason, "refusal");
      assert.equal(result._meta.tidy.rejectedBeforePrompt, true);
    }
    await rm(f.configFile);
    assert.equal((await f.prompt()).stopReason, "refusal");
    await writeFile(f.configFile, '{"approvals":{"mode":"manual"}}');
    assert.equal((await f.prompt()).stopReason, "end_turn");
    assert.equal(
      (await f.effects()).filter((effect) => effect.kind === "prompt").length,
      1
    );
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard rejects native edit bypass modes, session approvals and late YOLO before prompting", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const mode of ["dont_ask", "accept_edits"]) {
      await f.request("fixture/state", { mode });
      assert.equal((await f.prompt()).stopReason, "refusal");
    }
    await f.request("fixture/state", {
      mode: "default",
      sessionAllow: ["dangerous operation"],
    });
    assert.equal((await f.prompt()).stopReason, "refusal");
    await f.request("fixture/state", { sessionAllow: [], yolo: "true" });
    assert.equal((await f.prompt()).stopReason, "refusal");
    assert.equal(
      (await f.effects()).filter((effect) => effect.kind === "prompt").length,
      0
    );
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard rejects policy-changing ACP controls and native slash commands without invoking them", async () => {
  const f = await fixture();
  try {
    await f.ready();
    await assert.rejects(f.request("session/set_mode", { modeId: "dont_ask" }));
    await assert.rejects(
      f.request("session/set_config_option", {
        configId: "edit_approval_policy",
        value: "session",
      })
    );
    for (const text of ["/yolo", "  /model changed", "/reset", "   "])
      assert.equal((await f.prompt(text)).stopReason, "refusal");
    assert.deepEqual(
      (await f.effects()).map((effect) => effect.kind),
      ["new"]
    );
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard refuses inherited gateway credentials, persistent allowlists and unsupported runtime versions", async () => {
  for (const options of [
    { environment: { TIDY_PRIVATE_CREDENTIAL: "dummy-not-a-real-key" } },
    { config: { approvals: { mode: "manual" }, command_allowlist: ["*"] } },
    { version: "0.0.0" },
    { isolate: false },
  ]) {
    const f = await fixture(options);
    try {
      assert.equal(await f.closed, 2);
      assert.deepEqual(await f.effects(), []);
    } finally {
      await f.cleanup();
    }
  }
});

test("Hermes guard cannot adopt profile configuration through an external symlink", async () => {
  const f = await fixture();
  try {
    await f.ready();
    await rm(f.configFile);
    const external = join(f.dir, "external.yaml");
    await writeFile(external, '{"approvals":{"mode":"manual"}}');
    await symlink(external, f.configFile);
    assert.equal((await f.prompt()).stopReason, "refusal");
    assert.equal(
      (await f.effects()).filter((effect) => effect.kind === "prompt").length,
      0
    );
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard refuses unknown session references and cold-load methods without native restoration", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const result = await f.request("session/prompt", {
      sessionId: "old-session",
      prompt: [{ type: "text", text: "hello" }],
    });
    assert.equal(result._meta.tidy.rejectedBeforePrompt, true);
    for (const method of ["session/load", "session/resume", "session/fork"])
      await assert.rejects(
        f.request(method, { sessionId: "old-session", cwd: f.dir })
      );
    await f.request("fixture/state", { evict: true });
    assert.equal((await f.prompt())._meta.tidy.rejectedBeforePrompt, true);
    assert.deepEqual(
      (await f.effects()).map((effect) => effect.kind),
      ["new"]
    );
  } finally {
    await f.cleanup();
  }
});

test("unimplemented PTY and remote worker ownership refuse before native registry effects", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const mode of ["pty", "remote"])
      await assert.rejects(f.request("fixture/unsupported-worker", { mode }));
    assert.ok(
      !(await f.effects()).some((entry) =>
        ["registry_spawn", "unowned_remote"].includes(String(entry.kind))
      )
    );
  } finally {
    await f.cleanup();
  }
});

test("native callback receipts correlate exact command and edit decisions after consumption", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const edit of [false, true])
      for (const choice of ["allow_once", "deny"]) {
        const result = await f.request("fixture/callback", { edit, choice });
        assert.equal(
          result.nativeResult,
          edit
            ? choice === "allow_once"
            : choice === "allow_once"
              ? "once"
              : "deny"
        );
      }
    const effects = await f.effects();
    const identities = effects
      .filter((effect) => effect.kind === "permission_identity")
      .map((effect) => (effect.tidy as any).permissionId);
    const receipts = effects.filter(
      (effect) => effect.kind === "permission_receipt"
    );
    assert.equal(new Set(identities).size, 4);
    assert.deepEqual(
      receipts.map((receipt) => receipt.permissionId),
      identities
    );
    assert.deepEqual(
      receipts.map((receipt) => receipt.optionId),
      ["allow_once", "deny", "allow_once", "deny"]
    );
    assert.ok(
      receipts.every(
        (receipt) =>
          receipt.sessionId === "native-one" &&
          receipt.evidence === "native_callback_returned"
      )
    );
  } finally {
    await f.cleanup();
  }
});

test("native permission timeout and failed receipt delivery cannot produce applied evidence or leak an allow", async () => {
  const f = await fixture();
  try {
    await f.ready();
    for (const edit of [false, true]) {
      // A response exists, but the worker never reads it after timing out.
      for (const choice of ["allow_once", "deny"])
        await f.request("fixture/callback", { edit, choice, mode: "timeout" });
      await assert.rejects(
        f.request("fixture/callback", { edit, mode: "automatic" })
      );
      await assert.rejects(
        f.request("fixture/callback", { edit, failReceipts: true })
      );
    }
    const effects = await f.effects();
    assert.equal(
      effects.filter((effect) => effect.kind === "permission_receipt").length,
      0
    );
    assert.ok(
      effects
        .filter((effect) => effect.kind === "callback_returned")
        .every((effect) =>
          [false, "timeout"].includes(effect.nativeResult as any)
        )
    );
  } finally {
    await f.cleanup();
  }
});

test("native Hermes permission bridge exposes only one-time options and rejects a broader returned choice", async () => {
  const f = await fixture();
  try {
    await f.ready();
    await assert.rejects(
      f.request("fixture/permission", { choice: "allow_session" })
    );
    await assert.rejects(
      f.request("fixture/permission", { choice: "allow_always" })
    );
    await f.request("fixture/permission", { choice: "allow_once" });
    await f.request("fixture/permission", { choice: "deny" });
    const effects = await f.effects();
    assert.deepEqual(
      effects
        .filter((effect) => effect.kind === "permission_consumed")
        .map((effect) => effect.choice),
      ["allow_once", "deny"]
    );
    assert.ok(
      effects
        .filter((effect) => effect.kind === "permission_options")
        .every(
          (effect) =>
            JSON.stringify(effect.options) ===
            JSON.stringify(["allow_once", "deny"])
        )
    );
  } finally {
    await f.cleanup();
  }
});

test("Hermes guard passes inline image-only prompts to the native boundary and refuses URI or malformed images", async () => {
  const f = await fixture();
  try {
    await f.ready();
    const { PNG } = createRequire(import.meta.url)("pngjs");
    const data = PNG.sync
      .write({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) })
      .toString("base64");
    const image = { type: "image", mimeType: "image/png", data };
    const accepted = await f.request("session/prompt", { prompt: [image] });
    assert.equal(accepted.stopReason, "end_turn");
    assert.equal(accepted._meta.tidy.turnEvidence.started, true);
    for (const prompt of [
      [{ ...image, uri: "https://example.invalid/private" }],
      [{ ...image, data: "!" }],
      [{ ...image, mimeType: "image/svg+xml" }],
      [{ ...image, data: Buffer.from("bad").toString("base64") }],
      [image, image],
      [{ type: "text", text: "/reset" }, image],
    ]) {
      const rejected = await f.request("session/prompt", { prompt });
      assert.equal(rejected.stopReason, "refusal");
      assert.equal(rejected._meta.tidy.rejectedBeforePrompt, true);
    }
    const effects = await f.effects();
    assert.equal(
      effects.filter((effect) => effect.kind === "prompt").length,
      1
    );
    const native = effects.find(
      (effect) => effect.kind === "native_image_input"
    )!;
    assert.deepEqual(native.content, [
      { type: "text", text: "" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${data}` },
      },
    ]);
  } finally {
    await f.cleanup();
  }
});
