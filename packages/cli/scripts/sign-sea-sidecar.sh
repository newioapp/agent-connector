#!/usr/bin/env bash
#
# Code-sign every Mach-O in the SEA native sidecar (build/sea/native).
#
# sharp ships as a sidecar `node_modules/` tree next to the macOS binary; it
# contains two Mach-O files that the OS loads via dlopen:
#   @img/sharp-<plat>-<arch>/lib/sharp-<plat>-<arch>.node   (the binding)
#   @img/sharp-libvips-<plat>-<arch>/lib/libvips-cpp.*.dylib (libvips)
# On Apple Silicon every loaded Mach-O must be signed; for a notarized build they
# must additionally carry the Developer ID signature + hardened runtime, or
# notarization rejects the bundle. A nested `codesign` on the binary does NOT
# reach sidecar files (they aren't inside the binary), so sign them explicitly.
#
# Usage: sign-sea-sidecar.sh <identity>     ("-" = ad-hoc)
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # packages/cli

IDENTITY="${1:-}"
[ -n "$IDENTITY" ] || {
  echo "usage: sign-sea-sidecar.sh <identity|->" >&2
  exit 1
}

NATIVE="build/sea/native"
[ -d "$NATIVE" ] || {
  echo "error: $NATIVE not found — run copy-sea-sidecar.mjs first" >&2
  exit 1
}

# Real Developer ID signing wants a secure timestamp; ad-hoc ("-") can't use one.
EXTRA=()
[ "$IDENTITY" != "-" ] && EXTRA+=(--timestamp)

signed=0
while IFS= read -r -d '' f; do
  # Hardened runtime (--options runtime), no entitlements: these are libraries,
  # not executables, so the JIT entitlements the binary needs don't apply.
  codesign --force --sign "$IDENTITY" --options runtime ${EXTRA[@]+"${EXTRA[@]}"} "$f"
  codesign --verify --verbose=2 "$f"
  signed=$((signed + 1))
done < <(find "$NATIVE" -type f \( -name '*.node' -o -name '*.dylib' \) -print0)

echo "✓ signed $signed sidecar Mach-O file(s) with identity: $IDENTITY"
