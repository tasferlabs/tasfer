#!/usr/bin/env bash
#
# Installs and builds every @tasfer/* package, so scripts/generate-api.mjs can
# read their types. The site build runs the generator, so this runs first
# wherever the site is built: Vercel (installCommand in vercel.json), CI and
# the Release workflow. Locally, run it once with `npm run packages`.
#
# A package that already has node_modules is not reinstalled.
set -euo pipefail
cd "$(dirname "$0")/../../../packages"

for p in tex editor math code table provider-core provider-indexeddb provider-relay provider-webrtc react; do
  if [[ ! -d "$p/node_modules" ]]; then
    echo "▸ installing @tasfer/$p"
    (cd "$p" && npm ci --no-audit --no-fund)
  fi
done

bash build-all.sh
