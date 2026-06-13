#!/bin/bash
#
# Sanity test against a REAL newio daemon process (dev stage).
#
# Loads dev backend config from .env, does a clean daemon (re)install, then runs a
# full agent lifecycle for a claude-code agent:
#   daemon uninstall -> daemon start (installs + starts) -> daemon status
#   agent list -> agent remove (clean slate) -> agent add (claude-code)
#   agent start -> agent stop -> agent restart -> daemon stop
#
# Usage:
#   ./sanity-test.sh <agent-username>
#
#   <agent-username>  An existing approved Newio agent account to run as claude-code.
#                     `agent start` streams an approval URL if the account still
#                     needs auth — approve it in the browser when prompted.
#
# Prereqs:
#   - Run from packages/cli after building:  pnpm --filter @newio/cli build
#   - A .env in this directory with NEWIO_API_URL / NEWIO_WS_URL (NEWIO_STAGE=dev).

set -euo pipefail

USERNAME="${1:-}"
if [ -z "$USERNAME" ]; then
  echo "Usage: $0 <agent-username>" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "Error: no .env in $(pwd). Create one with NEWIO_API_URL / NEWIO_WS_URL." >&2
  exit 1
fi

# Load the dev environment (NEWIO_API_URL / NEWIO_WS_URL / NEWIO_STAGE / ...).
set -a
# shellcheck disable=SC1091
source .env
set +a
export NEWIO_STAGE="${NEWIO_STAGE:-dev}"

CLI="node dist/cli.js"

echo "==> Clean daemon (re)install  [stage=$NEWIO_STAGE]"
$CLI daemon uninstall || true   # tolerate "no service installed" on the first run
$CLI daemon start               # `daemon start` = install + start (no separate install)
$CLI daemon status

echo "==> agent list (before)"
$CLI agent list

echo "==> Remove any existing config for @$USERNAME (clean slate)"
$CLI agent remove "$USERNAME" || true   # tolerate "no agent matching" when none exists yet

echo "==> Add claude-code agent @$USERNAME"
$CLI agent add --type claude-code --username "$USERNAME"

echo "==> agent list (after add)"
$CLI agent list

echo "==> Start @$USERNAME (streams an approval URL if it needs auth)"
$CLI agent start "$USERNAME"

echo "==> Stop @$USERNAME"
$CLI agent stop "$USERNAME"

echo "==> Restart @$USERNAME"
$CLI agent restart "$USERNAME"

echo "==> agent list (after restart)"
$CLI agent list

echo "==> Stop the daemon"
$CLI daemon stop

echo "==> Sanity test complete."
