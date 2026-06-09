#!/usr/bin/env bash
#
# Build the macOS `newio` SEA, ad-hoc signed (local validation only).
#
# Ad-hoc signing is enough to run on Apple Silicon and to validate launchd
# attribution, but it is NOT distributable — use build-mac-sea-signed.sh for a
# Developer-ID-signed, notarized binary.
#
# Pipeline: tsup bundle -> SEA blob -> copy node -> strip signature -> postject
# inject -> ad-hoc re-sign. Build the workspace deps first:
#   pnpm --filter "@newio/cli..." run build
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # packages/cli

BUILD_DIR="build/sea"
BLOB="$BUILD_DIR/newio.blob"
# Final binary name. Defaults to `newio`; per-stage release builds set
# NEWIO_BIN_NAME=newio-dev / newio-integ so the three stages don't collide once
# installed (the installed command name carries the stage).
OUT="$BUILD_DIR/${NEWIO_BIN_NAME:-newio}"
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
IDENTIFIER="app.newio.connectord"

# 1-3. Bundle, blob, copy node.
pnpm exec tsup --config tsup.sea.config.ts
node --experimental-sea-config sea/sea-config.json
mkdir -p "$BUILD_DIR"
cp "$(command -v node)" "$OUT"
chmod 755 "$OUT"

# 4. Strip Node's signature before modifying the Mach-O.
codesign --remove-signature "$OUT"

# 5. Inject the blob (Mach-O segment name is required on macOS).
pnpm exec postject "$OUT" NODE_SEA_BLOB "$BLOB" \
  --sentinel-fuse "$FUSE" --macho-segment-name NODE_SEA

# 6. Re-sign ad-hoc (arm64 won't run unsigned) with hardened runtime + the JIT
#    entitlements V8 needs.
codesign --force --sign - --identifier "$IDENTIFIER" \
  --options runtime --entitlements sea/entitlements.plist "$OUT"
codesign --verify --verbose=2 "$OUT"

echo "✓ Built $OUT (macOS, ad-hoc — local validation only) — $("$OUT" --version)"
