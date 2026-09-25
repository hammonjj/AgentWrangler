#!/bin/bash
#
# Put `aw` on the PATH: copy bin/aw into the first writable directory of
# $AW_BIN_DIR, /opt/homebrew/bin, /usr/local/bin, ~/.local/bin. A copy, not a
# symlink, so it keeps working when this checkout (or worktree) is removed:
# the shim runs whatever build is installed in /Applications.
set -euo pipefail

cd "$(dirname "$0")/.."

for dir in "${AW_BIN_DIR:-}" /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  [ -n "$dir" ] || continue
  if [ "$dir" = "$HOME/.local/bin" ]; then mkdir -p "$dir"; fi
  if [ -d "$dir" ] && [ -w "$dir" ]; then
    cp bin/aw "$dir/aw"
    chmod 755 "$dir/aw"
    echo "Installed $dir/aw"
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) echo "Note: $dir is not on your PATH." ;;
    esac
    exit 0
  fi
done

echo "No writable directory for aw. Set AW_BIN_DIR to one on your PATH." >&2
exit 1
