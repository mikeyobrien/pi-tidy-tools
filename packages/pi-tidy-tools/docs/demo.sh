#!/usr/bin/env bash
# Regenerate docs/demo.png from REAL pi-tidy-tools renderer output.
#
# Pipeline: run the built-in tools for real → render via buildToolBlock →
# ANSI-to-HTML (window chrome + gradient backdrop) → headless-Chrome screenshot
# (proper color emoji + box-drawing, which `freeze` can't do) → crop to content.
#
# Requires: node/tsx, Google Chrome, ImageMagick (`magick`).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)"
fi
[[ -n "$CHROME" ]] || { echo "error: Chrome/Chromium not found" >&2; exit 1; }

OUT_HTML="docs/demo.html"
OUT_PNG="docs/demo.png"
TMP_BASE="$(mktemp -t pi-tidy-tools-demo.XXXXXX)"
TMP_PNG="${TMP_BASE}.png"
trap 'rm -f "$TMP_BASE" "$TMP_PNG"' EXIT

echo "→ generating HTML from real tool output"
npx tsx docs/demo-html.ts > "$OUT_HTML"

echo "→ screenshotting via headless Chrome (transparent backdrop)"
# Transparent page background so the gradient CARD is the only opaque content;
# a generous window guarantees the whole card fits, then we trim the transparent
# margin away — leaving exactly the card + its gradient border.
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1400,1200 \
  --default-background-color=00000000 \
  --screenshot="$TMP_PNG" \
  "file://$PWD/$OUT_HTML" >/dev/null 2>&1

echo "→ cropping to content"
magick "$TMP_PNG" -trim +repage -bordercolor none -border 12 "$OUT_PNG"
echo "✓ wrote $OUT_PNG"
