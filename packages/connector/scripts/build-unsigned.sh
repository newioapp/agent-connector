#!/bin/bash
set -e

rm -rf dist

export APP_DISPLAY_NAME="Newio Agent Connector (Dev)"
export PUBLISH_URL=https://cdn.nan-dev.newio.app/downloads/connector
export CSC_IDENTITY_AUTO_DISCOVERY=false

pnpm exec electron-vite build

pnpm exec electron-builder --mac --arm64 \
  -c.mac.notarize=false \
  -c.mac.entitlementsInherit=build/entitlements.mac.unsigned.plist \
  -c.productName="$APP_DISPLAY_NAME"

# Re-sign with entitlements (ad-hoc signing doesn't apply entitlements from electron-builder)
codesign --force --deep --sign - --entitlements build/entitlements.mac.unsigned.plist "dist/mac-arm64/$APP_DISPLAY_NAME.app"
xattr -cr "dist/mac-arm64/$APP_DISPLAY_NAME.app"

echo "✓ Build complete: dist/mac-arm64/$APP_DISPLAY_NAME.app"
