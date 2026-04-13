#!/bin/bash
set -e

# Read notarization credentials from macOS Keychain
export APPLE_ID=$(security find-generic-password -a "newio-build" -s "APPLE_ID" -w)
export APPLE_APP_SPECIFIC_PASSWORD=$(security find-generic-password -a "newio-build" -s "APPLE_APP_SPECIFIC_PASSWORD" -w)
export APPLE_TEAM_ID=$(security find-generic-password -a "newio-build" -s "APPLE_TEAM_ID" -w)

rm -rf dist

export APP_DISPLAY_NAME="Newio Agent Connector (Dev)"
export PUBLISH_URL=https://cdn.nan-dev.newio.app/downloads/connector

electron-vite build

electron-builder --mac --arm64 \
  -c.productName="$APP_DISPLAY_NAME"

echo "✓ Build complete: dist/mac-arm64/$APP_DISPLAY_NAME.app"
