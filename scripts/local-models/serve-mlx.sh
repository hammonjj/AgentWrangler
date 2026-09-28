#!/usr/bin/env bash
# Serve an MLX (4-bit) model directory with mlx_lm.server on 127.0.0.1, and say
# how to register it with Agent Wrangler as a loopback endpoint.
#
#   scripts/local-models/serve-mlx.sh <model-dir> [port] [options] [-- extra mlx_lm.server args]
#
# Options:
#   --name <name>         Endpoint name in Preferences (default: the model dir's name)
#   --write-entry <file>  Also write the orchestration.localEndpoints entry to <file>
#                         (never settings.json: paste it in yourself, or use Preferences)
#   --print-only          Print the entry and the steps, and do not start the server
#
# It installs nothing and never edits Agent Wrangler's settings. If mlx_lm.server is
# missing it prints the venv commands to install it and exits. The server is always
# bound to 127.0.0.1; a --host in the extra args is refused.
#
# mlx_lm.server is found on PATH, or as $MLX_VENV/bin/mlx_lm.server, or at $MLX_LM_SERVER.
set -euo pipefail

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

model_dir=""
port=""
name=""
entry_file=""
print_only=0
extra=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --name) name="${2:?--name needs a value}"; shift 2 ;;
    --write-entry) entry_file="${2:?--write-entry needs a file}"; shift 2 ;;
    --print-only) print_only=1; shift ;;
    --) shift; extra=("$@"); break ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *)
      if [ -z "$model_dir" ]; then model_dir="$1"
      elif [ -z "$port" ]; then port="$1"
      else echo "Unexpected argument: $1" >&2; usage
      fi
      shift ;;
  esac
done

[ -n "$model_dir" ] || usage
port="${port:-18080}"
case "$port" in
  ''|*[!0-9]*) echo "The port must be a number, not '$port'." >&2; exit 2 ;;
esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
  echo "Pick a port between 1024 and 65535." >&2; exit 2
fi

if [ ! -d "$model_dir" ]; then
  echo "No such directory: $model_dir" >&2; exit 2
fi
model_dir="$(cd "$model_dir" && pwd)"
if [ ! -f "$model_dir/config.json" ] || ! ls "$model_dir"/*.safetensors >/dev/null 2>&1; then
  echo "$model_dir does not look like an MLX model directory (config.json and *.safetensors expected)." >&2
  echo "A GGUF file is for llama-server, not mlx_lm.server." >&2
  exit 2
fi

for arg in ${extra[@]+"${extra[@]}"}; do
  case "$arg" in
    --host|--host=*) echo "Refusing $arg: this script only serves on 127.0.0.1." >&2; exit 2 ;;
    --port|--port=*|--model|--model=*) echo "Refusing $arg: give the model dir and port as arguments." >&2; exit 2 ;;
  esac
done

name="${name:-$(basename "$model_dir")}"

# The endpoint id Agent Wrangler would give this name (newEndpointId): lower case, [a-z0-9-], at most 30.
id="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9][^a-z0-9]*/-/g' -e 's/^-*//' -e 's/-*$//' | cut -c1-30)"
id="${id:-endpoint}"

json_string() {
  # A JSON string literal: backslashes and quotes escaped, control characters dropped.
  printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# mlx_lm.server reports the model by the path it was started with (plan §19.2), and does
# not report a context window. The weights' max_position_embeddings is declared for it.
context=""
if command -v python3 >/dev/null 2>&1; then
  context="$(python3 -c 'import json,sys
c=json.load(open(sys.argv[1]))
v=c.get("max_position_embeddings") or (c.get("text_config") or {}).get("max_position_embeddings")
print(v if isinstance(v,int) and v>0 else "")' "$model_dir/config.json" 2>/dev/null || true)"
fi

url="http://127.0.0.1:$port"
entry="{
  \"id\": $(json_string "$id"),
  \"name\": $(json_string "$name"),
  \"url\": \"$url\",
  \"runtime\": \"mlx\""
if [ -n "$context" ]; then
  entry="$entry,
  \"models\": { $(json_string "$model_dir"): { \"contextWindow\": $context } }"
fi
entry="$entry
}"

cat <<EOF
Agent Wrangler endpoint for this server
=======================================

Either: Preferences → Orchestration → Local endpoints
  1. URL: $url    Name: $name    → Add endpoint
     (a loopback endpoint is on as soon as it is added; the probe detects the runtime as MLX)
  2. Once the server below says it is listening, press Probe on the card.
  3. Tier map: give the model a tier. MLX is completion-only in Agent Wrangler:
     basic (the weakest) answers assessments; standard or above can plan missions that
     prefer local models. It is never given agentic coding tasks (no /v1/responses).
  4. Optional: Qualify, to measure its JSON replies.

Or: add this entry to the "orchestration.localEndpoints" array in settings.json
(Agent Wrangler's support folder), with the app quit:

$entry

EOF

if [ -n "$entry_file" ]; then
  case "$(basename "$entry_file")" in
    settings.json) echo "Refusing to write $entry_file: this script never writes settings.json." >&2; exit 2 ;;
  esac
  printf '%s\n' "$entry" > "$entry_file"
  echo "Wrote the entry to $entry_file"
  echo
fi

server="${MLX_LM_SERVER:-}"
if [ -z "$server" ]; then
  if command -v mlx_lm.server >/dev/null 2>&1; then server="$(command -v mlx_lm.server)"
  elif [ -n "${MLX_VENV:-}" ] && [ -x "$MLX_VENV/bin/mlx_lm.server" ]; then server="$MLX_VENV/bin/mlx_lm.server"
  fi
fi

if [ -z "$server" ] || [ ! -x "$server" ]; then
  cat >&2 <<'EOF'
mlx_lm.server was not found. Nothing was installed. To install it in a venv of your choosing:

  python3 -m venv ~/venvs/mlx
  ~/venvs/mlx/bin/pip install mlx-lm

then run this script again with MLX_VENV=~/venvs/mlx (or put ~/venvs/mlx/bin on PATH).
EOF
  exit 1
fi

if [ "$print_only" = 1 ]; then
  echo "Would run: $server --model $model_dir --host 127.0.0.1 --port $port ${extra[*]+${extra[*]}}"
  exit 0
fi

echo "Starting: $server --model $model_dir --host 127.0.0.1 --port $port ${extra[*]+${extra[*]}}"
exec "$server" --model "$model_dir" --host 127.0.0.1 --port "$port" ${extra[@]+"${extra[@]}"}
