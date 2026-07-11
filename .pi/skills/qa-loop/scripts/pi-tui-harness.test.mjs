import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const harness = new URL("./pi-tui-harness.sh", import.meta.url).pathname;

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "pi-tui-harness-"));
  const bin = join(temp, "bin");
  const sourceAgent = join(temp, "source-agent");
  await mkdir(bin); await mkdir(sourceAgent);
  await writeFile(join(sourceAgent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake/model", theme: "dark" }));
  await writeFile(join(sourceAgent, "auth.json"), "{}\n");
  await writeFile(join(bin, "pi"), "#!/bin/sh\n[ \"$1\" = --version ] && { echo '0.80.6'; exit; }\nexit 99\n");
  await writeFile(join(bin, "agent-tty"), `#!/bin/sh
set -eu
printf '%s\\n' "HOME=$AGENT_TTY_HOME ARGS=$*" >> "$FAKE_LOG"
while [ "$#" -gt 0 ]; do case "$1" in --home) shift 2;; --renderer|--profile|--timeout-ms|--log-level) shift 2;; --no-color) shift;; *) break;; esac; done
cmd="$1"; shift
case "$cmd" in
 version) printf '%s\\n' '{"ok":true,"command":"version","result":{"cliVersion":"0.5.0","runtime":{"node":"v24.18.0"}}}' ;;
 doctor) printf '%s\\n' '{"ok":true,"command":"doctor","result":{"ok":true,"capabilities":[{"name":"snapshot","status":"available"},{"name":"wait","status":"available"},{"name":"screenshot","status":"available"},{"name":"record-export-asciicast","status":"available"},{"name":"record-export-webm","status":"available"},{"name":"dashboard","status":"available"}]}}' ;;
 create) printf '%s\\n' '{"ok":true,"command":"create","result":{"sessionId":"fixture-session"}}' ;;
 inspect) printf '%s\\n' '{"ok":true,"command":"inspect","result":{"session":{"status":"running"}}}' ;;
 type|send-keys|resize|wait|destroy) printf '{"ok":true,"command":"%s","result":{"accepted":true}}\\n' "$cmd" ;;
 snapshot) printf '%s\\n' '{"ok":true,"command":"snapshot","result":{"text":"fixture screen","cols":120,"rows":36,"screenHash":"abc"}}' ;;
 screenshot) artifact="$AGENT_TTY_HOME/native.png"; printf png > "$artifact"; printf '{"ok":true,"command":"screenshot","result":{"artifactPath":"%s","rendererBackend":"ghostty-web","sha256":"fixture-sha"}}\\n' "$artifact" ;;
 *) exit 98 ;;
esac
`);
  await chmod(join(bin, "pi"), 0o755); await chmod(join(bin, "agent-tty"), 0o755);
  return { temp, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: sourceAgent, FAKE_LOG: join(temp, "calls.log") } };
}

function invoke(args, env, expected = 0) {
  const result = spawnSync(harness, args, { cwd: resolve(dirname(harness), "../../../.."), env, encoding: "utf8" });
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  if (result.stdout.trim()) assert.equal(JSON.parse(result.stdout).ok, true);
  return result;
}

test("canonical wrapper drives an isolated agent-tty lifecycle and native evidence", async () => {
  const { env } = await fixture();
  invoke(["reset"], env); invoke(["preflight"], env); invoke(["start", "120", "36", "--offline"], env);
  invoke(["send", "hello world"], env); invoke(["key", "C-o", "Escape"], env);
  invoke(["resize", "72", "24"], env); invoke(["wait", "ready.*", "2"], env);
  const capture = JSON.parse(invoke(["capture", "proof"], env).stdout).result;
  assert.equal(capture.textPath, "/tmp/pi-tidy-qa/artifacts/proof.txt");
  assert.equal(capture.pngPath, "/tmp/pi-tidy-qa/artifacts/proof.png");
  assert.equal(await readFile(capture.textPath, "utf8"), "fixture screen\n");
  assert.equal(await readFile(capture.pngPath, "utf8"), "png");
  invoke(["stop"], env);
  const log = await readFile(env.FAKE_LOG, "utf8");
  assert.match(log, /HOME=\/tmp\/pi-tidy-qa\/agent-tty/);
  assert.doesNotMatch(log, /tmux/);
  assert.match(log, /ARGS=.*create.*--cols 120 --rows 36/);
  assert.match(log, /ARGS=.*type fixture-session hello world --append-newline --json/);
  assert.match(log, /ARGS=.*send-keys fixture-session Ctrl\+O Escape --json/);
  assert.match(log, /ARGS=.*wait fixture-session --regex ready\.\* --timeout 2000 --json/);
  assert.match(log, /ARGS=.*screenshot fixture-session --hide-cursor --json/);
  assert.match(log, /ARGS=.*destroy fixture-session --json/);
});

test("preflight rejects any agent-tty version other than 0.5.0", async () => {
  const { env, temp } = await fixture();
  const cli = join(temp, "bin", "agent-tty");
  const source = await readFile(cli, "utf8");
  await writeFile(cli, source.replace('"cliVersion":"0.5.0"', '"cliVersion":"0.5.1"'));
  assert.match(invoke(["preflight"], env, 1).stderr, /requires agent-tty 0\.5\.0/);
});
