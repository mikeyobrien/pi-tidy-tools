#!/usr/bin/env node
/**
 * Adversarial-content layout probe (issue 52).
 *
 * One command: boots a real fleet daemon (port 0, stub children, seeded
 * adversarial transcript), serves the console through a local reverse proxy
 * with an injected measurement script, and drives headless Chrome at
 * 390 / 768 / desktop viewports.
 *
 * Fails (exit 1) when any text-bearing element is narrower than 40px while
 * holding more than 20 characters of text — the "one word per line" / squeezed
 * column class of layout bugs.
 *
 * Modes:
 *   node scripts/probe-console-layout.mjs             # current tree: must pass (exit 0)
 *   PROBE_BASELINE=1 node scripts/...                 # serves style.css with
 *     d20af89's step-row collapse fix reverted; violations are EXPECTED, so
 *     the probe "passes" only when it detects them (exit 1 = regressions seen).
 *
 * Env: PROBE_CHROME=/path/to/chrome, PI_TIDY_BOTS_PI_BIN=/path/to/stub,
 *      PROBE_KEEP=1 (keep temp fleet + logs for autopsy).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(repoRoot, "packages/pi-tidy-bots/src/cli.ts");
const baseline = process.env.PROBE_BASELINE === "1";
const keep = process.env.PROBE_KEEP === "1";

const VIEWPORTS = [
  { name: "390-mobile", width: 390, height: 844 },
  { name: "768-tablet", width: 768, height: 1024 },
  { name: "1440-desktop", width: 1440, height: 900 },
];

const log = (line) => console.log(line);
const die = (message, code = 1) => {
  console.error(`probe: ${message}`);
  process.exit(code);
};

// ── Fleet fixture ─────────────────────────────────────
function seedFleet(dir) {
  mkdirSync(join(dir, "bots", "probe-bot"), { recursive: true });
  // Unscoped bot: no `dir`, no persona file (ADR 0002) — children are stubbed.
  writeFileSync(
    join(dir, "bots.toml"),
    '[[bot]]\nname = "probe-bot"\ntitle = "Layout Probe"\n'
  );
  const longPath =
    "/Users/rook/Library/Application Support/very/deeply/nested/directory/structure/that/goes/on/and/on/forever/config.with-a-long-name.file";
  const longWord =
    "supercalifragilisticexpialidocious-dontsupercalifragilisticexpialidocious";
  const wideTable = [
    "| Column One | Column Two | Column Three | Column Four | Column Five | Column Six |",
    "| :--------- | :--------: | ------------ | ----------: | :---------: | ----------- |",
    "| alpha | bravo | charlie | delta | echo | foxtrot |",
    "| long-cell-content-that-keeps-going-and-going | b | c | d | e | f |",
  ].join("\n");
  const entries = [
    {
      id: "probe-1",
      role: "user",
      origin: "operator",
      delivering: false,
      text: `please audit ${longPath} and report`,
      ts: "2026-08-31T10:00:00.000Z",
    },
    {
      id: "probe-2",
      role: "assistant",
      origin: "bot",
      originFrom: "probe-bot",
      text: `Audited. Findings:\n\n- ${longWord}\n- ${longPath}\n\n| Layer | State | Depth | Owner | Since | Notes |\n| --- | :---: | --- | --- | --- | --- |\n| kernel | ok | 3 | root | 2020-01-01 | untouched |\n| shell | degraded | 2 | operator | 2026-08-01 | drifting |\n\n\`\`\`\n${longWord}\n\`\`\`\n\n[[action: this marker line must never render]]`,
      ts: "2026-08-31T10:01:00.000Z",
      parts: [
        { type: "text", text: "Audited. Findings:\n\n" },
        {
          type: "tool",
          toolCallId: "probe-tool-1",
          tool: "bash",
          reason: "audit the fleet layout on the longest possible path",
          label: "du -sh /Users/rook/Library/Application Support/very/deep",
          status: "ok",
          duration: 42,
          output: "1.2G\t/.",
        },
        {
          type: "text",
          text: `- ${longWord}\n- ${longPath}\n\n${wideTable}\n\n[[action: never render me]]`,
        },
      ],
      steps: [
        {
          name: "bash",
          reason: "audit the fleet layout on the longest possible path",
          label: "du -sh /Users/rook/Library/Application Support/very/deep",
          duration: 42,
        },
      ],
    },
    {
      id: "probe-3",
      role: "user",
      origin: "bot",
      originFrom: "maximilianariansson-von-lengthname",
      delivering: false,
      text: `handoff with an extremely long origin name and a very long briefing body: ${longWord} — ${longPath}`,
      ts: "2026-08-31T10:02:00.000Z",
    },
  ];
  const journalDir = join(dir, ".fleet", "transcripts");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(
    join(journalDir, "probe-bot.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
}

// ── CLI helpers ───────────────────────────────────────
function runCli(args) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PI_TIDY_BOTS_PI_BIN: stubPi,
      PI_TIDY_BOTS_REGISTRY: registry,
    },
  });
}

const tmp = mkdtempSync(join(tmpdir(), "ptb-probe-"));
const fleetDir = join(tmp, "fleet");
const registry = join(tmp, "fleets.json");
const stubPi = join(tmp, "stub-pi.sh");

function cleanup() {
  if (!keep) rmSync(tmp, { recursive: true, force: true });
}

// ── Boot the fleet (port 0 = OS-assigned) ─────────────
mkdirSync(fleetDir, { recursive: true });
seedFleet(fleetDir);
writeFileSync(stubPi, "#!/bin/sh\nsleep 3600\n");
spawnSync("chmod", ["+x", stubPi]);

log("booting fleet (stub children, port 0)…");
const start = runCli([
  "start",
  fleetDir,
  "--daemon",
  "--fleet",
  "probe-layout",
  "--port",
  "0",
  "--json",
]);
if (start.status !== 0) {
  cleanup();
  die(`fleet start failed (exit ${start.status}): ${start.stderr}`);
}
const readiness = JSON.parse(start.stdout.trim().split("\n").at(-1) ?? "{}");
if (!readiness.port) die(`readiness had no port: ${start.stdout}`);
const daemonBase = `http://127.0.0.1:${readiness.port}`;
log(`fleet serving on ${daemonBase} (pid ${readiness.pid})`);

// ── Chrome discovery ──────────────────────────────────
const chromeCandidates = [
  process.env.PROBE_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chrome) {
  cleanup();
  die(
    "no Chrome/Chromium found — set PROBE_CHROME=/path/to/chrome (layout probing needs a real engine)"
  );
}
log(`chrome: ${chrome}`);
// Watchdog: a hung headless session can never wedge the run past the
// worst-case budget (fleet boot 60s + 3 viewports x 30s chrome + slack).
const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
  console.error(`probe: watchdog — exceeded ${WATCHDOG_MS / 1000}s, exiting`);
  spawnSync("pkill", ["-9", "-f", "pathological-pi.mjs"]);
  process.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

// ── Reverse proxy with measurement injection ──────────
const measureScript = `
document.title = "PROBE:script-loaded";
window.onerror = function (message) {
  document.title = "PROBE-ERR:" + message;
};
(function () {
  function measure() {
    var violations = [];
    var excluded = { SCRIPT: 1, STYLE: 1, TITLE: 1, HEAD: 1, META: 1, LINK: 1, BR: 1 };
    for (var el of document.querySelectorAll("*")) {
      if (excluded[el.tagName]) continue;
      var chars = 0;
      for (var node of el.childNodes) {
        if (node.nodeType === 3) chars += node.textContent.trim().length;
      }
      if (chars <= 20) continue;
      var cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      var width = el.clientWidth || el.getBoundingClientRect().width;
      if (width > 0 && width < 40) {
        violations.push({
          tag: el.tagName,
          cls: String(el.className).slice(0, 60),
          width: Math.round(width),
          chars: chars,
          text: (el.textContent || "").trim().slice(0, 60)
        });
      }
    }
    document.title = "PROBE:" + JSON.stringify({
      viewport: innerWidth + "x" + innerHeight,
      violations: violations
    });
  }
  if (document.readyState === "complete") setTimeout(measure, 2500);
  else addEventListener("load", function () { setTimeout(measure, 2500); });
})();
`;

// Baseline mode: revert d20af89's step-row collapse fix so the probe can
// reproduce the pre-fix squeeze. Pinned to the exact declarations it added.
function baselineRevert(css) {
  return css
    .replace(/(\.step-name \{[^}]*?)min-width: 0;\n/, "$1")
    .replace(
      /(\.step-label \{[^}]*?)flex: 0 1 auto;\n\s*min-width: 0;\n\s*max-width: 45%;\n\s*overflow: hidden;\n\s*text-overflow: ellipsis;\n\s*white-space: nowrap;\n/,
      "$1"
    );
}

const proxy = createServer(async (req, res) => {
  try {
    const target = `${daemonBase}${req.url}`;
    const upstream = await fetch(target);
    const contentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";
    let body = Buffer.from(await upstream.arrayBuffer());
    if (
      req.url === "/" ||
      req.url.startsWith("/?") ||
      req.url.startsWith("/console")
    ) {
      let html = body.toString("utf8");
      if (!html.includes("/probe-inject.js"))
        html = html.replace(
          "</body>",
          '<script src="/probe-inject.js"></script></body>'
        );
      body = Buffer.from(html);
    }
    if (req.url.startsWith("/style.css") && baseline) {
      body = Buffer.from(baselineRevert(body.toString("utf8")));
    }
    if (req.url === "/probe-inject.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(measureScript);
      return;
    }
    res.writeHead(upstream.status, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(502);
    res.end(`probe proxy error: ${error.message}`);
  }
});

await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = proxy.address().port;
log(`proxy: http://127.0.0.1:${proxyPort} (baseline: ${baseline})`);

// ── Viewport runs ─────────────────────────────────────
const results = [];
for (const viewport of VIEWPORTS) {
  const consoleUrl = `http://127.0.0.1:${proxyPort}/?viewport=${viewport.name}`;
  // Async spawn: spawnSync would block the event loop and starve the proxy
  // (and the daemon log tee) for the whole headless window.
  const chunks = [];
  const child = spawn(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(tmp, "chrome-profile-" + viewport.name)}`,
      `--window-size=${viewport.width},${viewport.height}`,
      "--dump-dom",
      "--timeout=12000",
      consoleUrl,
    ],
    {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      killSignal: "SIGKILL",
    }
  );
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", () => {});
  const exited = await new Promise((resolve) => child.on("exit", resolve));
  const out = {
    stdout: Buffer.concat(chunks).toString("utf8"),
    status: exited,
  };
  const marker = (out.stdout ?? "").match(/<title>PROBE:([^<]*)<\/title>/);
  if (marker) {
    // dump-dom serializes the title with HTML entities — decode before parse.
    marker[1] = marker[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  if (!marker) {
    log(
      `${viewport.name}: NO MEASUREMENT — dom head: ${(out.stdout ?? "").slice(0, 200)} | stderr: ${(out.stderr ?? "").slice(0, 200)}`
    );
    results.push({
      viewport: viewport.name,
      error: "measurement did not run (title marker missing)",
    });
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(marker[1]);
  } catch (error) {
    log(
      `${viewport.name}: unparseable measurement — raw: ${marker[1].slice(0, 300)} (${error.message})`
    );
    results.push({ viewport: viewport.name, error: "unparseable measurement" });
    continue;
  }
  results.push({ viewport: viewport.name, ...parsed });
  log(`${viewport.name}: ${parsed.violations.length} violation(s)`);
}

// ── Report ────────────────────────────────────────────
for (const result of results) {
  const count = result.violations ? result.violations.length : -1;
  log(
    `\n== ${result.viewport}: ${count === -1 ? "ERROR" : count + " violation(s)"} ==`
  );
  if (result.error) log(`   ${result.error}`);
  for (const v of result.violations ?? []) {
    log(
      `   <${v.tag} class="${v.cls}"> width=${v.width}px chars=${v.chars} "${v.text}"`
    );
  }
}

const summary = {
  mode: baseline
    ? "baseline (d20af89 reverted — violations expected)"
    : "current tree",
  viewports: results.map((r) => ({
    viewport: r.viewport,
    violations: r.violations ? r.violations.length : "error",
  })),
};
log(`\nprobe summary: ${JSON.stringify(summary)}`);

const anyViolations = results.some(
  (r) => r.violations && r.violations.length > 0
);
const anyError = results.some((r) => r.error);

if (baseline) {
  // Baseline: violations are the EXPECTED proof that the probe reproduces
  // the pre-fix squeeze.
  if (anyViolations) {
    log("probe baseline OK: squeeze reproduced");
    cleanup();
    process.exit(0);
  }
  log("probe baseline FAILED: no violations detected on the reverted copy");
  cleanup();
  process.exit(1);
}

if (anyViolations) {
  log("probe FAILED: squeezed text detected on the current tree");
  cleanup();
  process.exit(1);
}
if (anyError) {
  log("probe FAILED: a viewport did not produce a measurement");
  cleanup();
  process.exit(1);
}
log("probe OK: no squeezed text at any viewport");
cleanup();
process.exit(0);
