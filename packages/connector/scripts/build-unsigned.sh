#!/bin/bash
set -e

# Load environment from .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

rm -rf dist

export CSC_IDENTITY_AUTO_DISCOVERY=false

pnpm exec electron-vite build

pnpm exec electron-builder --mac --arm64 \
  -c.mac.notarize=false \
  -c.mac.entitlementsInherit=build/entitlements.mac.unsigned.plist \
  -c.productName="${APP_DISPLAY_NAME:-Newio Agent Connector}"

# Re-sign with entitlements (ad-hoc signing doesn't apply entitlements from electron-builder)
codesign --force --deep --sign - --entitlements build/entitlements.mac.unsigned.plist "dist/mac-arm64/${APP_DISPLAY_NAME:-Newio Agent Connector}.app"
xattr -cr "dist/mac-arm64/${APP_DISPLAY_NAME:-Newio Agent Connector}.app"

echo "✓ Build complete: dist/mac-arm64/${APP_DISPLAY_NAME:-Newio Agent Connector}.app"
