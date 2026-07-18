import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexBarPoller, parseCodexBarJson, runCodexBar } from "../codexbar.js";

const payload = (used = 28) =>
  JSON.stringify({
    provider: "codex",
    source: "cli",
    usage: {
      primary: {
        usedPercent: used,
        windowMinutes: 300,
        resetsAt: "2026-07-17T20:00:00Z",
      },
      secondary: { usedPercent: 59, windowMinutes: 10_080 },
      updatedAt: "2026-07-17T18:00:00Z",
    },
  });

async function withCodexBar(
  source: string | undefined,
  run: () => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tidy-codexbar-"));
  const previousPath = process.env.PATH;
  try {
    if (source !== undefined) {
      const executable = join(root, "codexbar");
      await writeFile(executable, source);
      await chmod(executable, 0o755);
    }
    process.env.PATH =
      source === undefined ? root : `${root}:${previousPath ?? ""}`;
    await run();
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

test("parses documented CodexBar object and array payloads", () => {
  const direct = parseCodexBarJson(payload());
  const array = parseCodexBarJson(`[${payload(140)}]`);
  assert.deepEqual(direct, {
    primary: {
      usedPercent: 28,
      windowMinutes: 300,
      resetsAt: "2026-07-17T20:00:00Z",
    },
    secondary: { usedPercent: 59, windowMinutes: 10_080 },
    updatedAt: "2026-07-17T18:00:00Z",
  });
  assert.equal(array.primary?.usedPercent, 100);
});

test("rejects malformed and provider-error payloads", () => {
  assert.throws(() => parseCodexBarJson("{}"), /no Codex provider/);
  assert.throws(
    () => parseCodexBarJson('{"provider":"codex","error":{}}'),
    /provider error/
  );
  assert.throws(
    () => parseCodexBarJson('{"provider":"codex","usage":{}}'),
    /no quota window/
  );
  assert.throws(() => parseCodexBarJson("not json"), SyntaxError);
});

test("poller caches the last good snapshot and deduplicates refreshes", async () => {
  let calls = 0;
  let release!: (value: string) => void;
  const runner = () => {
    calls += 1;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };
  const poller = new CodexBarPoller(runner, 60_000);
  const first = poller.refresh();
  const second = poller.refresh();
  assert.equal(calls, 1);
  release(payload());
  await Promise.all([first, second]);
  assert.equal(poller.snapshot?.primary?.usedPercent, 28);

  const failing = new CodexBarPoller(async () => {
    throw new Error("offline");
  });
  failing.snapshot = poller.snapshot;
  await failing.refresh();
  assert.equal(failing.snapshot?.primary?.usedPercent, 28);
  assert.equal(failing.lastError, "offline");
});

test("stop followed by start launches a fresh request without a false error", async () => {
  let calls = 0;
  const runner = (signal: AbortSignal) => {
    calls += 1;
    if (calls === 2) return Promise.resolve(payload(12));
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  const poller = new CodexBarPoller(runner, 60_000);
  poller.start(() => {});
  assert.equal(calls, 1);
  poller.stop();
  poller.start(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  assert.equal(poller.snapshot?.primary?.usedPercent, 12);
  assert.equal(poller.lastError, undefined);
  poller.stop();
});

test("parsing accepts partial windows and clamps negative usage", () => {
  const parsed = parseCodexBarJson(
    JSON.stringify({
      provider: "codex",
      usage: { primary: { usedPercent: -4 } },
    })
  );
  assert.deepEqual(parsed, { primary: { usedPercent: 0 } });
  assert.deepEqual(
    parseCodexBarJson(
      JSON.stringify({
        provider: "codex",
        usage: {
          primary: null,
          secondary: { usedPercent: 14, windowMinutes: 10_080 },
        },
      })
    ),
    { secondary: { usedPercent: 14, windowMinutes: 10_080 } }
  );
});

test("pre-aborted CodexBar requests do not spawn a process", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(() => runCodexBar(controller.signal), /stop/);
});

test("CodexBar process runner handles success and bounded failures", async () => {
  await withCodexBar(`#!/bin/sh\nprintf '%s' '${payload()}'\n`, async () => {
    assert.equal(
      parseCodexBarJson(await runCodexBar(new AbortController().signal, 500))
        .primary?.usedPercent,
      28
    );
  });

  // A complete payload is authoritative: the runner intentionally reaps the
  // process group immediately because CodexBar helpers can outlive stdout.
  await withCodexBar(
    `#!/bin/sh\nprintf '%s' '${payload(33)}'\nexit 2\n`,
    async () => {
      assert.equal(
        parseCodexBarJson(await runCodexBar(new AbortController().signal, 500))
          .primary?.usedPercent,
        33
      );
    }
  );

  await withCodexBar(
    "#!/bin/sh\necho 'credential detail' >&2\nexit 2\n",
    async () => {
      await assert.rejects(
        () => runCodexBar(new AbortController().signal, 500),
        /exited 2: credential detail/
      );
    }
  );

  await withCodexBar(
    '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(1_000_001));\n',
    async () => {
      await assert.rejects(
        () => runCodexBar(new AbortController().signal, 500),
        /exceeded 1 MB/
      );
    }
  );

  await withCodexBar("#!/bin/sh\nsleep 1\n", async () => {
    await assert.rejects(
      () => runCodexBar(new AbortController().signal, 10),
      /timed out after 10ms/
    );
    const controller = new AbortController();
    const request = runCodexBar(controller.signal, 500);
    controller.abort(new Error("cancelled"));
    await assert.rejects(() => request, /cancelled/);
  });

  await withCodexBar(undefined, async () => {
    await assert.rejects(
      () => runCodexBar(new AbortController().signal, 500),
      /ENOENT/
    );
  });
});
