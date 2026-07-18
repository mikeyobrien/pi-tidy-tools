import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexBarPoller,
  DEFAULT_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  parseCodexBarJson,
  runCodexBar,
} from "../codexbar.js";

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

test("exports stable polling defaults", () => {
  assert.equal(DEFAULT_POLL_MS, 300_000);
  assert.equal(DEFAULT_TIMEOUT_MS, 45_000);
});

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

test("parser validates window shapes and preserves only documented metadata", () => {
  assert.deepEqual(
    parseCodexBarJson(
      JSON.stringify([
        null,
        { provider: "other", usage: {} },
        {
          provider: "codex",
          error: false,
          usage: {
            primary: {
              usedPercent: 50.4,
              windowMinutes: "300",
              resetsAt: 123,
            },
            secondary: { usedPercent: 25, resetsAt: "later" },
            updatedAt: 123,
          },
        },
      ])
    ),
    {
      primary: { usedPercent: 50.4 },
      secondary: { usedPercent: 25, resetsAt: "later" },
    }
  );
  for (const usage of [null, "bad", 4]) {
    assert.throws(
      () => parseCodexBarJson(JSON.stringify({ provider: "codex", usage })),
      /no usage snapshot/
    );
  }
  for (const primary of [null, false, 4, { usedPercent: "1" }]) {
    assert.throws(
      () =>
        parseCodexBarJson(
          JSON.stringify({ provider: "codex", usage: { primary } })
        ),
      /no quota window/
    );
  }
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

test("poller reports updates exactly once and normalizes non-Error failures", async () => {
  let calls = 0;
  let updates = 0;
  const values: Array<string | Error> = [
    "bad value",
    new Error("broken"),
    payload(7),
  ];
  const poller = new CodexBarPoller(async () => {
    calls += 1;
    const value = values.shift();
    if (value instanceof Error) throw value;
    if (value === "bad value") throw value;
    return value!;
  }, 5);

  await poller.refresh(() => updates++);
  assert.equal(poller.lastError, "bad value");
  assert.equal(updates, 1);
  await poller.refresh(() => updates++);
  assert.equal(poller.lastError, "broken");
  assert.equal(updates, 2);
  await poller.refresh(() => updates++);
  assert.equal(poller.snapshot?.primary?.usedPercent, 7);
  assert.equal(poller.lastError, undefined);
  assert.equal(updates, 3);
  assert.equal(calls, 3);

  poller.start(() => updates++);
  poller.start(() => (updates += 100));
  await new Promise((resolve) => setTimeout(resolve, 12));
  poller.stop();
  assert.ok(calls >= 5);
  assert.ok(updates >= 5 && updates < 100);
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

test("CodexBar process invocation uses the documented arguments and environment", async () => {
  const expected =
    "usage --provider codex --source cli --format json --json-only --no-color";
  const script = `#!/bin/sh
if [ "$*" != "${expected}" ]; then echo "bad args: $*" >&2; exit 9; fi
if [ "$NO_COLOR|$TERM|$COLUMNS" != "1|dumb|80" ]; then echo "bad env" >&2; exit 9; fi
printf '%s' '${payload(44)}'
`;
  await withCodexBar(script, async () => {
    const parsed = parseCodexBarJson(
      await runCodexBar(new AbortController().signal, 500)
    );
    assert.equal(parsed.primary?.usedPercent, 44);
  });
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
