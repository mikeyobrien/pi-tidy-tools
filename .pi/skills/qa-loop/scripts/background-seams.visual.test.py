#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).with_name("background-seams-fixture.mjs")
OUTPUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(tempfile.mkdtemp()) / "background-seams.png"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
Path("/tmp/pi-tidy-qa").mkdir(parents=True, exist_ok=True)
home = Path(tempfile.mkdtemp(prefix="agent-tty-seams-", dir="/tmp/pi-tidy-qa"))
env = {**os.environ, "AGENT_TTY_HOME": str(home)}

def tty(*args):
    args = list(args)
    args.insert(args.index("--") if "--" in args else len(args), "--json")
    result = subprocess.run(["agent-tty", *args], cwd=ROOT, env=env, text=True, capture_output=True, check=True)
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is True
    return envelope["result"]

sid = None
try:
    doctor = tty("doctor")
    capabilities = {item["name"]: item["status"] for item in doctor["capabilities"]}
    assert capabilities["screenshot"] == "available"
    sid = tty("create", "--cols", "40", "--rows", "5", "--", shutil.which("node"), str(FIXTURE))["sessionId"]
    tty("wait", sid, "--text", "ROW THREE", "--timeout", "10000")
    shot = tty("screenshot", sid, "--hide-cursor")
    assert shot["rendererBackend"] == "ghostty-web"
    shutil.copy2(shot["artifactPath"], OUTPUT)
finally:
    if sid:
        tty("destroy", sid, "--force")
    shutil.rmtree(home, ignore_errors=True)

image = Image.open(OUTPUT).convert("RGB")
width, height = image.size
assert (width, height) == (320, 80), (width, height)
# The intentionally blank third terminal row independently identifies the renderer's default background.
default = image.getpixel((width - 2, 40))
coverage = []
for y in range(height):
    count = sum(image.getpixel((x, y)) == default for x in range(width))
    coverage.append(count / width)
# Adjacent full-background rows occupy pixels 0..31. No page/default-colored horizontal seam may separate them.
assert max(coverage[:32]) < 0.05, coverage[:32]
# The intentional blank separator row remains visibly default-backed.
assert max(coverage[32:48]) > 0.95, coverage[32:48]
print(json.dumps({"ok": True, "png": str(OUTPUT), "size": [width, height], "defaultRgb": default, "maxDefaultCoverageAdjacentRows": max(coverage[:32]), "maxDefaultCoverageSeparator": max(coverage[32:48])}, sort_keys=True))
