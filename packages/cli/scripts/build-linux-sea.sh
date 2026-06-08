#!/usr/bin/env bash
#
# Build the Linux `newio` Single Executable Application (SEA).
#
# Produces an unsigned, self-contained binary at build/sea/newio (no system Node
# needed at runtime). Linux binaries aren't code-signed.
#
# Pipeline: tsup bundle -> SEA blob -> copy node -> postject inject (ELF: no
# Mach-O segment name). Build the workspace deps first:
#   pnpm --filter "@newio/cli..." run build
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # packages/cli

BUILD_DIR="build/sea"
BLOB="$BUILD_DIR/newio.blob"
OUT="$BUILD_DIR/newio"
# Sentinel the Node SEA loader scans for to locate the injected blob (a fixed
# constant, identical across all Node versions).
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

# 1. Bundle to a single CommonJS file.
pnpm exec tsup --config tsup.sea.config.ts

# 2. Generate the SEA blob from the bundle.
node --experimental-sea-config sea/sea-config.json

# 3. Copy the running node binary as the target executable.
mkdir -p "$BUILD_DIR"
cp "$(command -v node)" "$OUT"
chmod 755 "$OUT"

# 4. Inject the blob (ELF needs no segment name; no signing on Linux).
pnpm exec postject "$OUT" NODE_SEA_BLOB "$BLOB" --sentinel-fuse "$FUSE"

echo "✓ Built $OUT (linux, unsigned) — $("$OUT" --version)"
