#!/bin/bash
set -e

# Load environment from .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# Read notarization credentials from macOS Keychain
export APPLE_ID=$(security find-generic-password -a "newio-build" -s "APPLE_ID" -w)
export APPLE_APP_SPECIFIC_PASSWORD=$(security find-generic-password -a "newio-build" -s "APPLE_APP_SPECIFIC_PASSWORD" -w)
export APPLE_TEAM_ID=$(security find-generic-password -a "newio-build" -s "APPLE_TEAM_ID" -w)

rm -rf dist

pnpm exec electron-vite build

pnpm exec electron-builder --mac --arm64 \
  -c.productName="${APP_DISPLAY_NAME:-Newio Agent Connector}"

echo "✓ Build complete: dist/mac-arm64/${APP_DISPLAY_NAME:-Newio Agent Connector}.app"
