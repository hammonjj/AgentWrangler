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
# The main executable, matched exactly: `pgrep -x` on the name alone would also
# match a session host running from a clone of the bundle (spike S2).
EXE="$DEST/Contents/MacOS/Agent Wrangler"
RUN_DIR="$HOME/Library/Application Support/Agent Wrangler/run"

# macOS `pgrep` never matches its own ancestors unless given `-a`. That tells
# the two cases apart: `-a` finds a running copy at all, plain finds one only if
# this script is *not* running inside it.
running() { pgrep -f "^$EXE( |\$)" >/dev/null 2>&1; }
running_at_all() { pgrep -a -f "^$EXE( |\$)" >/dev/null 2>&1; }

if running_at_all && ! running; then
  # Run by an agent Agent Wrangler is hosting. Quitting the app would end every
  # session it runs, this agent's included, and CLAUDE.md forbids restarting
  # it. The bundle is replaced in place instead: a running copy keeps working
  # from the files it already has open (spike S2), and picks up the new build
  # when James restarts it.
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  echo "Installed $DEST (the running copy was left running: a restart is needed to use this build)"
  echo "Built from: $APP"
  exit 0
fi

# Quit a running copy. It holds a single-instance lock, and replacing the bundle
# out from under a running process gives you a half-swapped app rather than an
# error.
if running; then
  echo "Quitting the running copy…"
  # Say why, so the app treats this as an install (no dialog; it ends its
  # sessions gracefully, and they come back as Interrupted rows) rather than
  # guessing from an unlabelled quit.
  mkdir -p "$RUN_DIR"
  printf 'install' > "$RUN_DIR/quit-intent"
  osascript -e 'quit app "Agent Wrangler"' >/dev/null 2>&1 || true
  # Wait for it to actually exit: it ends its sessions first, bounded at 10 s.
  for _ in $(seq 1 60); do
    running || break
    sleep 0.5
  done
  if running; then
    rm -f "$RUN_DIR/quit-intent"
    echo "The running copy did not quit within 30 s, so it was left in place. Quit it and run this again." >&2
    exit 1
  fi
fi

rm -rf "$DEST"
cp -R "$APP" "$DEST"

echo "Installed $DEST"
echo "Built from: $APP"
