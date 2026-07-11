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

OUT_HTML="docs/comparison.html"
OUT_PNG="docs/comparison.png"
TMP_BASE="$(mktemp -t pi-tidy-comparison.XXXXXX)"
TMP_PNG="${TMP_BASE}.png"
trap 'rm -f "$TMP_BASE" "$TMP_PNG" "$OUT_HTML"' EXIT

printf '%s\n' '→ generating native versus tidy comparison'
npx tsx docs/comparison-html.ts > "$OUT_HTML"
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=2800,1100 \
  --default-background-color=00000000 \
  --screenshot="$TMP_PNG" \
  "file://$PWD/$OUT_HTML" >/dev/null 2>&1
magick "$TMP_PNG" -trim +repage -bordercolor none -border 12 "$OUT_PNG"
printf '✓ wrote %s\n' "$OUT_PNG"
