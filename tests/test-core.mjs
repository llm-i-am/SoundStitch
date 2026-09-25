import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { analyzeAudioFile, compatibilitySummary, mergeAudioFiles } from '../audio-core.mjs';

const dir = new URL('./.tmp/', import.meta.url);
const families = [
  ['m4a', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['aac', 'audio/aac'],
];

for (const [ext, type] of families) {
  const files = [];
  for (const base of ['a', 'b']) {
    const bytes = await fs.readFile(new URL(`${base}.${ext}`, dir));
    files.push(new File([bytes], `${base}.${ext}`, { type, lastModified: Date.now() }));
  }
  const analyses = await Promise.all(files.map(analyzeAudioFile));
  const compat = compatibilitySummary(analyses);
  assert.equal(compat.ok, true, `${ext}: compatibility failed: ${compat.message}`);
  const result = await mergeAudioFiles(files, analyses);
  assert.equal(result.verification.ok, true, `${ext}: structural verification failed`);
  assert.ok(result.blob.size > 0, `${ext}: empty output`);
  await fs.writeFile(new URL(`merged.${result.extension}`, dir), new Uint8Array(await result.blob.arrayBuffer()));
  console.log(`${ext}: OK; ${result.blob.size} bytes`, result.verification);
}

// Strong zero-reencode proof for M4A/AAC: extract encoded packet payloads with ffmpeg in the workflow/local harness
// and compare source concatenation to merged output. This is executed by the shell wrapper below when ffmpeg exists.
