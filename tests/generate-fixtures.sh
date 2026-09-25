#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .tmp
mkdir -p .tmp

# Different durations and, where supported, different bitrates exercise true stream-copy compatibility.
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.55' -c:a aac -b:a 64k  .tmp/a.m4a
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=660:sample_rate=48000:duration=0.73' -c:a aac -b:a 112k .tmp/b.m4a
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.55' -c:a libmp3lame -b:a 80k  .tmp/a.mp3
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=660:sample_rate=48000:duration=0.73' -c:a libmp3lame -b:a 128k .tmp/b.mp3
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.55' -c:a pcm_s16le .tmp/a.wav
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=660:sample_rate=48000:duration=0.73' -c:a pcm_s16le .tmp/b.wav
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.55' -c:a aac -b:a 64k -f adts .tmp/a.aac
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=660:sample_rate=48000:duration=0.73' -c:a aac -b:a 96k -f adts .tmp/b.aac
