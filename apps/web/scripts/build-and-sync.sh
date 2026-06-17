#!/usr/bin/env bash
#
# Build the web app and run `cap sync` for a native platform.
#
# Invoked automatically before a native build:
#   - iOS:     an Xcode "Build & sync web" run-script build phase
#   - Android: the `cypherWebBuildAndSync` Gradle task (preBuild dependency)
#
# Usage: build-and-sync.sh <ios|android>
#
# Set CYPHER_SKIP_WEB_BUILD=1 to skip (e.g. CI that builds the web bundle in a
# separate step, or to avoid a double build).
set -euo pipefail

PLATFORM="${1:-}"
if [[ "$PLATFORM" != "ios" && "$PLATFORM" != "android" ]]; then
  echo "build-and-sync.sh: expected platform 'ios' or 'android', got '$PLATFORM'" >&2
  exit 1
fi

if [[ "${CYPHER_SKIP_WEB_BUILD:-}" == "1" ]]; then
  echo "build-and-sync.sh: CYPHER_SKIP_WEB_BUILD=1, skipping web build + sync"
  exit 0
fi

# The web app lives one level up from this script's directory (apps/web/scripts -> apps/web).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Native build tools (Xcode, Gradle) run with a minimal PATH that excludes
# version-manager shims, so locate node before doing anything else.
ensure_node_on_path() {
  if command -v node >/dev/null 2>&1; then
    return
  fi

  # fnm (this repo's manager) — activate the default/used version.
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)" 2>/dev/null || true
    (cd "$WEB_DIR" && fnm use --install-if-missing >/dev/null 2>&1) || true
  fi
  if command -v node >/dev/null 2>&1; then return; fi

  # nvm
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use --silent default >/dev/null 2>&1 || true
  fi
  if command -v node >/dev/null 2>&1; then return; fi

  # Common static install locations and version-manager shim dirs.
  for dir in \
    "$HOME/.volta/bin" \
    "$HOME/.asdf/shims" \
    "$HOME/.local/state/fnm_multishells"/*/bin \
    /opt/homebrew/bin \
    /usr/local/bin; do
    if [[ -x "$dir/node" ]]; then
      PATH="$dir:$PATH"
      break
    fi
  done

  if ! command -v node >/dev/null 2>&1; then
    echo "build-and-sync.sh: could not find 'node' on PATH." >&2
    echo "  Install Node, or set CYPHER_SKIP_WEB_BUILD=1 to skip this step." >&2
    exit 1
  fi
}

ensure_node_on_path

echo "build-and-sync.sh: building web app and syncing '$PLATFORM' (node $(node -v))"
cd "$WEB_DIR"
npm run build

# Per-build we run `cap copy` (web assets + capacitor.config.json) only — NOT
# `cap sync`. `cap sync` also runs `cap update`, which regenerates the
# capacitor-cordova-android-plugins Gradle project and DELETES its build/
# intermediates. Because this script runs from inside the native build (Gradle
# preBuild / Xcode phase), that wipe lands *after* Gradle has already run the
# capacitor module's tasks (writeDebugAarMetadata, processDebugManifest, …),
# so the app's checkAarMetadata / manifest-merge then fail reading the now-missing
# files. `cap copy` doesn't touch that module, so the build stays consistent.
#
# Run a full sync explicitly after adding/removing/upgrading a native plugin:
#   CYPHER_CAP_SYNC=1 <build>   (or just `npx cap sync <platform>` once)
if [[ "${CYPHER_CAP_SYNC:-}" == "1" ]]; then
  npx cap sync "$PLATFORM"
else
  npx cap copy "$PLATFORM"
fi
