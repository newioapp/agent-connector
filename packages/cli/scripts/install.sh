#!/bin/sh
#
# Newio CLI installer. POSIX sh — works under bash, dash, etc.
#
#   curl -fsSL https://cdn.newio.app/downloads/cli/install.sh | sh
#
# Detects your OS/arch, downloads the matching `newio` archive from the CDN,
# verifies its SHA-256, and installs it with a versioned layout:
#
#   ~/.local/share/<cmd>/versions/<version>/<cmd>     the binary, one dir per version
#   ~/.local/share/<cmd>/versions/<version>/native/   sharp's native sidecar
#   ~/.local/bin/<cmd>  ->  versions/<version>/<cmd>   a stable symlink on your PATH
#
# Each version is its own DIRECTORY (not a bare file) because the binary ships
# with a `native/` sidecar next to it: sharp is a native module that can't live
# inside the self-contained binary, so it travels alongside and is resolved at
# runtime from `native/` beside the (symlink-resolved) executable. Keeping the
# binary + native/ together per version keeps rollback isolated.
#
# <cmd> is the command name baked into the downloaded binary: `newio` for the
# public (prod) build, or `newio-dev` / `newio-integ` for the internal-testing
# builds, so all three can be installed side by side. The command's stage is
# inferred from its name, so `newio-dev <cmd>` targets the dev daemon with no
# extra env.
#
# Updates drop a new dir in versions/ and atomically flip the symlink, so the
# `<cmd> daemon` service (which points at the symlink) picks up the new version
# on its next start, and previous versions stay for rollback. No system Node
# required — the binary is fully self-contained.
#
# Knobs (env vars):
#   NEWIO_INSTALL_BASE_URL  Override the CDN base (default: prod).
#   NEWIO_BIN_DIR           Symlink dir on PATH (default: ~/.local/bin).
#   NEWIO_DATA_DIR          Versioned binaries dir (default: ~/.local/share/<cmd>).
#   NEWIO_VERSION           Install a specific published version instead of latest.
#   NEWIO_KEEP_VERSIONS     How many versions to retain (default: 3).
set -eu

BASE_URL="${NEWIO_INSTALL_BASE_URL:-https://cdn.newio.app/downloads/cli}"
BIN_DIR="${NEWIO_BIN_DIR:-$HOME/.local/bin}"
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

# --- extract + resolve command name + version ------------------------------
tar -xzf "$tmp/$archive" -C "$tmp"
# The archive holds a stage-named binary — `newio` (prod), `newio-dev`, or
# `newio-integ` — plus a `native/` sidecar dir. The binary's name becomes the
# installed command and the data-dir namespace, so the three stages coexist
# without colliding.
cli_name=""
for cand in newio newio-dev newio-integ; do
  if [ -f "$tmp/$cand" ]; then
    cli_name="$cand"
    break
  fi
done
[ -n "$cli_name" ] || err "archive did not contain a newio binary"
bin_src="$tmp/$cli_name"
chmod 0755 "$bin_src"
# The binary names its own version dir (also a smoke test that it runs). It
# resolves its native/ sidecar from beside itself, so this works in $tmp too.
resolved="$("$bin_src" --version 2>/dev/null || true)"
[ -n "$resolved" ] || err "could not run the downloaded binary to determine its version"

# Per-command data dir (default), so newio / newio-dev / newio-integ are
# isolated. Prod keeps the historical ~/.local/share/newio path.
DATA_DIR="${NEWIO_DATA_DIR:-$HOME/.local/share/$cli_name}"

# --- install (versioned dir) + flip symlink --------------------------------
# Each version is a directory holding the binary + its native/ sidecar, so the
# runtime finds native/ next to the (symlink-resolved) executable.
dest="$DATA_DIR/versions/$resolved"
info "Installing $cli_name $resolved to $dest"
rm -rf "$dest" # clean reinstall of the same version
mkdir -p "$dest"
install -m 0755 "$bin_src" "$dest/$cli_name"
[ -d "$tmp/native" ] && cp -R "$tmp/native" "$dest/native"

mkdir -p "$BIN_DIR"
# Symlink points at the binary INSIDE the version dir; realpath() resolves it so
# native/ is found as its sibling.
ln -sfn "$dest/$cli_name" "$BIN_DIR/$cli_name" # atomic-ish replace of the launcher

# --- prune old versions (keep the symlink target + newest KEEP_VERSIONS) ----
# Best-effort: run in a subshell with errexit off so a no-match grep
# (e.g. on a first install) never aborts the installer.
(
  set +e
  case "$KEEP_VERSIONS" in '' | *[!0-9]*) KEEP_VERSIONS=0 ;; esac
  if [ "$KEEP_VERSIONS" -gt 0 ]; then
    current="$(basename "$dest")"
    # shellcheck disable=SC2012
    ls -1t "$DATA_DIR/versions" 2>/dev/null | grep -vx "$current" | tail -n +"$KEEP_VERSIONS" | while IFS= read -r old; do
      [ -n "$old" ] && rm -rf "$DATA_DIR/versions/$old"
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

info "Installed $cli_name $resolved ($BIN_DIR/$cli_name -> $dest)"
echo
echo "Next: start the background daemon with"
echo "    $cli_name daemon start"
