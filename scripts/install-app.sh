#!/bin/bash
#
# Put the built app in /Applications.
#
# `electron-builder --dir` leaves a bundle under `release/mac-<arch>/`, and the
# arch is in the directory name, so the bundle is found rather than assumed.
#
# The old copy is removed first: `cp -R` over an existing bundle merges the two
# directory trees, which leaves files from the previous build inside the new one
# — an app that is two builds at once and fails in ways neither of them does.
set -euo pipefail

cd "$(dirname "$0")/.."

APP=$(find release -maxdepth 2 -name 'Agent Wrangler.app' -type d 2>/dev/null | head -1)
if [ -z "$APP" ]; then
  echo "No built app under release/. Run: npm run app:package" >&2
  exit 1
fi

DEST="/Applications/Agent Wrangler.app"

# Quit a running copy. It holds a single-instance lock, and replacing the bundle
# out from under a running process gives you a half-swapped app rather than an
# error.
if pgrep -f "/Applications/Agent Wrangler.app/Contents/MacOS/Agent Wrangler" >/dev/null 2>&1; then
  echo "Quitting the running copy…"
  osascript -e 'quit app "Agent Wrangler"' >/dev/null 2>&1 || true
  sleep 2
fi

rm -rf "$DEST"
cp -R "$APP" "$DEST"

echo "Installed $DEST"
echo "Built from: $APP"
