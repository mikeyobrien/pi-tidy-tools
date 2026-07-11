#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)"
[[ -n "$CHROME" ]] || { echo "Chrome/Chromium required" >&2; exit 1; }
npx tsx docs/visual-html.ts > docs/visual.html
TMP="$(mktemp --suffix=.png)"; trap 'rm -f "$TMP"' EXIT
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1800,1400 --default-background-color=00000000 --screenshot="$TMP" "file://$PWD/docs/visual.html" >/dev/null 2>&1
magick "$TMP" -trim +repage docs/visual.png
echo "wrote docs/visual.png"
