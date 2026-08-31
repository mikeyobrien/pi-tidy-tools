import assert from "node:assert/strict";
import test from "node:test";

// Hermetic smoke: boots the real fleet daemon + real `pi --mode rpc` children in a
// temp fleet dir. Gated behind PI_TIDY_BOTS_REAL_SMOKE=1 (repo convention), because
// it needs the pi binary and provider credentials.
const enabled = process.env.PI_TIDY_BOTS_REAL_SMOKE === "1";

test(
  "fleet daemon boots fixture bots, accepts a message, serves roster",
  { skip: !enabled },
  async () => {
    const { startFleet } = await import("../src/daemon.ts");
    const fleetDir = new URL(
      "./fixtures/fleet/",
      import.meta.url
    ).pathname.replace(/\/$/, "");
    const port = 4591;
    const lines: string[] = [];
    const handle = await startFleet({
      dir: fleetDir,
      port,
      host: "127.0.0.1",
      log: (line) => lines.push(line),
    });

    try {
      const base = `http://127.0.0.1:${port}`;

      // Race the boot window on purpose: the first message goes out the moment
      // the fleet listens, before the fixture bots finish their boot probes.
      // It must land once, cleanly — no "already processing" conflict and no
      // misread interrupted-turn resume.
      const accepted = await fetch(`${base}/api/bots/atlas/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Say 'ready' and nothing else." }),
      });
      assert.equal(accepted.status, 200);

      const fleet = await fetch(`${base}/api/fleet`).then((r) => r.json());
      assert.equal(fleet.bots.length, 2);
      assert.deepEqual(fleet.bots.map((bot: any) => bot.name).sort(), [
        "atlas",
        "forge",
      ]);

      // Unauthenticated bus send must be refused.
      const unauth = await fetch(`${base}/bus/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "atlas", target: "forge", message: "hi" }),
      });
      assert.equal(unauth.status, 401);

      // Wait briefly for the transcript to gain entries.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      const transcript = await fetch(`${base}/api/bots/atlas/transcript`).then(
        (r) => r.json()
      );
      assert.ok(
        transcript.transcript.length >= 1,
        "transcript captured at least the operator entry"
      );
    } finally {
      await handle.stop();
    }
    assert.ok(lines.some((line) => line.includes("serving on")));
    assert.ok(
      !lines.some((line) => line.includes("already processing")),
      "first message must not hit a mid-boot agent conflict"
    );
    assert.ok(
      !lines.some((line) => line.includes("interrupted-turn resume failed")),
      "an in-flight first message must not be misread as an interrupted turn"
    );
  }
);
