#!/usr/bin/env bash
# Spike S5 — throwaway probe for whether `claude --bg` background agents expose
# a structured (stream-json / canUseTool) protocol AW could drive instead of
# its own SDK-hosted `Query`.
#
# Usage: run each block manually against a *scratch* cwd, never a real project.
# Requires the SDK-bundled `claude` binary, not the system one — see
# docs/plans/spikes/s5-bg-agents.md for why that matters.
#
# SAFETY: `claude agents --json` lists every Claude session on the machine,
# not just ones this script started. Only ever act on the `id`/`pid` this
# script itself printed. Never `stop`/`rm`/`attach` an id you did not launch.

set -euo pipefail

SDK_CLAUDE="${SDK_CLAUDE:-$(cd "$(dirname "$0")/../.." && pwd)/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude}"
SCRATCH="${SCRATCH:-/tmp/aw-spike-s5/proj}"
mkdir -p "$SCRATCH"

echo "== binary =="
"$SDK_CLAUDE" --version

echo "== 1. start a cheap background agent =="
cd "$SCRATCH"
OUT=$("$SDK_CLAUDE" --bg --model haiku "Say the word PONG and stop.")
echo "$OUT"
ID=$(echo "$OUT" | sed -n 's/^backgrounded · //p')
echo "id=$ID"

echo "== 2. who hosts it? (pid tree: daemon -> bg-pty-host -> bg-spare) =="
sleep 2
PID=$("$SDK_CLAUDE" agents --json | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    if a.get('id') == '$ID':
        print(a['pid'])
")
ps -o pid,ppid,pgid,command -p "$PID"
ps -o pid,ppid,pgid,command -p "$(ps -o ppid= -p "$PID" | tr -d ' ')"

echo "== 3. does the *launcher* process still exist? (survival check) =="
echo "compare against the 'spawned-by' pid in the daemon's own ps line, e.g.:"
ps -ef | grep 'claude daemon run' | grep -v grep || true

echo "== 4. is 'logs' structured (stream-json) or terminal bytes? =="
"$SDK_CLAUDE" logs "$ID" | head -c 200 | od -c | head -5
echo "(escape codes / box-drawing glyphs here => PTY output, not JSON)"

echo "== 5. clean up =="
"$SDK_CLAUDE" stop "$ID"
"$SDK_CLAUDE" rm "$ID"
"$SDK_CLAUDE" agents --json | python3 -c "
import json,sys
data=json.load(sys.stdin)
assert not any(a.get('id') == '$ID' for a in data), 'agent still listed!'
print('confirmed: agent no longer listed')
"
