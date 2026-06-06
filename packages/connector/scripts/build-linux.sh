#!/bin/bash
set -e

# Load environment from .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

# Build-time defaults (override via environment or .env)
export NEWIO_STAGE="${NEWIO_STAGE:-dev}"
export LOG_LEVEL="${LOG_LEVEL:-debug}"
# Auto-update feed URL (electron-builder generic provider). Falls back to prod
# so a build still succeeds without a .env.
export PUBLISH_URL="${PUBLISH_URL:-https://cdn.newio.app/downloads}"

rm -rf dist

pnpm exec electron-vite build

# StartupWMClass must equal the runtime app.name (on X11 the window's WM_CLASS is
# set to app.name = APP_DISPLAY_NAME) so the desktop environment maps the running
# window to this launcher entry and shows the correct dock icon. Name mirrors it
# so a dev build is clearly labeled. productName is left untouched: it becomes the
# deb package name, which cannot contain the "(" in "Agent Connector (Dev)".
pnpm exec electron-builder --linux deb \
  -c.linux.desktop.entry.StartupWMClass="${APP_DISPLAY_NAME:-Agent Connector}" \
  -c.linux.desktop.entry.Name="${APP_DISPLAY_NAME:-Agent Connector}"

echo "✓ Build complete:"
ls -1 dist/*.deb
