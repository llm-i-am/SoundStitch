#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.tmp"
ffmpeg -hide_banner -loglevel error -i a.m4a -map 0:a:0 -c copy -f data a.raw
ffmpeg -hide_banner -loglevel error -i b.m4a -map 0:a:0 -c copy -f data b.raw
cat a.raw b.raw > concat.raw
ffmpeg -hide_banner -loglevel error -i merged.m4a -map 0:a:0 -c copy -f data merged.raw
cmp concat.raw merged.raw
echo "M4A encoded AAC payload: byte-for-byte identical (no re-encode)."
