#!/usr/bin/env bash
#
# Newio CLI installer.
#
#   curl -fsSL https://cdn.newio.app/downloads/cli/install.sh | bash
#
# Detects your OS/arch, downloads the matching `newio` binary from the CDN,
# verifies its SHA-256, and installs it with a versioned layout:
#
#   ~/.local/share/newio/versions/<version>   the actual binary, one file per version
#   ~/.local/bin/newio  ->  versions/<version> a stable symlink on your PATH
#
# Updates drop a new file in versions/ and atomically flip the symlink, so the
# `newio daemon` service (which points at the symlink) picks up the new version
# on its next start, and previous versions stay for rollback. No system Node
# required — the binary is fully self-contained.
#
# Knobs (env vars):
#   NEWIO_INSTALL_BASE_URL  Override the CDN base (default: prod).
#   NEWIO_BIN_DIR           Symlink dir on PATH (default: ~/.local/bin).
#   NEWIO_DATA_DIR          Versioned binaries dir (default: ~/.local/share/newio).
#   NEWIO_VERSION           Install a specific published version instead of latest.
#   NEWIO_KEEP_VERSIONS     How many versions to retain (default: 3).
set -euo pipefail

BASE_URL="${NEWIO_INSTALL_BASE_URL:-https://cdn.newio.app/downloads/cli}"
BIN_DIR="${NEWIO_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${NEWIO_DATA_DIR:-$HOME/.local/share/newio}"
VERSION="${NEWIO_VERSION:-latest}"
KEEP_VERSIONS="${NEWIO_KEEP_VERSIONS:-3}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
err() {
  printf '\033[1;31merror:\033[0m %s\n' "$1" >&2
  exit 1
}

# --- detect platform -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) err "unsupported OS: $os (newio supports macOS and Linux)" ;;
esac
case "$arch" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

target="${os}-${arch}"
url_dir="$BASE_URL"
[ "$VERSION" != "latest" ] && url_dir="$BASE_URL/v${VERSION#v}"
archive="newio-${target}.tar.gz"

# --- download --------------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "Downloading newio ($target) from $url_dir"
curl -fsSL "$url_dir/$archive" -o "$tmp/$archive" || err "download failed: $url_dir/$archive"
curl -fsSL "$url_dir/SHA256SUMS" -o "$tmp/SHA256SUMS" || err "could not fetch checksums"

# --- verify checksum -------------------------------------------------------
info "Verifying checksum"
expected="$(grep " $archive\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || err "no checksum published for $archive"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
fi
[ "$actual" = "$expected" ] || err "checksum mismatch (expected $expected, got $actual)"

# --- extract + resolve version ---------------------------------------------
tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/newio" ] || err "archive did not contain a newio binary"
chmod 0755 "$tmp/newio"
# The binary names its own version dir (also a smoke test that it runs).
resolved="$("$tmp/newio" --version 2>/dev/null || true)"
[ -n "$resolved" ] || err "could not run the downloaded binary to determine its version"

# --- install (versioned) + flip symlink ------------------------------------
dest="$DATA_DIR/versions/$resolved"
info "Installing newio $resolved to $dest"
mkdir -p "$DATA_DIR/versions"
install -m 0755 "$tmp/newio" "$dest"

mkdir -p "$BIN_DIR"
ln -sfn "$dest" "$BIN_DIR/newio" # atomic-ish replace of the stable launcher

# --- prune old versions (keep the symlink target + newest KEEP_VERSIONS) ----
# Best-effort: run in a subshell with errexit/pipefail off so a no-match grep
# (e.g. on a first install) never aborts the installer.
(
  set +e +o pipefail
  case "$KEEP_VERSIONS" in '' | *[!0-9]*) KEEP_VERSIONS=0 ;; esac
  if [ "$KEEP_VERSIONS" -gt 0 ]; then
    current="$(basename "$dest")"
    # shellcheck disable=SC2012
    ls -1t "$DATA_DIR/versions" 2>/dev/null | grep -vx "$current" | tail -n +"$KEEP_VERSIONS" | while IFS= read -r old; do
      [ -n "$old" ] && rm -f "$DATA_DIR/versions/$old"
    done
  fi
) || true

# --- PATH ------------------------------------------------------------------
if ! printf '%s' ":$PATH:" | grep -q ":$BIN_DIR:"; then
  added=""
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$rc" ]; then
      printf '\n# Newio CLI\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >>"$rc"
      added="$rc"
      break
    fi
  done
  if [ -n "$added" ]; then
    info "Added $BIN_DIR to PATH in $added — restart your shell or: export PATH=\"$BIN_DIR:\$PATH\""
  else
    info "Add $BIN_DIR to your PATH: export PATH=\"$BIN_DIR:\$PATH\""
  fi
fi

info "Installed newio $resolved ($BIN_DIR/newio -> $dest)"
echo
echo "Next: start the background daemon with"
echo "    newio daemon start"
