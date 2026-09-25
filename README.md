# SoundStitch

**A tiny, static, mobile-first audio joiner that keeps the audio on your device.**

SoundStitch is designed for iPhone Safari and Add to Home Screen. Pick multiple compatible audio files, name the output, sort the sequence, and merge them without decoding/re-encoding the audio. There is no server, upload, analytics SDK, FFmpeg/WASM bundle, or runtime CDN dependency.

## Why this architecture

The fastest reliable no-reencode path is container-aware remuxing, not decoding audio and not blindly concatenating whole files.

- **M4A / MP4 with AAC:** parses the MP4 audio sample tables, reuses the original compressed AAC packets as `Blob.slice()` parts, and writes fresh MP4 timing/chunk/sample tables. This is the primary iPhone / Voice Memos path.
- **MP3:** strips file-level tags/stale Xing/VBRI headers as needed and joins compatible Layer III frame streams.
- **WAV:** supports compatible uncompressed PCM/IEEE-float WAV and writes a new RIFF header around the original PCM data chunks.
- **AAC / ADTS:** joins compatible ADTS frame streams.

The large audio payload remains as browser `Blob`/`File` parts as far as practical. JavaScript reads structural metadata and small headers, rather than decoding the entire recording to PCM.

## iPhone UX

- Big **Select audio files** button on load.
- Filename prompt immediately after the first selection.
- Default ordering: **date oldest → newest**.
- Alternate sorting: date newest → oldest, filename A → Z, or manual.
- Manual ordering supports a touch/pointer drag handle plus reliable ↑/↓ fallback buttons. The arrows wrap: top + ↑ goes to the bottom; bottom + ↓ goes to the top.
- Compact rows and controls to minimize scrolling.
- Merge output is structurally verified before the browser download is triggered.
- Tiny `diag` button copies a large diagnostic snapshot (browser/PWA capabilities, storage/service-worker state, selected-file metadata, parser results, output verification, and event logs). It does **not** copy audio bytes.

## What “date” means

The Web File API only guarantees a file's **last modified** timestamp, not its filesystem creation date. SoundStitch therefore prefers embedded media metadata when it can extract a credible date:

- M4A/MP4: QuickTime/ISO-BMFF creation timestamp.
- MP3/AAC: ID3 date fields where present.
- WAV: INFO/ICRD where present.
- Otherwise: `File.lastModified` from the browser.

## Compatibility rules

SoundStitch deliberately rejects inputs rather than silently re-encode or create a dubious output.

### M4A / MP4 AAC

Inputs must be ordinary, non-video, non-fragmented AAC-in-MP4 audio with matching AAC decoder configuration, channel count, sample rate, sample size, and media timescale. The parser accepts normal `stsz` sample-size tables; compact `stz2` tables are currently rejected. Files with edit lists are accepted, but see the gapless caveat below.

### MP3

MPEG Layer III inputs must have matching MPEG version, sample rate, and channel count. Bitrates may differ.

### WAV

PCM, IEEE float, or compatible extensible PCM/float WAV only, with identical format settings. Standard RIFF's 4 GiB size limit applies; RF64 is not emitted yet.

### AAC / ADTS

ADTS AAC files must have matching profile, sample-rate index, and channel count. Bitrates may differ.

### Mixed formats

M4A + MP3 + WAV etc. are intentionally rejected in v1. Joining mixed codecs/containers into one universally playable file without re-encoding is not a general operation.

## AAC gapless caveat

Independently encoded AAC clips can contain encoder priming and padding. Apple documents AAC encoder delay and the role of MP4 edit lists/sample groups in trimming it. SoundStitch preserves the compressed packets instead of re-encoding, so it cannot synthesize missing source-level PCM at clip boundaries. Depending on how each source was encoded, a very small boundary gap/padding artifact can therefore remain. For voice recordings, preserving source quality and speed is normally preferable to a full decode/re-encode pass.

## PWA / offline

`manifest.webmanifest`, Apple Home Screen metadata/icons, and `sw.js` make the UI installable and cache the application shell for offline use after the first successful load. Selected files themselves are not persisted.

## Tests

The test harness uses FFmpeg only as an **external oracle**; FFmpeg is not part of the website.

```bash
bash tests/generate-fixtures.sh
node tests/test-core.mjs
bash tests/verify-payloads.sh
for f in tests/.tmp/merged.{m4a,mp3,wav,aac}; do ffmpeg -v error -i "$f" -f null -; done
```

`verify-payloads.sh` extracts the AAC packet payload from both source M4A files and the merged M4A and requires the merged payload to equal `source A || source B` byte-for-byte. That is a strong regression test that the M4A path is remuxing, not re-encoding.

## GitHub Pages

The repository includes the official Pages Actions pattern in `.github/workflows/pages.yml`. After creating the repository, enable **Settings → Pages → Build and deployment → Source: GitHub Actions** once. Every push to `main` then deploys the static root.

For a repository named `SoundStitch` under `llm-i-am`, the conventional project-site URL is:

`https://llm-i-am.github.io/SoundStitch/`

## Technical references

- W3C File API: https://www.w3.org/TR/FileAPI/
- MDN File.lastModified: https://developer.mozilla.org/en-US/docs/Web/API/File/lastModified
- MDN Blob.slice(): https://developer.mozilla.org/en-US/docs/Web/API/Blob/slice
- Apple QuickTime File Format — AAC priming / encoder delay: https://developer.apple.com/documentation/quicktime-file-format/appendix_g_audio_priming_handling_encoder_delay_in_aac
- GitHub Pages custom workflows: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages

## Privacy

All audio processing is local in the browser. SoundStitch makes no network request for the selected audio files and contains no telemetry service. Normal browser requests for the static app files are still made to the hosting origin.
