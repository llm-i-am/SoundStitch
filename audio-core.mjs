/* SoundStitch audio core
 * Pure client-side, no-reencode audio joining for compatible M4A/MP4(AAC), MP3, WAV, and ADTS AAC.
 * Designed for static hosting and iOS Safari: large media payloads stay as Blob/File slices whenever possible.
 */

export const CORE_VERSION = '2026.09.25.1';

const MP4_EPOCH_OFFSET = 2082844800;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class MergeError extends Error {
  constructor(message, code = 'MERGE_ERROR', details = undefined) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
    this.details = details;
  }
}

function assert(condition, message, code = 'INVALID_FILE', details) {
  if (!condition) throw new MergeError(message, code, details);
}

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function extensionOf(name = '') {
  const m = /\.([^.]+)$/.exec(name.toLowerCase());
  return m ? m[1] : '';
}

function ascii(u8, start, length) {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(u8[start + i] ?? 0);
  return s;
}

function hex(u8) {
  return Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
}

function readU16BE(u8, o) { return (u8[o] << 8) | u8[o + 1]; }
function readU24BE(u8, o) { return (u8[o] * 0x10000) + (u8[o + 1] << 8) + u8[o + 2]; }
function readU32BE(u8, o) { return (u8[o] * 0x1000000) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3]; }
function readU32LE(u8, o) { return u8[o] + (u8[o + 1] << 8) + (u8[o + 2] << 16) + (u8[o + 3] * 0x1000000); }
function readU64BE(u8, o) {
  return (BigInt(readU32BE(u8, o)) << 32n) | BigInt(readU32BE(u8, o + 4));
}

function safeNumber(big, label = 'value') {
  assert(big <= MAX_SAFE_BIGINT, `${label} exceeds JavaScript's safe integer range.`, 'TOO_LARGE');
  return Number(big);
}

async function readBytes(file, start, length) {
  const end = Math.min(file.size, start + length);
  assert(start >= 0 && start <= end, 'Invalid file read range.');
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

// ---------- Generic binary writer ----------

function u8(...values) { return Uint8Array.from(values); }
function u16be(n) { return u8((n >>> 8) & 255, n & 255); }
function u24be(n) { return u8((n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
function u32be(n) {
  const x = Number(n) >>> 0;
  return u8((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
}
function u64be(n) {
  let x = BigInt(n);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { out[i] = Number(x & 255n); x >>= 8n; }
  return out;
}
function str4(s) {
  assert(s.length === 4, `FourCC must be 4 characters: ${s}`);
  return u8(...Array.from(s, ch => ch.charCodeAt(0) & 255));
}
function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected byte array');
}
function concatBytes(parts) {
  const arrs = parts.filter(Boolean).map(bytesOf);
  const total = arrs.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.byteLength; }
  return out;
}
function box(type, ...payloadParts) {
  const payload = concatBytes(payloadParts);
  const size = 8 + payload.byteLength;
  assert(size <= 0xffffffff, `Metadata box ${type} is too large.`, 'TOO_LARGE');
  return concatBytes([u32be(size), str4(type), payload]);
}
function fullBox(type, version, flags, ...payload) {
  return box(type, u8(version), u24be(flags), ...payload);
}

function writeU32BEInto(out, offset, n) {
  out[offset] = (n >>> 24) & 255;
  out[offset + 1] = (n >>> 16) & 255;
  out[offset + 2] = (n >>> 8) & 255;
  out[offset + 3] = n & 255;
}
function writeU32LEInto(out, offset, n) {
  out[offset] = n & 255;
  out[offset + 1] = (n >>> 8) & 255;
  out[offset + 2] = (n >>> 16) & 255;
  out[offset + 3] = (n >>> 24) & 255;
}

// ---------- ISO BMFF / M4A ----------

function parseBoxHeaderFromBuffer(data, offset, limit = data.byteLength) {
  if (offset + 8 > limit) return null;
  const size32 = readU32BE(data, offset);
  const type = ascii(data, offset + 4, 4);
  let headerSize = 8;
  let size;
  if (size32 === 1) {
    if (offset + 16 > limit) return null;
    size = safeNumber(readU64BE(data, offset + 8), `${type} box size`);
    headerSize = 16;
  } else if (size32 === 0) {
    size = limit - offset;
  } else {
    size = size32;
  }
  if (size < headerSize || offset + size > limit) return null;
  return { type, start: offset, size, headerSize, end: offset + size, payloadStart: offset + headerSize };
}

function listBoxes(data, start = 0, end = data.byteLength) {
  const boxes = [];
  let o = start;
  while (o + 8 <= end) {
    const b = parseBoxHeaderFromBuffer(data, o, end);
    if (!b) break;
    boxes.push(b);
    o = b.end;
  }
  return boxes;
}

function childBox(data, parent, type) {
  return listBoxes(data, parent.payloadStart, parent.end).find(b => b.type === type) || null;
}

function childBoxes(data, parent, type) {
  return listBoxes(data, parent.payloadStart, parent.end).filter(b => !type || b.type === type);
}

async function readFileBoxHeader(file, offset) {
  const head = await readBytes(file, offset, 16);
  if (head.byteLength < 8) return null;
  const size32 = readU32BE(head, 0);
  const type = ascii(head, 4, 4);
  let headerSize = 8;
  let size;
  if (size32 === 1) {
    assert(head.byteLength >= 16, `Truncated extended ${type} header.`);
    size = safeNumber(readU64BE(head, 8), `${type} box size`);
    headerSize = 16;
  } else if (size32 === 0) {
    size = file.size - offset;
  } else {
    size = size32;
  }
  assert(size >= headerSize && offset + size <= file.size, `Invalid ${type} box size.`, 'INVALID_MP4');
  return { type, start: offset, size, headerSize, end: offset + size, payloadStart: offset + headerSize };
}

async function scanTopLevelMp4(file) {
  const boxes = [];
  let offset = 0;
  let guard = 0;
  while (offset + 8 <= file.size && guard++ < 100000) {
    const b = await readFileBoxHeader(file, offset);
    if (!b) break;
    boxes.push(b);
    assert(b.end > offset, 'Zero-length MP4 box.', 'INVALID_MP4');
    offset = b.end;
  }
  return boxes;
}

function parseMvhd(data, b) {
  const p = b.payloadStart;
  const version = data[p];
  let creation, modification, timescale, duration;
  if (version === 1) {
    creation = readU64BE(data, p + 4);
    modification = readU64BE(data, p + 12);
    timescale = readU32BE(data, p + 20);
    duration = readU64BE(data, p + 24);
  } else {
    creation = BigInt(readU32BE(data, p + 4));
    modification = BigInt(readU32BE(data, p + 8));
    timescale = readU32BE(data, p + 12);
    duration = BigInt(readU32BE(data, p + 16));
  }
  return { version, creation, modification, timescale, duration };
}

function parseMdhd(data, b) {
  const p = b.payloadStart;
  const version = data[p];
  let creation, modification, timescale, duration, langOffset;
  if (version === 1) {
    creation = readU64BE(data, p + 4);
    modification = readU64BE(data, p + 12);
    timescale = readU32BE(data, p + 20);
    duration = readU64BE(data, p + 24);
    langOffset = p + 32;
  } else {
    creation = BigInt(readU32BE(data, p + 4));
    modification = BigInt(readU32BE(data, p + 8));
    timescale = readU32BE(data, p + 12);
    duration = BigInt(readU32BE(data, p + 16));
    langOffset = p + 20;
  }
  const language = readU16BE(data, langOffset);
  return { version, creation, modification, timescale, duration, language };
}

function parseHdlr(data, b) {
  const p = b.payloadStart;
  return ascii(data, p + 8, 4);
}

function parseStts(data, b) {
  const count = readU32BE(data, b.payloadStart + 4);
  const runs = [];
  let o = b.payloadStart + 8;
  let sampleCount = 0n;
  let duration = 0n;
  for (let i = 0; i < count; i++, o += 8) {
    assert(o + 8 <= b.end, 'Truncated stts box.', 'INVALID_MP4');
    const n = readU32BE(data, o);
    const delta = readU32BE(data, o + 4);
    runs.push({ count: n, delta });
    sampleCount += BigInt(n);
    duration += BigInt(n) * BigInt(delta);
  }
  return { runs, sampleCount: safeNumber(sampleCount, 'sample count'), duration };
}

function parseCtts(data, b) {
  const version = data[b.payloadStart];
  const count = readU32BE(data, b.payloadStart + 4);
  let o = b.payloadStart + 8;
  let allZero = true;
  for (let i = 0; i < count; i++, o += 8) {
    assert(o + 8 <= b.end, 'Truncated ctts box.', 'INVALID_MP4');
    const raw = readU32BE(data, o + 4);
    const value = version === 1 && raw > 0x7fffffff ? raw - 0x100000000 : raw;
    if (value !== 0) allZero = false;
  }
  return { version, allZero };
}

function parseStsc(data, b) {
  const count = readU32BE(data, b.payloadStart + 4);
  const entries = [];
  let o = b.payloadStart + 8;
  for (let i = 0; i < count; i++, o += 12) {
    assert(o + 12 <= b.end, 'Truncated stsc box.', 'INVALID_MP4');
    entries.push({
      firstChunk: readU32BE(data, o),
      samplesPerChunk: readU32BE(data, o + 4),
      sampleDescriptionIndex: readU32BE(data, o + 8),
    });
  }
  assert(entries.length && entries[0].firstChunk === 1, 'Invalid stsc table.', 'INVALID_MP4');
  return entries;
}

function parseStsz(data, b) {
  const p = b.payloadStart;
  const defaultSize = readU32BE(data, p + 4);
  const count = readU32BE(data, p + 8);
  const sizes = new Uint32Array(count);
  if (defaultSize) {
    sizes.fill(defaultSize);
  } else {
    let o = p + 12;
    assert(o + count * 4 <= b.end, 'Truncated stsz table.', 'INVALID_MP4');
    for (let i = 0; i < count; i++, o += 4) sizes[i] = readU32BE(data, o);
  }
  return { defaultSize, sizes };
}

function parseChunkOffsets(data, b) {
  const count = readU32BE(data, b.payloadStart + 4);
  const offsets = new Array(count);
  let o = b.payloadStart + 8;
  if (b.type === 'co64') {
    assert(o + count * 8 <= b.end, 'Truncated co64 table.', 'INVALID_MP4');
    for (let i = 0; i < count; i++, o += 8) offsets[i] = safeNumber(readU64BE(data, o), 'chunk offset');
  } else {
    assert(o + count * 4 <= b.end, 'Truncated stco table.', 'INVALID_MP4');
    for (let i = 0; i < count; i++, o += 4) offsets[i] = readU32BE(data, o);
  }
  return offsets;
}

function findDescriptorSpecificInfo(data, start, end) {
  // AAC AudioSpecificConfig is carried by DecoderSpecificInfo descriptor tag 0x05.
  // ESDS also contains fixed fields, so a bounded scan is more resilient than pretending
  // the whole payload is a recursively nested descriptor stream.
  for (let i = start; i < end - 2; i++) {
    if (data[i] !== 0x05) continue;
    let len = 0;
    let pos = i + 1;
    let nbytes = 0;
    while (pos < end && nbytes < 4) {
      const v = data[pos++];
      len = (len << 7) | (v & 0x7f);
      nbytes++;
      if ((v & 0x80) === 0) break;
    }
    if (nbytes && len >= 2 && len <= 64 && pos + len <= end) {
      const asc = data.slice(pos, pos + len);
      // Audio Object Type is the first 5 bits and cannot be 0 or 31 without extension handling.
      const objectType = asc[0] >> 3;
      if (objectType > 0 && objectType < 31) return asc;
    }
  }
  return null;
}

function parseAudioSampleEntry(data, stsd) {
  const p = stsd.payloadStart;
  const entryCount = readU32BE(data, p + 4);
  assert(entryCount >= 1, 'No sample description in M4A audio track.', 'INVALID_MP4');
  const entry = parseBoxHeaderFromBuffer(data, p + 8, stsd.end);
  assert(entry, 'Invalid audio sample entry.', 'INVALID_MP4');
  assert(entry.type === 'mp4a', `Unsupported M4A codec sample entry: ${entry.type}.`, 'UNSUPPORTED_CODEC');
  assert(entry.start + 36 <= entry.end, 'Truncated mp4a sample entry.', 'INVALID_MP4');

  const version = readU16BE(data, entry.start + 16);
  const channels = readU16BE(data, entry.start + 24);
  const sampleSize = readU16BE(data, entry.start + 26);
  const sampleRate = readU32BE(data, entry.start + 32) / 65536;
  let childStart = entry.start + 36;
  if (version === 1) childStart += 16;
  else if (version === 2) childStart += 36;
  assert(childStart <= entry.end, 'Invalid mp4a sample entry version.', 'INVALID_MP4');

  let esds = null;
  const direct = listBoxes(data, childStart, entry.end);
  esds = direct.find(x => x.type === 'esds') || null;
  if (!esds) {
    // Some QuickTime-style entries place ESDS under a 'wave' container.
    const wave = direct.find(x => x.type === 'wave');
    if (wave) esds = listBoxes(data, wave.payloadStart, wave.end).find(x => x.type === 'esds') || null;
  }
  assert(esds, 'AAC decoder configuration (esds) was not found.', 'UNSUPPORTED_MP4');
  const asc = findDescriptorSpecificInfo(data, esds.payloadStart + 4, esds.end);
  assert(asc, 'AAC AudioSpecificConfig was not found in esds.', 'UNSUPPORTED_MP4');

  return {
    type: entry.type,
    version,
    channels,
    sampleSize,
    sampleRate,
    asc,
    fingerprint: `${entry.type}|${sampleRate}|${channels}|${sampleSize}|${hex(asc)}`,
  };
}

function chunkLayout(stsc, offsets, sampleSizes, fileSize) {
  const chunks = [];
  let sampleIndex = 0;
  let stscIndex = 0;
  for (let c = 1; c <= offsets.length; c++) {
    while (stscIndex + 1 < stsc.length && c >= stsc[stscIndex + 1].firstChunk) stscIndex++;
    const map = stsc[stscIndex];
    assert(map.sampleDescriptionIndex === 1, 'Multiple sample descriptions are not supported.', 'UNSUPPORTED_MP4');
    const n = map.samplesPerChunk;
    assert(sampleIndex + n <= sampleSizes.length, 'stsc references more samples than stsz contains.', 'INVALID_MP4');
    let length = 0;
    for (let j = 0; j < n; j++) length += sampleSizes[sampleIndex + j];
    const offset = offsets[c - 1];
    assert(offset >= 0 && offset + length <= fileSize, 'Audio chunk points outside the source file.', 'INVALID_MP4');
    chunks.push({ offset, length, sampleStart: sampleIndex, sampleCount: n });
    sampleIndex += n;
  }
  assert(sampleIndex === sampleSizes.length, `Chunk table accounts for ${sampleIndex} of ${sampleSizes.length} samples.`, 'INVALID_MP4');
  return chunks;
}

function mp4TimeToMs(seconds1904) {
  const sec = Number(seconds1904);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const unix = sec - MP4_EPOCH_OFFSET;
  const ms = unix * 1000;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  // Reject obviously bogus legacy encoder timestamps that predate practical digital recording workflows.
  if (d.getUTCFullYear() < 1970 || d.getUTCFullYear() > 2200) return null;
  return ms;
}

async function parseMp4Audio(file, { metadataOnly = false } = {}) {
  const top = await scanTopLevelMp4(file);
  const ftyp = top.find(b => b.type === 'ftyp');
  const moov = top.find(b => b.type === 'moov');
  assert(ftyp && moov, 'This file is not a complete M4A/MP4 file (ftyp/moov missing).', 'INVALID_MP4');
  assert(!top.some(b => b.type === 'moof'), 'Fragmented MP4/M4A inputs are not supported yet.', 'FRAGMENTED_MP4');
  assert(moov.size <= 128 * 1024 * 1024, 'The MP4 metadata table is too large for safe mobile processing.', 'TOO_LARGE');

  const [ftypRaw0, moovData] = await Promise.all([
    readBytes(file, ftyp.start, ftyp.size),
    readBytes(file, moov.start, moov.size),
  ]);
  const ftypRaw = new Uint8Array(ftypRaw0);
  const root = parseBoxHeaderFromBuffer(moovData, 0, moovData.byteLength);
  assert(root?.type === 'moov', 'Invalid moov box.', 'INVALID_MP4');
  const mvhdBox = childBox(moovData, root, 'mvhd');
  assert(mvhdBox, 'MP4 movie header is missing.', 'INVALID_MP4');
  const mvhd = parseMvhd(moovData, mvhdBox);

  const traks = childBoxes(moovData, root, 'trak');
  const trackSummaries = [];
  for (const trak of traks) {
    const mdia = childBox(moovData, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = childBox(moovData, mdia, 'hdlr');
    if (!hdlr) continue;
    trackSummaries.push({ trak, mdia, handler: parseHdlr(moovData, hdlr) });
  }
  const videos = trackSummaries.filter(t => t.handler === 'vide');
  assert(videos.length === 0, 'MP4 files containing video are not accepted as audio inputs.', 'HAS_VIDEO');
  const audioTracks = trackSummaries.filter(t => t.handler === 'soun');
  assert(audioTracks.length === 1, `Expected exactly one audio track; found ${audioTracks.length}.`, 'UNSUPPORTED_MP4');
  const { trak, mdia } = audioTracks[0];
  const mdhdBox = childBox(moovData, mdia, 'mdhd');
  const minf = childBox(moovData, mdia, 'minf');
  assert(mdhdBox && minf, 'Incomplete audio track metadata.', 'INVALID_MP4');
  const mdhd = parseMdhd(moovData, mdhdBox);
  const stbl = childBox(moovData, minf, 'stbl');
  assert(stbl, 'Audio sample table is missing.', 'INVALID_MP4');

  const stsd = childBox(moovData, stbl, 'stsd');
  const sttsBox = childBox(moovData, stbl, 'stts');
  const stscBox = childBox(moovData, stbl, 'stsc');
  const stszBox = childBox(moovData, stbl, 'stsz');
  const stz2Box = childBox(moovData, stbl, 'stz2');
  const stcoBox = childBox(moovData, stbl, 'stco') || childBox(moovData, stbl, 'co64');
  assert(stsd && sttsBox && stscBox && stcoBox, 'Required MP4 audio sample tables are missing.', 'INVALID_MP4');
  assert(stszBox && !stz2Box, 'Compact MP4 sample-size tables (stz2) are not supported yet.', 'UNSUPPORTED_MP4');

  const ctts = childBox(moovData, stbl, 'ctts');
  if (ctts) assert(parseCtts(moovData, ctts).allZero, 'Non-zero composition offsets in audio are not supported.', 'UNSUPPORTED_MP4');

  const sampleEntry = parseAudioSampleEntry(moovData, stsd);
  const stts = parseStts(moovData, sttsBox);
  const stsc = parseStsc(moovData, stscBox);
  const stsz = parseStsz(moovData, stszBox);
  const offsets = parseChunkOffsets(moovData, stcoBox);
  assert(stts.sampleCount === stsz.sizes.length, 'stts/stsz sample counts disagree.', 'INVALID_MP4');
  const chunks = chunkLayout(stsc, offsets, stsz.sizes, file.size);

  let mediaBytes = 0;
  for (const s of stsz.sizes) mediaBytes += s;
  const durationSeconds = Number(stts.duration) / mdhd.timescale;
  const embeddedCreatedMs = mp4TimeToMs(mvhd.creation) || mp4TimeToMs(mdhd.creation);

  return {
    kind: 'm4a',
    family: 'm4a',
    label: 'M4A/AAC',
    extension: 'm4a',
    mime: 'audio/mp4',
    file,
    ftypRaw,
    moovBytes: moov.size,
    topLevel: top.map(b => ({ type: b.type, size: b.size })),
    stsdRaw: new Uint8Array(moovData.slice(stsd.start, stsd.end)),
    sampleEntry,
    timescale: mdhd.timescale,
    language: mdhd.language,
    sttsRuns: stts.runs,
    durationUnits: stts.duration,
    durationSeconds,
    sampleSizes: stsz.sizes,
    sampleCount: stsz.sizes.length,
    chunks,
    mediaBytes,
    embeddedCreatedMs,
    dateSource: embeddedCreatedMs ? 'MP4 mvhd/mdhd creation time' : 'File.lastModified fallback',
    createdMs: embeddedCreatedMs ?? file.lastModified ?? Date.now(),
    warnings: childBox(moovData, trak, 'edts') ? ['Source has an edit list; encoded AAC priming/padding cannot be perfectly removed between independently encoded clips without re-encoding.'] : [],
  };
}

function mp4CreationSeconds(ms) {
  const sec = BigInt(Math.max(0, Math.floor((ms || Date.now()) / 1000) + MP4_EPOCH_OFFSET));
  return sec;
}

function buildMvhd(creation, timescale, duration) {
  const version = creation > 0xffffffffn || duration > 0xffffffffn ? 1 : 0;
  const datesAndDuration = version === 1
    ? concatBytes([u64be(creation), u64be(creation), u32be(timescale), u64be(duration)])
    : concatBytes([u32be(Number(creation)), u32be(Number(creation)), u32be(timescale), u32be(Number(duration))]);
  const matrix = concatBytes([
    u32be(0x00010000), u32be(0), u32be(0),
    u32be(0), u32be(0x00010000), u32be(0),
    u32be(0), u32be(0), u32be(0x40000000),
  ]);
  return fullBox('mvhd', version, 0,
    datesAndDuration,
    u32be(0x00010000), // rate 1.0
    u16be(0x0100), // volume 1.0
    u16be(0),
    new Uint8Array(8),
    matrix,
    new Uint8Array(24),
    u32be(2),
  );
}

function buildTkhd(creation, movieDuration) {
  const version = creation > 0xffffffffn || movieDuration > 0xffffffffn ? 1 : 0;
  const lead = version === 1
    ? concatBytes([u64be(creation), u64be(creation), u32be(1), u32be(0), u64be(movieDuration)])
    : concatBytes([u32be(Number(creation)), u32be(Number(creation)), u32be(1), u32be(0), u32be(Number(movieDuration))]);
  const matrix = concatBytes([
    u32be(0x00010000), u32be(0), u32be(0),
    u32be(0), u32be(0x00010000), u32be(0),
    u32be(0), u32be(0), u32be(0x40000000),
  ]);
  return fullBox('tkhd', version, 0x000007,
    lead,
    new Uint8Array(8),
    u16be(0), u16be(0), u16be(0x0100), u16be(0),
    matrix,
    u32be(0), u32be(0),
  );
}

function buildMdhd(creation, timescale, duration, language) {
  const version = creation > 0xffffffffn || duration > 0xffffffffn ? 1 : 0;
  const lead = version === 1
    ? concatBytes([u64be(creation), u64be(creation), u32be(timescale), u64be(duration)])
    : concatBytes([u32be(Number(creation)), u32be(Number(creation)), u32be(timescale), u32be(Number(duration))]);
  return fullBox('mdhd', version, 0, lead, u16be(language || 0x55c4), u16be(0));
}

function buildHdlr() {
  const name = new TextEncoder().encode('SoundStitch\0');
  return fullBox('hdlr', 0, 0, u32be(0), str4('soun'), new Uint8Array(12), name);
}

function buildDinf() {
  const url = fullBox('url ', 0, 1);
  const dref = fullBox('dref', 0, 0, u32be(1), url);
  return box('dinf', dref);
}

function compressSttsRuns(allRuns) {
  const out = [];
  for (const r of allRuns) {
    if (!r.count) continue;
    const last = out[out.length - 1];
    if (last && last.delta === r.delta && last.count + r.count <= 0xffffffff) last.count += r.count;
    else out.push({ count: r.count, delta: r.delta });
  }
  return out;
}

function buildStts(runs) {
  const parts = [u32be(runs.length)];
  for (const r of runs) parts.push(u32be(r.count), u32be(r.delta));
  return fullBox('stts', 0, 0, ...parts);
}

function buildStsc(chunkSampleCounts) {
  const entries = [];
  let last = null;
  for (let i = 0; i < chunkSampleCounts.length; i++) {
    const count = chunkSampleCounts[i];
    if (!last || last.samplesPerChunk !== count) {
      last = { firstChunk: i + 1, samplesPerChunk: count, sampleDescriptionIndex: 1 };
      entries.push(last);
    }
  }
  const parts = [u32be(entries.length)];
  for (const e of entries) parts.push(u32be(e.firstChunk), u32be(e.samplesPerChunk), u32be(1));
  return fullBox('stsc', 0, 0, ...parts);
}

function buildStsz(sampleSizes) {
  let constant = sampleSizes.length ? sampleSizes[0] : 0;
  for (let i = 1; i < sampleSizes.length && constant; i++) if (sampleSizes[i] !== constant) constant = 0;
  if (constant) return fullBox('stsz', 0, 0, u32be(constant), u32be(sampleSizes.length));
  const header = fullBox('stsz', 0, 0, u32be(0), u32be(sampleSizes.length));
  // Avoid one tiny Uint8Array allocation per sample.
  const out = new Uint8Array(header.byteLength + sampleSizes.length * 4);
  out.set(header, 0);
  let o = header.byteLength;
  for (let i = 0; i < sampleSizes.length; i++, o += 4) writeU32BEInto(out, o, sampleSizes[i]);
  writeU32BEInto(out, 0, out.byteLength);
  return out;
}

function buildChunkOffsets(offsets) {
  const use64 = offsets.some(x => x > 0xffffffff);
  const count = offsets.length;
  if (!use64) {
    const out = new Uint8Array(16 + count * 4);
    writeU32BEInto(out, 0, out.byteLength);
    out.set(str4('stco'), 4);
    // version/flags are zero at 8..11
    writeU32BEInto(out, 12, count);
    let o = 16;
    for (const x of offsets) { writeU32BEInto(out, o, x); o += 4; }
    return out;
  }
  const parts = [u32be(count)];
  for (const x of offsets) parts.push(u64be(BigInt(x)));
  return fullBox('co64', 0, 0, ...parts);
}

function buildMoov({ creationMs, mediaTimescale, mediaDuration, language, stsdRaw, sttsRuns, sampleSizes, chunkSampleCounts, chunkOffsets }) {
  const creation = mp4CreationSeconds(creationMs);
  const movieTimescale = 1000;
  const movieDuration = (mediaDuration * BigInt(movieTimescale) + BigInt(Math.floor(mediaTimescale / 2))) / BigInt(mediaTimescale);
  const mvhd = buildMvhd(creation, movieTimescale, movieDuration);
  const tkhd = buildTkhd(creation, movieDuration);
  const mdhd = buildMdhd(creation, mediaTimescale, mediaDuration, language);
  const hdlr = buildHdlr();
  const smhd = fullBox('smhd', 0, 0, u16be(0), u16be(0));
  const dinf = buildDinf();
  const stts = buildStts(sttsRuns);
  const stsc = buildStsc(chunkSampleCounts);
  const stsz = buildStsz(sampleSizes);
  const stco = buildChunkOffsets(chunkOffsets);
  const stbl = box('stbl', stsdRaw, stts, stsc, stsz, stco);
  const minf = box('minf', smhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  return box('moov', mvhd, trak);
}

function buildMdatHeader(mediaBytes) {
  const total8 = BigInt(mediaBytes) + 8n;
  if (total8 <= 0xffffffffn) return concatBytes([u32be(Number(total8)), str4('mdat')]);
  return concatBytes([u32be(1), str4('mdat'), u64be(BigInt(mediaBytes) + 16n)]);
}

function coalesceSourceChunks(chunks) {
  const ranges = [];
  for (const c of chunks) {
    const last = ranges[ranges.length - 1];
    if (last && last.offset + last.length === c.offset) last.length += c.length;
    else ranges.push({ offset: c.offset, length: c.length });
  }
  return ranges;
}

async function mergeM4a(files, analyses, progress) {
  const first = analyses[0];
  for (let i = 1; i < analyses.length; i++) {
    const a = analyses[i];
    assert(a.sampleEntry.fingerprint === first.sampleEntry.fingerprint,
      `AAC settings differ between “${files[0].name}” and “${files[i].name}”. Use files with the same codec profile, sample rate, and channel count.`,
      'INCOMPATIBLE_AUDIO', { first: first.sampleEntry.fingerprint, other: a.sampleEntry.fingerprint });
    assert(a.timescale === first.timescale,
      `M4A media timescales differ (${first.timescale} vs ${a.timescale}).`, 'INCOMPATIBLE_AUDIO');
  }

  progress?.(0.45, 'Building M4A sample tables…');
  const totalSamples = analyses.reduce((s, a) => s + a.sampleCount, 0);
  const sampleSizes = new Uint32Array(totalSamples);
  const runs = [];
  const chunkSampleCounts = [];
  let mediaDuration = 0n;
  let mediaBytes = 0;
  let samplePos = 0;
  for (const a of analyses) {
    sampleSizes.set(a.sampleSizes, samplePos);
    samplePos += a.sampleCount;
    runs.push(...a.sttsRuns);
    chunkSampleCounts.push(a.sampleCount);
    mediaDuration += a.durationUnits;
    mediaBytes += a.mediaBytes;
  }
  assert(mediaBytes <= Number.MAX_SAFE_INTEGER, 'Output media data is too large.', 'TOO_LARGE');
  const sttsRuns = compressSttsRuns(runs);
  const mdatHeader = buildMdatHeader(mediaBytes);
  const ftyp = first.ftypRaw;
  const dataStart = ftyp.byteLength + mdatHeader.byteLength;
  const chunkOffsets = [];
  let outputMediaOffset = dataStart;
  for (const a of analyses) {
    chunkOffsets.push(outputMediaOffset);
    outputMediaOffset += a.mediaBytes;
  }
  const creationMs = Math.min(...analyses.map(a => a.createdMs).filter(Number.isFinite));
  const moov = buildMoov({
    creationMs,
    mediaTimescale: first.timescale,
    mediaDuration,
    language: first.language,
    stsdRaw: first.stsdRaw,
    sttsRuns,
    sampleSizes,
    chunkSampleCounts,
    chunkOffsets,
  });

  progress?.(0.62, 'Linking original AAC packets…');
  const parts = [ftyp, mdatHeader];
  let sourcePartCount = 0;
  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    for (const r of coalesceSourceChunks(a.chunks)) {
      parts.push(files[i].slice(r.offset, r.offset + r.length));
      sourcePartCount++;
    }
  }
  parts.push(moov);
  const blob = new Blob(parts, { type: 'audio/mp4' });

  return {
    blob,
    extension: 'm4a',
    mime: 'audio/mp4',
    details: {
      strategy: 'ISO-BMFF sample-table rebuild; AAC packet copy (no decode/re-encode)',
      codec: first.sampleEntry.fingerprint,
      sampleRate: first.sampleEntry.sampleRate,
      channels: first.sampleEntry.channels,
      sampleCount: totalSamples,
      mediaBytes,
      metadataBytes: ftyp.byteLength + mdatHeader.byteLength + moov.byteLength,
      sourcePartCount,
      durationSeconds: Number(mediaDuration) / first.timescale,
    },
  };
}

// ---------- WAV / RIFF ----------

function parseWavFmt(bytes) {
  assert(bytes.byteLength >= 16, 'WAV fmt chunk is too short.', 'INVALID_WAV');
  const tag = bytes[0] | (bytes[1] << 8);
  const channels = bytes[2] | (bytes[3] << 8);
  const sampleRate = readU32LE(bytes, 4);
  const byteRate = readU32LE(bytes, 8);
  const blockAlign = bytes[12] | (bytes[13] << 8);
  const bitsPerSample = bytes[14] | (bytes[15] << 8);
  let subformat = '';
  if (tag === 0xfffe && bytes.byteLength >= 40) subformat = hex(bytes.slice(24, 40));
  assert(tag === 1 || tag === 3 || tag === 0xfffe,
    `WAV format tag ${tag} is compressed/unsupported; zero-reencode joining only supports PCM/float WAV.`, 'UNSUPPORTED_CODEC');
  return { tag, channels, sampleRate, byteRate, blockAlign, bitsPerSample, subformat, fingerprint: `${tag}|${channels}|${sampleRate}|${blockAlign}|${bitsPerSample}|${subformat}` };
}

function parseInfoDate(listBytes) {
  if (listBytes.byteLength < 4 || ascii(listBytes, 0, 4) !== 'INFO') return null;
  let o = 4;
  while (o + 8 <= listBytes.byteLength) {
    const id = ascii(listBytes, o, 4);
    const size = readU32LE(listBytes, o + 4);
    const start = o + 8;
    if (start + size > listBytes.byteLength) break;
    if (id === 'ICRD') {
      const text = new TextDecoder().decode(listBytes.slice(start, start + size)).replace(/\0/g, '').trim();
      const ms = Date.parse(text);
      if (Number.isFinite(ms)) return ms;
    }
    o = start + size + (size & 1);
  }
  return null;
}

async function parseWav(file) {
  const h = await readBytes(file, 0, 12);
  assert(h.byteLength === 12 && ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WAVE', 'Not a standard RIFF/WAVE file.', 'INVALID_WAV');
  let offset = 12;
  let fmtRaw = null;
  let dataChunk = null;
  let embeddedCreatedMs = null;
  const chunks = [];
  let guard = 0;
  while (offset + 8 <= file.size && guard++ < 100000) {
    const ch = await readBytes(file, offset, 8);
    if (ch.byteLength < 8) break;
    const id = ascii(ch, 0, 4);
    const size = readU32LE(ch, 4);
    const payload = offset + 8;
    assert(payload + size <= file.size, `WAV chunk ${id} exceeds file size.`, 'INVALID_WAV');
    chunks.push({ id, size });
    if (id === 'fmt ') fmtRaw = await readBytes(file, payload, size);
    else if (id === 'data' && !dataChunk) dataChunk = { offset: payload, length: size };
    else if (id === 'LIST' && size <= 1024 * 1024) {
      const list = await readBytes(file, payload, size);
      embeddedCreatedMs ||= parseInfoDate(list);
    }
    offset = payload + size + (size & 1);
  }
  assert(fmtRaw && dataChunk, 'WAV fmt/data chunks are missing.', 'INVALID_WAV');
  const fmt = parseWavFmt(fmtRaw);
  assert(dataChunk.length % fmt.blockAlign === 0, 'WAV data length is not aligned to complete audio frames.', 'INVALID_WAV');
  const frames = dataChunk.length / fmt.blockAlign;
  const durationSeconds = frames / fmt.sampleRate;
  return {
    kind: 'wav', family: 'wav', label: 'WAV/PCM', extension: 'wav', mime: 'audio/wav', file,
    fmtRaw: new Uint8Array(fmtRaw), fmt, dataChunk, frames, durationSeconds, mediaBytes: dataChunk.length,
    createdMs: embeddedCreatedMs ?? file.lastModified ?? Date.now(), embeddedCreatedMs,
    dateSource: embeddedCreatedMs ? 'WAV INFO/ICRD' : 'File.lastModified fallback',
    chunks, warnings: [],
  };
}

async function mergeWav(files, analyses, progress) {
  const first = analyses[0];
  for (let i = 1; i < analyses.length; i++) {
    assert(analyses[i].fmt.fingerprint === first.fmt.fingerprint,
      `WAV settings differ between “${files[0].name}” and “${files[i].name}”.`, 'INCOMPATIBLE_AUDIO');
  }
  const dataBytes = analyses.reduce((s, a) => s + a.dataChunk.length, 0);
  const fmtPad = first.fmtRaw.byteLength & 1;
  const dataPad = dataBytes & 1;
  const riffSize = 4 + 8 + first.fmtRaw.byteLength + fmtPad + 8 + dataBytes + dataPad;
  assert(riffSize <= 0xffffffff, 'Merged WAV exceeds the 4 GiB RIFF limit. RF64 output is not implemented.', 'TOO_LARGE');
  const header = new Uint8Array(12 + 8 + first.fmtRaw.byteLength + fmtPad + 8);
  header.set(new TextEncoder().encode('RIFF'), 0);
  writeU32LEInto(header, 4, riffSize);
  header.set(new TextEncoder().encode('WAVE'), 8);
  let o = 12;
  header.set(new TextEncoder().encode('fmt '), o); writeU32LEInto(header, o + 4, first.fmtRaw.byteLength); o += 8;
  header.set(first.fmtRaw, o); o += first.fmtRaw.byteLength + fmtPad;
  header.set(new TextEncoder().encode('data'), o); writeU32LEInto(header, o + 4, dataBytes);
  progress?.(0.65, 'Linking PCM data…');
  const parts = [header, ...analyses.map((a, i) => files[i].slice(a.dataChunk.offset, a.dataChunk.offset + a.dataChunk.length))];
  if (dataPad) parts.push(u8(0));
  const blob = new Blob(parts, { type: 'audio/wav' });
  return {
    blob, extension: 'wav', mime: 'audio/wav',
    details: { strategy: 'RIFF header rebuild + PCM byte copy (no decode/re-encode)', sampleRate: first.fmt.sampleRate, channels: first.fmt.channels, bitsPerSample: first.fmt.bitsPerSample, durationSeconds: analyses.reduce((s, a) => s + a.durationSeconds, 0), mediaBytes: dataBytes },
  };
}

// ---------- MP3 ----------

const MP3_BITRATES = {
  '1-1': [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448,0],
  '1-2': [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384,0],
  '1-3': [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0],
  '2-1': [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256,0],
  '2-2': [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0],
  '2-3': [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0],
};

function parseMp3FrameHeader(data, o = 0) {
  if (o + 4 > data.byteLength) return null;
  const b1 = data[o], b2 = data[o + 1], b3 = data[o + 2], b4 = data[o + 3];
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;
  const verBits = (b2 >> 3) & 3;
  const layerBits = (b2 >> 1) & 3;
  if (verBits === 1 || layerBits === 0) return null;
  const version = verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5;
  const layer = 4 - layerBits;
  const bitrateIndex = (b3 >> 4) & 15;
  const srIndex = (b3 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || srIndex === 3) return null;
  const versionGroup = version === 1 ? 1 : 2;
  const bitrates = MP3_BITRATES[`${versionGroup}-${layer}`];
  if (!bitrates) return null;
  const bitrateKbps = bitrates[bitrateIndex];
  let sampleRate = [44100,48000,32000][srIndex];
  if (version === 2) sampleRate /= 2;
  if (version === 2.5) sampleRate /= 4;
  const padding = (b3 >> 1) & 1;
  let frameLength;
  let samplesPerFrame;
  if (layer === 1) { frameLength = Math.floor((12 * bitrateKbps * 1000 / sampleRate) + padding) * 4; samplesPerFrame = 384; }
  else if (layer === 2) { frameLength = Math.floor(144 * bitrateKbps * 1000 / sampleRate) + padding; samplesPerFrame = 1152; }
  else { frameLength = Math.floor((version === 1 ? 144 : 72) * bitrateKbps * 1000 / sampleRate) + padding; samplesPerFrame = version === 1 ? 1152 : 576; }
  const channelMode = (b4 >> 6) & 3;
  const channels = channelMode === 3 ? 1 : 2;
  const crc = (b2 & 1) === 0;
  return { version, layer, bitrateKbps, sampleRate, padding, frameLength, samplesPerFrame, channels, channelMode, crc, fingerprint: `${version}|${layer}|${sampleRate}|${channels}` };
}

function synchsafe32(data, o) {
  return ((data[o] & 0x7f) << 21) | ((data[o + 1] & 0x7f) << 14) | ((data[o + 2] & 0x7f) << 7) | (data[o + 3] & 0x7f);
}

async function mp3LeadingId3(file) {
  const h = await readBytes(file, 0, 10);
  if (h.byteLength < 10 || ascii(h, 0, 3) !== 'ID3') return { size: 0, dateMs: null };
  const body = synchsafe32(h, 6);
  const footer = (h[5] & 0x10) ? 10 : 0;
  const total = 10 + body + footer;
  let dateMs = null;
  if (total <= 2 * 1024 * 1024) {
    const tag = await readBytes(file, 0, total);
    const version = tag[3];
    let o = 10;
    while (o + 10 <= 10 + body) {
      const id = ascii(tag, o, 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = version === 4 ? synchsafe32(tag, o + 4) : readU32BE(tag, o + 4);
      const start = o + 10;
      if (!size || start + size > tag.byteLength) break;
      if ((id === 'TDRC' || id === 'TYER') && size >= 2) {
        const enc = tag[start];
        let text = '';
        try {
          if (enc === 0 || enc === 3) text = new TextDecoder(enc === 3 ? 'utf-8' : 'latin1').decode(tag.slice(start + 1, start + size));
          else text = new TextDecoder('utf-16').decode(tag.slice(start + 1, start + size));
        } catch {}
        const m = /(19|20)\d{2}(?:[-:]\d{2}(?:[-:]\d{2})?)?/.exec(text.replace(/\0/g, ''));
        if (m) { const parsed = Date.parse(m[0]); if (Number.isFinite(parsed)) dateMs = parsed; }
      }
      o = start + size;
    }
  }
  return { size: total, dateMs };
}

async function mp3TrailingTags(file, floor) {
  let end = file.size;
  if (end - floor >= 128) {
    const last128 = await readBytes(file, end - 128, 128);
    if (ascii(last128, 0, 3) === 'TAG') end -= 128;
  }
  if (end - floor >= 32) {
    const footer = await readBytes(file, end - 32, 32);
    if (ascii(footer, 0, 8) === 'APETAGEX') {
      const size = readU32LE(footer, 12);
      if (size > 0 && size <= end - floor) end -= size;
    }
  }
  return end;
}

function findFirstMp3Frame(buffer, baseOffset = 0) {
  for (let i = 0; i + 8 < buffer.byteLength; i++) {
    const h = parseMp3FrameHeader(buffer, i);
    if (!h || i + h.frameLength + 4 > buffer.byteLength) continue;
    const next = parseMp3FrameHeader(buffer, i + h.frameLength);
    if (next && next.version === h.version && next.layer === h.layer && next.sampleRate === h.sampleRate) return { offset: baseOffset + i, localOffset: i, header: h };
  }
  return null;
}

function mp3HasVbrHeader(frameBytes, h) {
  const crcBytes = h.crc ? 2 : 0;
  const side = h.layer === 3 ? (h.version === 1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17)) : 0;
  const xing = 4 + crcBytes + side;
  const x = ascii(frameBytes, xing, 4);
  if (x === 'Xing' || x === 'Info') return x;
  if (ascii(frameBytes, 36, 4) === 'VBRI') return 'VBRI';
  return null;
}

async function parseMp3(file) {
  const id3 = await mp3LeadingId3(file);
  const probeLen = Math.min(512 * 1024, file.size - id3.size);
  const probe = await readBytes(file, id3.size, probeLen);
  const first = findFirstMp3Frame(probe, id3.size);
  assert(first, 'Could not locate a valid MP3 frame stream.', 'INVALID_MP3');
  assert(first.header.layer === 3, `MPEG Layer ${first.header.layer} is not supported by the MP3 joiner.`, 'UNSUPPORTED_CODEC');
  let audioStart = first.offset;
  const firstFrameLocal = first.localOffset;
  const frame = probe.slice(firstFrameLocal, firstFrameLocal + first.header.frameLength);
  const vbrHeader = mp3HasVbrHeader(frame, first.header);
  if (vbrHeader) audioStart += first.header.frameLength; // remove stale Xing/Info/VBRI header frame
  const audioEnd = await mp3TrailingTags(file, audioStart);
  assert(audioEnd > audioStart, 'MP3 contains no audio payload after metadata.', 'INVALID_MP3');
  return {
    kind: 'mp3', family: 'mp3', label: 'MP3', extension: 'mp3', mime: 'audio/mpeg', file,
    frame: first.header, audioStart, audioEnd, mediaBytes: audioEnd - audioStart, vbrHeaderRemoved: vbrHeader,
    createdMs: id3.dateMs ?? file.lastModified ?? Date.now(), embeddedCreatedMs: id3.dateMs,
    dateSource: id3.dateMs ? 'ID3 recording/year tag' : 'File.lastModified fallback',
    warnings: vbrHeader ? [`Removed stale ${vbrHeader} header frame; output duration will be discovered by scanning MPEG frames.`] : [],
  };
}

async function mergeMp3(files, analyses, progress) {
  const first = analyses[0];
  for (let i = 1; i < analyses.length; i++) {
    assert(analyses[i].frame.fingerprint === first.frame.fingerprint,
      `MP3 stream settings differ between “${files[0].name}” and “${files[i].name}” (MPEG version/layer/sample rate/channel count).`, 'INCOMPATIBLE_AUDIO');
  }
  progress?.(0.65, 'Linking MP3 frame streams…');
  const parts = analyses.map((a, i) => files[i].slice(a.audioStart, a.audioEnd));
  const blob = new Blob(parts, { type: 'audio/mpeg' });
  return {
    blob, extension: 'mp3', mime: 'audio/mpeg',
    details: { strategy: 'MPEG audio frame-stream concatenation after stripping file-level tags/VBR headers (no decode/re-encode)', sampleRate: first.frame.sampleRate, channels: first.frame.channels, mediaBytes: analyses.reduce((s, a) => s + a.mediaBytes, 0), removedVbrHeaders: analyses.filter(a => a.vbrHeaderRemoved).length },
  };
}

// ---------- Raw ADTS AAC ----------

function parseAdtsHeader(data, o = 0) {
  if (o + 7 > data.byteLength || data[o] !== 0xff || (data[o + 1] & 0xf6) !== 0xf0) return null;
  const protectionAbsent = data[o + 1] & 1;
  const profile = ((data[o + 2] >> 6) & 3) + 1;
  const freqIndex = (data[o + 2] >> 2) & 15;
  const rates = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  if (freqIndex >= rates.length) return null;
  const channels = ((data[o + 2] & 1) << 2) | ((data[o + 3] >> 6) & 3);
  const frameLength = ((data[o + 3] & 3) << 11) | (data[o + 4] << 3) | ((data[o + 5] >> 5) & 7);
  const blocks = data[o + 6] & 3;
  if (frameLength < (protectionAbsent ? 7 : 9)) return null;
  return { profile, sampleRate: rates[freqIndex], freqIndex, channels, frameLength, blocks, fingerprint: `${profile}|${freqIndex}|${channels}` };
}

async function parseAdts(file) {
  const id3 = await mp3LeadingId3(file); // ID3v2 is also legal before ADTS AAC.
  const probe = await readBytes(file, id3.size, Math.min(64 * 1024, file.size - id3.size));
  let found = null;
  for (let i = 0; i + 14 < probe.byteLength; i++) {
    const h = parseAdtsHeader(probe, i);
    if (!h || i + h.frameLength + 7 > probe.byteLength) continue;
    const n = parseAdtsHeader(probe, i + h.frameLength);
    if (n && n.fingerprint === h.fingerprint) { found = { offset: id3.size + i, header: h }; break; }
  }
  assert(found, 'Could not locate a valid ADTS AAC stream.', 'INVALID_AAC');
  const end = await mp3TrailingTags(file, found.offset);
  return {
    kind: 'aac', family: 'aac', label: 'AAC/ADTS', extension: 'aac', mime: 'audio/aac', file,
    adts: found.header, audioStart: found.offset, audioEnd: end, mediaBytes: end - found.offset,
    createdMs: id3.dateMs ?? file.lastModified ?? Date.now(), embeddedCreatedMs: id3.dateMs,
    dateSource: id3.dateMs ? 'ID3 recording/year tag' : 'File.lastModified fallback', warnings: [],
  };
}

async function mergeAdts(files, analyses, progress) {
  const first = analyses[0];
  for (let i = 1; i < analyses.length; i++) {
    assert(analyses[i].adts.fingerprint === first.adts.fingerprint,
      `AAC/ADTS settings differ between “${files[0].name}” and “${files[i].name}”.`, 'INCOMPATIBLE_AUDIO');
  }
  progress?.(0.65, 'Linking AAC frames…');
  const blob = new Blob(analyses.map((a, i) => files[i].slice(a.audioStart, a.audioEnd)), { type: 'audio/aac' });
  return { blob, extension: 'aac', mime: 'audio/aac', details: { strategy: 'ADTS AAC frame-stream concatenation (no decode/re-encode)', sampleRate: first.adts.sampleRate, channels: first.adts.channels, mediaBytes: analyses.reduce((s, a) => s + a.mediaBytes, 0) } };
}

// ---------- Public analysis/merge API ----------

export async function sniffKind(file) {
  const ext = extensionOf(file.name || '');
  if (['m4a', 'm4b', 'mp4'].includes(ext)) return 'm4a';
  if (['wav', 'wave'].includes(ext)) return 'wav';
  if (ext === 'mp3') return 'mp3';
  if (['aac', 'adts'].includes(ext)) return 'aac';
  const h = await readBytes(file, 0, 16);
  if (h.byteLength >= 12 && ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WAVE') return 'wav';
  if (h.byteLength >= 8 && ascii(h, 4, 4) === 'ftyp') return 'm4a';
  if (h.byteLength >= 3 && ascii(h, 0, 3) === 'ID3') {
    // MIME/extension can disambiguate; MP3 is the safer default for ID3-prefixed files.
    return /aac/i.test(file.type || '') ? 'aac' : 'mp3';
  }
  if (parseAdtsHeader(h, 0)) return 'aac';
  if (parseMp3FrameHeader(h, 0)) return 'mp3';
  throw new MergeError(`Unsupported audio format for “${file.name || 'file'}”.`, 'UNSUPPORTED_FORMAT');
}

export async function analyzeAudioFile(file) {
  const kind = await sniffKind(file);
  if (kind === 'm4a') return parseMp4Audio(file);
  if (kind === 'wav') return parseWav(file);
  if (kind === 'mp3') return parseMp3(file);
  if (kind === 'aac') return parseAdts(file);
  throw new MergeError(`Unsupported format: ${kind}`, 'UNSUPPORTED_FORMAT');
}

export function compatibilitySummary(analyses) {
  if (!analyses.length) return { ok: false, message: 'Select audio files.' };
  const family = analyses[0]?.family;
  if (!family || analyses.some(a => a.error)) return { ok: false, message: 'One or more files could not be analyzed.' };
  if (analyses.some(a => a.family !== family)) return { ok: false, message: 'Mixed container families cannot be joined without re-encoding. Select one compatible format family.' };
  try {
    if (family === 'm4a') {
      const f = analyses[0];
      if (analyses.some(a => a.sampleEntry.fingerprint !== f.sampleEntry.fingerprint || a.timescale !== f.timescale)) return { ok: false, message: 'M4A/AAC codec settings do not match.' };
    } else if (family === 'wav') {
      const f = analyses[0].fmt.fingerprint;
      if (analyses.some(a => a.fmt.fingerprint !== f)) return { ok: false, message: 'WAV PCM settings do not match.' };
    } else if (family === 'mp3') {
      const f = analyses[0].frame.fingerprint;
      if (analyses.some(a => a.frame.fingerprint !== f)) return { ok: false, message: 'MP3 stream settings do not match.' };
    } else if (family === 'aac') {
      const f = analyses[0].adts.fingerprint;
      if (analyses.some(a => a.adts.fingerprint !== f)) return { ok: false, message: 'AAC/ADTS settings do not match.' };
    }
  } catch (e) { return { ok: false, message: e.message }; }
  return { ok: true, family, extension: analyses[0].extension, mime: analyses[0].mime };
}

export async function mergeAudioFiles(files, analyses, { progress } = {}) {
  assert(files.length >= 1, 'No audio files selected.', 'NO_FILES');
  assert(files.length === analyses.length, 'Analysis/file list mismatch.', 'INTERNAL');
  const comp = compatibilitySummary(analyses);
  assert(comp.ok, comp.message || 'Files are not compatible.', 'INCOMPATIBLE_AUDIO');
  progress?.(0.35, 'Preparing zero-reencode merge…');
  let result;
  if (comp.family === 'm4a') result = await mergeM4a(files, analyses, progress);
  else if (comp.family === 'wav') result = await mergeWav(files, analyses, progress);
  else if (comp.family === 'mp3') result = await mergeMp3(files, analyses, progress);
  else if (comp.family === 'aac') result = await mergeAdts(files, analyses, progress);
  else throw new MergeError(`Unsupported merge family: ${comp.family}`, 'UNSUPPORTED_FORMAT');
  progress?.(0.82, 'Verifying output structure…');
  result.verification = await verifyMergedOutput(result, analyses);
  progress?.(1, 'Ready to download');
  return result;
}

async function verifyMergedOutput(result, inputs) {
  const expectedMedia = inputs.reduce((s, a) => s + (a.mediaBytes || 0), 0);
  if (result.extension === 'm4a') {
    const fake = result.blob;
    const parsed = await parseMp4Audio(fake);
    const expectedSamples = inputs.reduce((s, a) => s + a.sampleCount, 0);
    assert(parsed.sampleCount === expectedSamples, `Verification failed: expected ${expectedSamples} AAC samples, got ${parsed.sampleCount}.`, 'VERIFY_FAILED');
    assert(parsed.mediaBytes === expectedMedia, `Verification failed: AAC media bytes changed (${expectedMedia} → ${parsed.mediaBytes}).`, 'VERIFY_FAILED');
    return { ok: true, sampleCount: parsed.sampleCount, mediaBytes: parsed.mediaBytes, durationSeconds: parsed.durationSeconds, fingerprint: parsed.sampleEntry.fingerprint };
  }
  if (result.extension === 'wav') {
    const parsed = await parseWav(result.blob);
    assert(parsed.mediaBytes === expectedMedia, 'Verification failed: WAV data byte count changed.', 'VERIFY_FAILED');
    return { ok: true, mediaBytes: parsed.mediaBytes, durationSeconds: parsed.durationSeconds, fingerprint: parsed.fmt.fingerprint };
  }
  if (result.extension === 'mp3') {
    const parsed = await parseMp3(result.blob);
    assert(parsed.mediaBytes > 0, 'Verification failed: no MP3 frames found.', 'VERIFY_FAILED');
    return { ok: true, mediaBytes: parsed.mediaBytes, fingerprint: parsed.frame.fingerprint };
  }
  if (result.extension === 'aac') {
    const parsed = await parseAdts(result.blob);
    assert(parsed.mediaBytes > 0, 'Verification failed: no AAC frames found.', 'VERIFY_FAILED');
    return { ok: true, mediaBytes: parsed.mediaBytes, fingerprint: parsed.adts.fingerprint };
  }
  return { ok: true };
}

export function expectedExtension(analyses) {
  const c = compatibilitySummary(analyses);
  return c.ok ? c.extension : (analyses[0]?.extension || 'audio');
}

export function safeFilename(name, extension) {
  let base = (name || 'merged-audio').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^\.+|\.+$/g, '');
  if (!base) base = 'merged-audio';
  const ext = (extension || '').replace(/^\./, '').toLowerCase();
  const current = extensionOf(base);
  if (ext && current !== ext) {
    if (current && ['m4a','m4b','mp4','mp3','wav','wave','aac','adts'].includes(current)) base = base.slice(0, -(current.length + 1));
    base += `.${ext}`;
  }
  return base.slice(0, 180);
}
