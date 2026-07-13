#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[4]
FIXTURE = Path(__file__).with_name("background-agents-fixture.mjs")
OUTPUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="background-agents-visual-")) / "background-agents.png"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
qa_root = Path(tempfile.mkdtemp(prefix="agent-tty-background-", dir="/tmp"))
fixture_package = qa_root / "package"
shutil.copytree(ROOT / "packages/pi-tidy-subagents", fixture_package)
global_modules = Path(subprocess.run(["npm", "root", "-g"], text=True, capture_output=True, check=True).stdout.strip())
pi_modules = global_modules / "@earendil-works/pi-coding-agent/node_modules"
(fixture_package / "node_modules/@earendil-works").mkdir(parents=True)
(fixture_package / "node_modules/@earendil-works/pi-tui").symlink_to(pi_modules / "@earendil-works/pi-tui", target_is_directory=True)
env = {
    **os.environ,
    "AGENT_TTY_HOME": str(qa_root / "agent-tty"),
    "PI_TIDY_SUBAGENTS_FIXTURE_PACKAGE": str(fixture_package),
}

def tty(*args):
    args = list(args)
    args.insert(args.index("--") if "--" in args else len(args), "--json")
    result = subprocess.run(["agent-tty", *args], cwd=ROOT, env=env, text=True, capture_output=True, check=True)
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is True, envelope
    return envelope["result"]

sid = None
try:
    doctor = tty("doctor")
    capabilities = {item["name"]: item["status"] for item in doctor["capabilities"]}
    assert capabilities["snapshot"] == "available"
    assert capabilities["screenshot"] == "available"
    sid = tty(
        "create", "--cwd", str(ROOT), "--cols", "110", "--rows", "50", "--",
        shutil.which("npx"), "--no-install", "tsx", str(FIXTURE),
    )["sessionId"]
    tty("wait", sid, "--text", "Session subagents", "--timeout", "10000")
    snapshot = tty("snapshot", sid, "--format", "text")
    screen = snapshot["text"]
    for expected in [
        "BACKGROUND WIDGET", "queued-bg", "running-bg", "manual", "2 steer",
        "DURABLE HANDOFF STAMP", "background handoff",
        "EXPANDED TERMINAL STAMP", "background terminal", "provider failed",
        "MANAGEMENT OVERLAY", "Session subagents", "Active foreground", "Active background", "Terminal uncollected",
        "╰", "NARROW VIEWPORT", "expanded",
    ]:
        assert expected in screen, (expected, screen)
    shot = tty("screenshot", sid, "--hide-cursor")
    assert shot["rendererBackend"] == "ghostty-web"
    shutil.copy2(shot["artifactPath"], OUTPUT)
finally:
    if sid:
        tty("destroy", sid, "--force")
    shutil.rmtree(qa_root, ignore_errors=True)

image = Image.open(OUTPUT).convert("RGB")
assert image.size == (880, 800), image.size
colors = image.getcolors(maxcolors=image.width * image.height)
assert colors is not None and len(colors) > 8, len(colors or [])
print(json.dumps({"ok": True, "png": str(OUTPUT), "size": list(image.size), "semanticLines": len(screen.splitlines()), "distinctColors": len(colors)}, sort_keys=True))
