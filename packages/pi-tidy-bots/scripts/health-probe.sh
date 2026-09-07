#!/usr/bin/env bash
# Fail-closed Atlas/fleet health probe.
#
# Source of truth lives in this package (pi-tidy-bots). Rook's fleet copy
# at bots/atlas/health-probe.sh is NOT in this repo — point that wrapper
# here (or `pi-tidy-bots health`) so sticky delivering and over-budget
# context fail the probe.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
url="${1:-${PTB_HEALTH_URL:-http://127.0.0.1:4317}}"
shift || true

exec node --import tsx "$root/src/health-probe.ts" --url "$url" "$@"
