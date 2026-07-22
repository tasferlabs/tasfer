#!/usr/bin/env bash
#
# Build every @tasfer/* package, in dependency order.
#
# There is no workspace tool, so each package builds from its own directory and
# resolves its siblings' *types* from their built `dist/` (see each tsconfig's
# `paths`). That makes order matter: a package must be built after everything it
# imports.
#
#   tex            — no @tasfer deps
#   editor         — reads tex source for types; needs nothing built first
#   provider-core  — needs editor/dist
#   provider-*     — need editor/dist (+ provider-core/dist)
#   react          — needs editor/dist + tex/dist
#
# Assumes deps are installed (run `npm install` in each package once first).
set -euo pipefail
cd "$(dirname "$0")"

ORDER=(tex editor provider-core provider-indexeddb provider-relay provider-webrtc react)

for p in "${ORDER[@]}"; do
  echo "▸ building @tasfer/$p"
  ( cd "$p" && npm run build )
done

echo "✓ all @tasfer packages built"
