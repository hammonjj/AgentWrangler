#!/bin/bash
#
# Put the built app in /Applications and move the core daemon onto it (#142).
#
# 1. An Electron-era copy of the app (before #142) that is still running is
#    quit the ordinary way: as a window client it ends nothing; running the
#    core itself it ends only in-app Codex threads, and session hosts keep
#    running (#122). Not when this script runs inside an agent Agent Wrangler
#    runs, which that quit could end: then it says so and leaves it to you.
# 2. The old bundle is removed and the new one copied in. `cp -R` over an
#    existing bundle would merge the two trees: an app that is two builds at
#    once. The daemon and hosts run from clones in the data directory, never
#    from /Applications, so replacing it ends nothing.
# 3. `aw daemon start` from the new bundle, when the daemon was running (or an
#    old app was, which this replaces): it rewrites the LaunchAgent for this
#    build, the old daemon stops the way `aw daemon stop` does, and the new one
#    reattaches the session hosts. A daemon stopped on purpose stays stopped.
# 4. An `aw` on the PATH that is a copy of bin/aw is refreshed, so it finds the
#    new layout (`npm run cli:install` does the same).
#
# A copy of the app from before #124 (secrets still in safeStorage) must run
# an intermediate release first; see the README.
set -euo pipefail

cd "$(dirname "$0")/.."

APP="release/Agent Wrangler.app"
if [ ! -d "$APP" ]; then
  echo "No built app at $APP. Run: npm run app:package" >&2
  exit 1
fi

DEST="/Applications/Agent Wrangler.app"
# The old Electron main executable, matched exactly: `pgrep -x` on the name
# alone would also match a session host (`Agent Wrangler Host`). The new
# launcher execs Node and is gone in a second, so it never matches this.
EXE="$DEST/Contents/MacOS/Agent Wrangler"
RUN_DIR="$HOME/Library/Application Support/Agent Wrangler/run"
NEW_NODE="$APP/Contents/Resources/node/bin/node"
NEW_CLI="$APP/Contents/Resources/app/dist/cli/main.js"

aw_new() { "$NEW_NODE" "$NEW_CLI" "$@"; }

# macOS `pgrep` never matches its own ancestors unless given `-a`. That tells
# the two cases apart: `-a` finds a running copy at all, plain finds one only if
# this script is *not* running inside it.
old_app_running() { pgrep -f "^$EXE( |\$)" >/dev/null 2>&1; }
old_app_running_at_all() { pgrep -a -f "^$EXE( |\$)" >/dev/null 2>&1; }

# Run by an agent Agent Wrangler runs: a session host or the daemon is an
# ancestor (both are `Agent Wrangler Host` processes), or the host said so.
inside_agent() {
  [ "${AGENTWRANGLER_HOSTED:-}" = "1" ] && return 0
  local pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
      *"Agent Wrangler Host"*) return 0 ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
  return 1
}

# What holds the core now: "daemon", "app" (an Electron-era app's own core) or "none".
holder() {
  aw_new daemon status --json 2>/dev/null | sed -n 's/.*"holder": *"\([a-z]*\)".*/\1/p' | head -1
}

HOLDER=$(holder || true)
[ -n "$HOLDER" ] || HOLDER=none
START_DAEMON=0
[ "$HOLDER" = "daemon" ] && START_DAEMON=1

# ---- 1. An Electron-era app ----
if old_app_running_at_all; then
  if ! old_app_running || { [ "$HOLDER" = "app" ] && inside_agent; }; then
    echo "An older Agent Wrangler app is running and this script runs inside an agent it may end, so it was left running." >&2
    echo "Quit Agent Wrangler yourself (not Quit and Stop All), then run: aw daemon start" >&2
    rm -rf "$DEST"
    cp -R "$APP" "$DEST"
    echo "Installed $DEST (built from $APP); the core daemon was not started."
    exit 0
  fi
  echo "Quitting the older Agent Wrangler app…"
  # Labels the quit as an install for an app running its own core: no dialog,
  # and its in-app sessions come back as Interrupted rows.
  mkdir -p "$RUN_DIR"
  printf 'install' > "$RUN_DIR/quit-intent"
  osascript -e 'quit app "Agent Wrangler"' >/dev/null 2>&1 || true
  # It ends its sessions first, bounded at 10 s.
  for _ in $(seq 1 60); do
    old_app_running || break
    sleep 0.5
  done
  rm -f "$RUN_DIR/quit-intent"
  if old_app_running; then
    echo "The older app did not quit within 30 s, so nothing was installed. Quit it and run this again." >&2
    exit 1
  fi
  START_DAEMON=1
fi

# ---- 2. The bundle ----
rm -rf "$DEST"
cp -R "$APP" "$DEST"
echo "Installed $DEST"
echo "Built from: $APP"

# ---- 3. The core daemon ----
NODE="$DEST/Contents/Resources/node/bin/node"
CLI="$DEST/Contents/Resources/app/dist/cli/main.js"
if [ "$START_DAEMON" = "1" ]; then
  "$NODE" "$CLI" daemon start || echo "The core daemon was not moved onto this build: run aw daemon start." >&2
else
  echo "The core daemon is not running; open Agent Wrangler (or run aw daemon start) to start it."
fi

# ---- 4. The aw shim ----
INSTALLED_AW=$(command -v aw 2>/dev/null || true)
if [ -n "$INSTALLED_AW" ] && [ -f "$INSTALLED_AW" ] && [ -w "$INSTALLED_AW" ] \
  && grep -q 'aw: Agent Wrangler from a terminal' "$INSTALLED_AW" 2>/dev/null \
  && ! cmp -s bin/aw "$INSTALLED_AW"; then
  cp bin/aw "$INSTALLED_AW"
  chmod 755 "$INSTALLED_AW"
  echo "Updated $INSTALLED_AW"
fi
