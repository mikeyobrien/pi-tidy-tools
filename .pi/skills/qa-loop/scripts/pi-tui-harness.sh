#!/usr/bin/env bash
set -euo pipefail

root="${PI_TIDY_QA_ROOT:-/tmp/pi-tidy-qa}"
[[ "$root" = /* ]] || { echo "PI_TIDY_QA_ROOT must be absolute" >&2; exit 2; }
case "$root" in /tmp/pi-tidy-qa|/tmp/pi-tidy-qa-*) ;; *) echo "PI_TIDY_QA_ROOT must be /tmp/pi-tidy-qa or /tmp/pi-tidy-qa-*" >&2; exit 2;; esac
sessions="$root/sessions"
artifacts="$root/artifacts"
qa_home="$root/home"
agent_dir="$root/agent"
state_dir="$root/state"
session_file="$state_dir/session-id"
export AGENT_TTY_HOME="$root/agent-tty"
source_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
playwright_browsers_path="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

usage() {
  cat >&2 <<'EOF'
Usage: pi-tui-harness.sh <command> [args]

  preflight                         Verify agent-tty 0.5.0, Node 24-26, renderers, and Pi
  reset                             Destroy the session and remove isolated QA state

Set PI_TIDY_QA_ROOT=/tmp/pi-tidy-qa-<run> to isolate concurrent QA runs.
  start [cols] [rows] [pi args...]  Start Pi (defaults: 120 36)
  send <text>                       Type literal text and press Enter
  key <key> [...]                   Send keys such as C-o, C-c, Escape
  resize <cols> <rows>              Resize the real terminal viewport
  wait <rendered-regex> [seconds]   Wait on Ghostty-rendered screen state (default: 30)
  capture <name>                    Save native Ghostty PNG and semantic text evidence
  stop                              Capture final state, destroy the session, and clear its ID
EOF
}

emit() {
  local command="$1" result="${2:-}"
  [[ -n "$result" ]] || result='{}'
  COMMAND_NAME="$command" RESULT_JSON="$result" node --input-type=module - <<'NODE'
const result = JSON.parse(process.env.RESULT_JSON);
console.log(JSON.stringify({ ok: true, command: process.env.COMMAND_NAME, timestamp: new Date().toISOString(), result }));
NODE
}

json_value() {
  local path="$1"
  JSON_PATH="$path" node --input-type=module -e '
let text = ""; for await (const chunk of process.stdin) text += chunk;
let value = JSON.parse(text); for (const key of process.env.JSON_PATH.split(".")) value = value[key];
if (typeof value === "object") process.stdout.write(JSON.stringify(value)); else process.stdout.write(String(value));'
}

tty() { command agent-tty --home "$AGENT_TTY_HOME" "$@"; }
session_id() { [[ -s "$session_file" ]] && cat "$session_file"; }
alive() {
  local sid response
  sid="$(session_id 2>/dev/null || true)"; [[ -n "$sid" ]] || return 1
  response="$(tty inspect "$sid" --json 2>/dev/null)" || return 1
  [[ "$(printf '%s' "$response" | json_value result.session.status)" == "running" ]]
}
destroy_session() {
  local sid
  sid="$(session_id 2>/dev/null || true)"
  if [[ -n "$sid" ]] && tty inspect "$sid" --json >/dev/null 2>&1; then
    tty destroy "$sid" --json >/dev/null 2>&1 || tty destroy "$sid" --force --json >/dev/null
  fi
  rm -f -- "$session_file"
}
assert_dimensions() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ && "${2:-}" =~ ^[1-9][0-9]*$ ]] || { usage; exit 2; }
}
map_key() {
  case "$1" in
    C-?) printf 'Ctrl+%s' "$(printf '%s' "${1#C-}" | tr '[:lower:]' '[:upper:]')" ;;
    *) printf '%s' "$1" ;;
  esac
}

command_name="${1:-}"
[[ -n "$command_name" ]] || { usage; exit 2; }
shift

case "$command_name" in
  preflight)
    command -v agent-tty >/dev/null || { echo 'agent-tty is required as an external QA prerequisite' >&2; exit 1; }
    command -v pi >/dev/null || { echo 'pi is required' >&2; exit 1; }
    command -v node >/dev/null || { echo 'Node is required' >&2; exit 1; }
    [[ -f "$source_agent_dir/settings.json" ]] || { echo 'source Pi settings are unavailable' >&2; exit 1; }
    mkdir -p "$AGENT_TTY_HOME"
    version_json="$(tty version --json)"
    doctor_json="$(tty doctor --json)"
    VERSION_JSON="$version_json" DOCTOR_JSON="$doctor_json" node --input-type=module - <<'NODE'
const version = JSON.parse(process.env.VERSION_JSON);
const doctor = JSON.parse(process.env.DOCTOR_JSON);
if (version.result.cliVersion !== "0.5.0") throw new Error(`QA requires agent-tty 0.5.0, found ${version.result.cliVersion}`);
const match = /^v(\d+)\./.exec(version.result.runtime?.node ?? "");
if (!match || Number(match[1]) < 24 || Number(match[1]) >= 27) throw new Error(`QA requires agent-tty on Node 24-26, found ${version.result.runtime?.node ?? "unknown"}`);
if (!doctor.result?.ok) throw new Error("agent-tty doctor failed");
const required = ["snapshot", "wait", "screenshot", "record-export-asciicast", "record-export-webm", "dashboard"];
const capabilities = new Map(doctor.result.capabilities.map(({ name, status }) => [name, status]));
const missing = required.filter((name) => capabilities.get(name) !== "available");
if (missing.length) throw new Error(`agent-tty capabilities unavailable: ${missing.join(", ")}`);
NODE
    pi_version="$(pi --version)"
    result="$(VERSION_JSON="$version_json" DOCTOR_JSON="$doctor_json" PI_VERSION="$pi_version" ROOT="$root" node --input-type=module -e '
const version = JSON.parse(process.env.VERSION_JSON).result;
const doctor = JSON.parse(process.env.DOCTOR_JSON).result;
process.stdout.write(JSON.stringify({driver:"agent-tty",agentTtyVersion:version.cliVersion,nodeVersion:version.runtime.node,piVersion:process.env.PI_VERSION,capabilities:doctor.capabilities,agentTtyHome:`${process.env.ROOT}/agent-tty`,sessionDir:`${process.env.ROOT}/sessions`,externalPrerequisite:true}));')"
    emit preflight "$result"
    ;;
  reset)
    destroy_session
    case "$root" in /tmp/pi-tidy-qa|/tmp/pi-tidy-qa-*) rm -rf -- "$root" ;; *) echo "refusing unsafe QA root: $root" >&2; exit 2 ;; esac
    result="$(ROOT="$root" node -e 'process.stdout.write(JSON.stringify({removed:process.env.ROOT}))')"
    emit reset "$result"
    ;;
  start)
    cols="${1:-120}"; rows="${2:-36}"; assert_dimensions "$cols" "$rows"
    shift $(( $# >= 2 ? 2 : $# ))
    mkdir -p "$sessions" "$artifacts" "$qa_home" "$agent_dir" "$state_dir" "$AGENT_TTY_HOME"
    destroy_session
    [[ ! -f "$source_agent_dir/auth.json" ]] || cp -- "$source_agent_dir/auth.json" "$agent_dir/auth.json"
    SOURCE_SETTINGS="$source_agent_dir/settings.json" QA_SETTINGS="$agent_dir/settings.json" QA_REPO="$PWD" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const source = JSON.parse(readFileSync(process.env.SOURCE_SETTINGS, "utf8"));
const settings = {
  packages: [process.env.QA_REPO, join(process.env.QA_REPO, "packages/pi-tidy-subagents")],
  defaultProvider: source.defaultProvider,
  defaultModel: source.defaultModel,
  defaultThinkingLevel: source.defaultThinkingLevel,
  theme: source.theme,
  hideThinkingBlock: source.hideThinkingBlock,
  quietStartup: false,
};
writeFileSync(process.env.QA_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
NODE
    create_json="$(tty create --cwd "$PWD" --cols "$cols" --rows "$rows" --name pi-tidy-qa \
      --env "HOME=$qa_home" --env "PI_CODING_AGENT_DIR=$agent_dir" --env "PLAYWRIGHT_BROWSERS_PATH=$playwright_browsers_path" --json -- \
      pi --session-dir "$sessions" --approve "$@")"
    sid="$(printf '%s' "$create_json" | json_value result.sessionId)"
    printf '%s\n' "$sid" > "$session_file"
    result="$(SID="$sid" COLS="$cols" ROWS="$rows" ROOT="$root" node -e 'process.stdout.write(JSON.stringify({sessionId:process.env.SID,cols:Number(process.env.COLS),rows:Number(process.env.ROWS),agentTtyHome:`${process.env.ROOT}/agent-tty`,sessionDir:`${process.env.ROOT}/sessions`}))')"
    emit start "$result"
    ;;
  send)
    alive || { echo 'QA session is not running' >&2; exit 1; }
    response="$(tty type "$(session_id)" "$*" --append-newline --json)"
    emit send "$(printf '%s' "$response" | json_value result)"
    ;;
  key)
    alive || { echo 'QA session is not running' >&2; exit 1; }
    (( $# > 0 )) || { usage; exit 2; }
    keys=(); for key in "$@"; do keys+=("$(map_key "$key")"); done
    response="$(tty send-keys "$(session_id)" "${keys[@]}" --json)"
    emit key "$(printf '%s' "$response" | json_value result)"
    ;;
  resize)
    alive || { echo 'QA session is not running' >&2; exit 1; }
    assert_dimensions "${1:-}" "${2:-}"
    response="$(tty resize "$(session_id)" --cols "$1" --rows "$2" --json)"
    emit resize "$(printf '%s' "$response" | json_value result)"
    ;;
  wait)
    alive || { echo 'QA session is not running' >&2; exit 1; }
    pattern="${1:?missing rendered regex}"; timeout="${2:-30}"
    [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || { usage; exit 2; }
    response="$(tty wait "$(session_id)" --regex "$pattern" --timeout "$((timeout * 1000))" --json)"
    emit wait "$(printf '%s' "$response" | json_value result)"
    ;;
  capture)
    alive || { echo 'QA session is not running' >&2; exit 1; }
    name="${1:?missing capture name}"
    [[ "$name" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo 'capture name must be filename-safe' >&2; exit 2; }
    mkdir -p "$artifacts"
    snapshot="$(tty snapshot "$(session_id)" --format text --include-scrollback --json)"
    screenshot="$(tty screenshot "$(session_id)" --hide-cursor --json)"
    text_path="$artifacts/$name.txt"; png_path="$artifacts/$name.png"
    SNAPSHOT="$snapshot" node --input-type=module -e 'const data=JSON.parse(process.env.SNAPSHOT); process.stdout.write(`${data.result.text}\n`)' > "$text_path"
    source_png="$(printf '%s' "$screenshot" | json_value result.artifactPath)"
    cp -- "$source_png" "$png_path"
    result="$(SNAPSHOT="$snapshot" SCREENSHOT="$screenshot" TEXT_PATH="$text_path" PNG_PATH="$png_path" node --input-type=module -e '
const snapshot=JSON.parse(process.env.SNAPSHOT).result, screenshot=JSON.parse(process.env.SCREENSHOT).result;
process.stdout.write(JSON.stringify({textPath:process.env.TEXT_PATH,pngPath:process.env.PNG_PATH,cols:snapshot.cols,rows:snapshot.rows,screenHash:snapshot.screenHash,rendererBackend:screenshot.rendererBackend,sha256:screenshot.sha256}));')"
    emit capture "$result"
    ;;
  stop)
    if alive; then
      status=0; "$0" capture final >/dev/null || status=$?
      destroy_session
      (( status == 0 )) || exit "$status"
    else
      rm -f -- "$session_file"
    fi
    emit stop '{"destroyed":true}'
    ;;
  *) usage; exit 2 ;;
esac
