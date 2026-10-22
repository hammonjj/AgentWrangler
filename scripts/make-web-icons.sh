#!/usr/bin/env bash
# The web icons (#162), made from the app icon: `build/icons/1024x1024.png` (James's
# `agentwrangler.iconset`) is the one source of truth. The output, `src/webview/icons/`, is
# committed; `esbuild.mjs` copies it into `dist/webview/icons/` (the workbench the daemon
# serves, `src/shared/installable.ts`) and into `dist/relay-site/` (the relay loader).
# Run it again only when the app icon changes. Needs macOS `sips` and `ffmpeg`.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/build/icons/1024x1024.png"
out="$root/src/webview/icons"
mkdir -p "$out"

sips -z 192 192 "$src" --out "$out/icon-192.png" >/dev/null
cp "$root/build/icons/512x512.png" "$out/icon-512.png"
sips -z 180 180 "$src" --out "$out/apple-touch-icon.png" >/dev/null
cp "$root/build/icons/32x32.png" "$out/favicon.png"

# Maskable: full-bleed background, the icon at 75% so all of it sits inside the 80% safe
# circle a launcher may cut it to. The colour is the icon's own background; the source's
# pure-black corners (outside its rounded square) are keyed out so they take it too.
ffmpeg -v error -y -f lavfi -i "color=c=0x0a1326:s=512x512" -i "$src" \
  -filter_complex "[0:v]format=rgba[b];[1:v]format=rgba,colorkey=0x000000:0.02:0,scale=384:384[i];[b][i]overlay=64:64:format=rgb,format=rgba" \
  -frames:v 1 "$out/icon-maskable-512.png"
