#!/usr/bin/env bash
#
# Newio CLI installer.
#
#   curl -fsSL https://cdn.newio.app/downloads/cli/install.sh | bash
#
# Detects your OS/arch, downloads the matching signed `newio` binary from the
# CDN, verifies its SHA-256 against the published checksum file, installs it to
# ~/.newio/bin, and adds that to your PATH. No system Node required — the binary
# is fully self-contained.
#
# Knobs (env vars):
#   NEWIO_INSTALL_BASE_URL  Override the CDN base (default: prod).
#   NEWIO_INSTALL_DIR       Override the install dir (default: ~/.newio/bin).
#   NEWIO_VERSION           Install a specific version dir instead of "latest".
set -euo pipefail

BASE_URL="${NEWIO_INSTALL_BASE_URL:-https://cdn.newio.app/downloads/cli}"
INSTALL_DIR="${NEWIO_INSTALL_DIR:-$HOME/.newio/bin}"
VERSION="${NEWIO_VERSION:-latest}"

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
# Versioned path for reproducibility; "latest" mirrors the newest release.
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

# --- install ---------------------------------------------------------------
info "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/newio" ] || err "archive did not contain a newio binary"
install -m 0755 "$tmp/newio" "$INSTALL_DIR/newio"

# --- PATH ------------------------------------------------------------------
if ! printf '%s' ":$PATH:" | grep -q ":$INSTALL_DIR:"; then
  added=""
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$rc" ]; then
      printf '\n# Newio CLI\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >>"$rc"
      added="$rc"
      break
    fi
  done
  if [ -n "$added" ]; then
    info "Added $INSTALL_DIR to PATH in $added — restart your shell or: export PATH=\"$INSTALL_DIR:\$PATH\""
  else
    info "Add $INSTALL_DIR to your PATH: export PATH=\"$INSTALL_DIR:\$PATH\""
  fi
fi

version_str="$("$INSTALL_DIR/newio" --version 2>/dev/null || echo "?")"
info "Installed newio $version_str"
echo
echo "Next: start the background daemon with"
echo "    newio daemon start"
