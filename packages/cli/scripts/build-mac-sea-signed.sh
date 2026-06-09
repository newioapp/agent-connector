#!/usr/bin/env bash
#
# Build, Developer-ID-sign, and notarize the macOS `newio` SEA binary.
#
# Signing identity:
#   $NEWIO_SIGN_IDENTITY, else the first "Developer ID Application" identity in
#   the keychain.
# Notary credentials (used unless --no-notarize):
#   $APPLE_ID / $APPLE_APP_SPECIFIC_PASSWORD / $APPLE_TEAM_ID if set (CI), else
#   the `newio-build` keychain items (local; same convention as the connector's
#   build-signed.sh).
#
# Flags:
#   --no-notarize   sign only, skip the Apple notary submission.
#
# A bare Mach-O can't be stapled, so the notarization ticket is recorded by hash
# (Gatekeeper checks online); curl|bash installs skip quarantine anyway. Build
# the workspace deps first:  pnpm --filter "@newio/cli..." run build
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # packages/cli

NOTARIZE=1
[ "${1:-}" = "--no-notarize" ] && NOTARIZE=0

BUILD_DIR="build/sea"
BLOB="$BUILD_DIR/newio.blob"
# Final binary name. Defaults to `newio`; per-stage release builds set
# NEWIO_BIN_NAME=newio-dev / newio-integ so the three stages don't collide once
# installed (the installed command name carries the stage).
OUT="$BUILD_DIR/${NEWIO_BIN_NAME:-newio}"
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
IDENTIFIER="app.newio.connectord"

# Resolve the Developer ID Application identity.
SIGN_IDENTITY="${NEWIO_SIGN_IDENTITY:-}"
if [ -z "$SIGN_IDENTITY" ]; then
  SIGN_IDENTITY="$(security find-identity -v -p codesigning |
    grep 'Developer ID Application' | head -1 | sed -E 's/.*"(.*)"/\1/')"
fi
[ -n "$SIGN_IDENTITY" ] || {
  echo "error: no Developer ID Application identity found (set NEWIO_SIGN_IDENTITY)" >&2
  exit 1
}

# 1-3. Bundle, blob, copy node.
pnpm exec tsup --config tsup.sea.config.ts
node --experimental-sea-config sea/sea-config.json
mkdir -p "$BUILD_DIR"
cp "$(command -v node)" "$OUT"
chmod 755 "$OUT"

# 4-5. Strip Node's signature, inject the blob.
codesign --remove-signature "$OUT"
pnpm exec postject "$OUT" NODE_SEA_BLOB "$BLOB" \
  --sentinel-fuse "$FUSE" --macho-segment-name NODE_SEA

# 6. Developer ID sign: hardened runtime + JIT entitlements + secure timestamp.
codesign --force --sign "$SIGN_IDENTITY" --identifier "$IDENTIFIER" \
  --options runtime --entitlements sea/entitlements.plist --timestamp "$OUT"
codesign --verify --strict --verbose=2 "$OUT"
echo "✓ Signed $OUT as: $SIGN_IDENTITY"

if [ "$NOTARIZE" -eq 1 ]; then
  # Read a credential from env first (CI), then the newio-build keychain (local).
  cred() { # $1 = env var name, $2 = keychain service
    local v="${!1:-}"
    [ -z "$v" ] && v="$(security find-generic-password -a newio-build -s "$2" -w 2>/dev/null || true)"
    [ -n "$v" ] || {
      echo "error: $1 not set and not in keychain (newio-build/$2)" >&2
      exit 1
    }
    printf '%s' "$v"
  }
  A_ID="$(cred APPLE_ID APPLE_ID)"
  A_PW="$(cred APPLE_APP_SPECIFIC_PASSWORD APPLE_APP_SPECIFIC_PASSWORD)"
  A_TEAM="$(cred APPLE_TEAM_ID APPLE_TEAM_ID)"

  ZIP="$(mktemp -d)/newio.zip"
  ditto -c -k "$OUT" "$ZIP"
  echo "Submitting to Apple notary service (this can take a few minutes)…"
  xcrun notarytool submit "$ZIP" --apple-id "$A_ID" --password "$A_PW" --team-id "$A_TEAM" --wait
  echo "✓ Notarized (bare binary — ticket is online-only, cannot be stapled)"
else
  echo "  (skipped notarization: --no-notarize)"
fi

echo "✓ Done — $("$OUT" --version)"
