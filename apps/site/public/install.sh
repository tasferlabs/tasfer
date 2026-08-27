#!/bin/sh
#
# Install the Tasfer headless host.
#
#   curl -fsSL https://tasfer.app/install.sh | sh
#   curl -fsSL https://tasfer.app/install.sh | sh -s -- --version 0.1.5
#
# The CLI ships as one archive per platform: a self-contained `tasfer`
# executable plus the two native modules it loads from beside itself. So this
# script is a download, a checksum, and a directory — no Node, no toolchain, no
# package manager.
#
# It installs under $HOME by default, which is what makes `tasfer update` work
# later without sudo. Point TASFER_INSTALL_DIR at /opt/tasfer (and TASFER_BIN_DIR
# at /usr/local/bin) for a system-wide install; then updates need the same rights.
#
#   TASFER_INSTALL_DIR   where the build is unpacked   ~/.local/lib/tasfer
#   TASFER_BIN_DIR       where `tasfer` is linked      ~/.local/bin
#   TASFER_VERSION       version to install            newest published
#
# macOS and Linux, on x64 and arm64 — the platforms the release workflow builds.

set -eu

REPO="tasferlabs/tasfer"
CHECKSUMS="tasfer-checksums.txt"
RELEASES_API="https://api.github.com/repos/$REPO/releases?per_page=30"
DOWNLOAD_BASE="https://github.com/$REPO/releases/download"

install_dir="${TASFER_INSTALL_DIR:-$HOME/.local/lib/tasfer}"
bin_dir="${TASFER_BIN_DIR:-$HOME/.local/bin}"
version="${TASFER_VERSION:-}"

die() {
  echo "install.sh: $*" >&2
  exit 1
}

have() {
  command -v "$1" > /dev/null 2>&1
}

usage() {
  cat <<'USAGE'
Install the Tasfer headless host.

  --version <x.y.z>     install this version instead of the newest
  --install-dir <path>  unpack the build here (default ~/.local/lib/tasfer)
  --bin-dir <path>      link `tasfer` here (default ~/.local/bin)
  --help                show this

USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 || die "--version needs a value" ;;
    --version=*) version="${1#*=}"; shift ;;
    --install-dir) install_dir="${2:-}"; shift 2 || die "--install-dir needs a value" ;;
    --install-dir=*) install_dir="${1#*=}"; shift ;;
    --bin-dir) bin_dir="${2:-}"; shift 2 || die "--bin-dir needs a value" ;;
    --bin-dir=*) bin_dir="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

# ── What this machine is ─────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) die "$(uname -s) has no published build — macOS and Linux only. Build from apps/cli instead." ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) die "$(uname -m) has no published build — x64 and arm64 only." ;;
esac

# A shell running under Rosetta reports x86_64 on Apple silicon, which would
# install the slow build on a machine that has a native one.
if [ "$platform" = "darwin" ] && [ "$arch" = "x64" ] &&
  [ "$(sysctl -n hw.optional.arm64 2> /dev/null || echo 0)" = "1" ]; then
  arch="arm64"
fi

target="$platform-$arch"

if have curl; then
  fetch() { curl -fsSL "$1"; }
  fetch_to() { curl -fsSL -o "$2" "$1"; }
elif have wget; then
  fetch() { wget -qO- "$1"; }
  fetch_to() { wget -qO "$2" "$1"; }
else
  die "curl or wget is required."
fi

if have sha256sum; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif have shasum; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "sha256sum or shasum is required to verify the download."
fi

# ── Which version ────────────────────────────────────────────────────────────
# The host ships at the app's version, into the app's own release — so the
# newest release is not necessarily one carrying a host build, and the question
# is which release has an archive for *this* machine. Asset names encode the
# version, so listing them answers it without a JSON parser.
if [ -z "$version" ]; then
  echo "Looking for the newest tasfer build for ${target}…"
  version="$(
    fetch "$RELEASES_API" |
      grep -o "tasfer-[0-9][0-9.]*-$target\.tar\.gz" |
      sed -e "s/^tasfer-//" -e "s/-$target\.tar\.gz\$//" |
      sort -t. -k1,1n -k2,2n -k3,3n |
      tail -1
  )" || true
  [ -n "$version" ] ||
    die "no published release carries a build for $target yet."
fi

archive="tasfer-$version-$target.tar.gz"
url="$DOWNLOAD_BASE/v$version/$archive"

# ── Download and verify ──────────────────────────────────────────────────────
tmp="$(mktemp -d "${TMPDIR:-/tmp}/tasfer-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading ${archive}…"
fetch_to "$url" "$tmp/$archive" ||
  die "could not download $url — check that v$version exists."
fetch_to "$DOWNLOAD_BASE/v$version/$CHECKSUMS" "$tmp/$CHECKSUMS" ||
  die "v$version publishes no $CHECKSUMS, so nothing was installed."

expected="$(
  awk -v name="$archive" '{ file = $2; sub(/^\*/, "", file); if (file == name) { print $1; exit } }' \
    "$tmp/$CHECKSUMS"
)"
[ -n "$expected" ] ||
  die "$CHECKSUMS has no line for $archive, so nothing was installed."

actual="$(checksum "$tmp/$archive")"
[ "$actual" = "$expected" ] ||
  die "the download did not match its checksum, so nothing was installed.
  expected $expected
  got      $actual"

tar -xzf "$tmp/$archive" -C "$tmp"
staged="$tmp/tasfer-$version-$target"
[ -x "$staged/tasfer" ] || die "the archive did not contain a tasfer executable."

# ── Install ──────────────────────────────────────────────────────────────────
# The whole directory moves as a unit: `tasfer` loads node_modules/ from beside
# itself, and a binary separated from them cannot open a database. An install
# already in place is renamed aside rather than deleted, so a host running out
# of it keeps its files until the swap is done.
parent="$(dirname "$install_dir")"
mkdir -p "$parent" "$bin_dir" ||
  die "no permission to write to $parent or $bin_dir."

rm -rf "$install_dir.old"
if [ -e "$install_dir" ]; then
  mv "$install_dir" "$install_dir.old"
fi
mv "$staged" "$install_dir" || die "could not move the build into $install_dir."
rm -rf "$install_dir.old"

chmod 755 "$install_dir/tasfer"
ln -sf "$install_dir/tasfer" "$bin_dir/tasfer"

echo
echo "✓ tasfer $version installed to $install_dir"
echo "  linked as $bin_dir/tasfer"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    echo
    echo "$bin_dir is not on your PATH. Add it:"
    echo "  export PATH=\"$bin_dir:\$PATH\""
    ;;
esac

echo
echo "Next: link this machine to your account."
echo "  tasfer host invite      # then paste the code into the app"
echo "  tasfer host             # run the host"
