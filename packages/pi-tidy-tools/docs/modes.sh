#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)"
fi
[[ -n "$CHROME" ]] || { echo "error: Chrome/Chromium not found" >&2; exit 1; }
command -v magick >/dev/null || { echo "error: ImageMagick not found" >&2; exit 1; }

OUT_HTML="docs/modes.html"
OUT_PNG="docs/modes.png"
TMP_BASE="$(mktemp -t pi-tidy-modes.XXXXXX)"
TMP_PNG="${TMP_BASE}.png"
trap 'rm -f "$TMP_BASE" "$TMP_PNG"' EXIT

printf '%s\n' '→ generating layout comparison'
npx tsx docs/modes-html.ts > "$OUT_HTML"
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=2400,700 \
  --default-background-color=00000000 \
  --screenshot="$TMP_PNG" \
  "file://$PWD/$OUT_HTML" >/dev/null 2>&1
magick "$TMP_PNG" -trim +repage -bordercolor none -border 12 "$OUT_PNG"
printf '✓ wrote %s\n' "$OUT_PNG"
