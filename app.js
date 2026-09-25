import {
  CORE_VERSION,
  MergeError,
  analyzeAudioFile,
  compatibilitySummary,
  expectedExtension,
  formatDuration,
  humanBytes,
  mergeAudioFiles,
  safeFilename,
} from './audio-core.mjs';

const APP_VERSION = `SoundStitch ${CORE_VERSION}`;
const $ = (sel) => document.querySelector(sel);
const els = {
  input: $('#file-input'),
  selectHero: $('#select-hero'),
  addMore: $('#add-more'),
  workspace: $('#workspace'),
  list: $('#file-list'),
  sort: $('#sort-mode'),
  merge: $('#merge-btn'),
  output: $('#output-name'),
  status: $('#status'),
  downloadAgain: $('#download-again'),
  count: $('#file-count'),
  progress: $('#progress'),
  progressFill: $('#progress-fill'),
  diag: $('#diag-btn'),
  clear: $('#clear-btn'),
  modal: $('#name-modal'),
  modalInput: $('#name-input'),
  modalOk: $('#name-ok'),
  modalCancel: $('#name-cancel'),
  toast: $('#toast'),
  installHint: $('#install-hint'),
};

const state = {
  items: [],
  nextId: 1,
  sortMode: 'dateAsc',
  busy: false,
  logs: [],
  selectedAt: null,
  lastResult: null,
  downloadUrl: null,
  downloadTimer: null,
};

function cleanForLog(value, depth = 0) {
  if (depth > 5) return '[max-depth]';
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code, stack: value.stack, details: cleanForLog(value.details, depth + 1) };
  if (value instanceof File || value instanceof Blob) return { name: value.name, size: value.size, type: value.type, lastModified: value.lastModified };
  if (Array.isArray(value)) return value.slice(0, 500).map(v => cleanForLog(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (['file', 'ftypRaw', 'stsdRaw', 'sampleSizes', 'chunks'].includes(k)) continue;
      out[k] = cleanForLog(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function log(level, event, details = undefined) {
  const record = { ts: new Date().toISOString(), level, event, details: cleanForLog(details) };
  state.logs.push(record);
  if (state.logs.length > 2500) state.logs.splice(0, state.logs.length - 2500);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[SoundStitch] ${event}`, details ?? '');
}

window.addEventListener('error', e => log('error', 'window.error', { message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno, error: e.error }));
window.addEventListener('unhandledrejection', e => log('error', 'unhandledrejection', e.reason));

function toast(text, ms = 1800) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function dateValue(item) {
  return item.analysis?.createdMs ?? item.file.lastModified ?? 0;
}

function sortItems(mode = state.sortMode) {
  state.sortMode = mode;
  if (mode === 'manual') return;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  state.items.sort((a, b) => {
    if (mode === 'nameAsc') return collator.compare(a.file.name, b.file.name) || a.id - b.id;
    const d = dateValue(a) - dateValue(b);
    return (mode === 'dateDesc' ? -d : d) || a.id - b.id;
  });
}

function compactAnalysis(a) {
  if (!a) return null;
  return {
    kind: a.kind,
    label: a.label,
    family: a.family,
    durationSeconds: a.durationSeconds,
    mediaBytes: a.mediaBytes,
    createdMs: a.createdMs,
    embeddedCreatedMs: a.embeddedCreatedMs,
    dateSource: a.dateSource,
    warnings: a.warnings,
    sampleCount: a.sampleCount,
    sampleEntry: a.sampleEntry ? {
      fingerprint: a.sampleEntry.fingerprint,
      sampleRate: a.sampleEntry.sampleRate,
      channels: a.sampleEntry.channels,
      sampleSize: a.sampleEntry.sampleSize,
      version: a.sampleEntry.version,
      asc: Array.from(a.sampleEntry.asc || []).map(x => x.toString(16).padStart(2, '0')).join(''),
    } : undefined,
    timescale: a.timescale,
    moovBytes: a.moovBytes,
    sourceChunkCount: a.chunks?.length,
    topLevel: a.topLevel,
    fmt: a.fmt,
    frame: a.frame,
    adts: a.adts,
    vbrHeaderRemoved: a.vbrHeaderRemoved,
  };
}

function render() {
  const has = state.items.length > 0;
  els.workspace.hidden = !has;
  els.selectHero.hidden = has;
  els.count.textContent = has ? `${state.items.length} file${state.items.length === 1 ? '' : 's'}` : '';
  els.sort.value = state.sortMode;

  const allAnalyzed = has && state.items.every(i => i.analysis || i.error);
  const analyses = state.items.map(i => i.analysis).filter(Boolean);
  const compat = allAnalyzed && analyses.length === state.items.length ? compatibilitySummary(analyses) : { ok: false, message: has ? 'Analyzing files…' : 'Select files.' };
  els.merge.disabled = state.busy || !compat.ok;
  els.addMore.disabled = state.busy;
  els.clear.disabled = state.busy;
  els.sort.disabled = state.busy;
  els.output.disabled = state.busy;

  if (state.busy) {
    // progress/status is driven by merge callbacks
  } else if (!allAnalyzed && has) {
    setStatus('Analyzing file structure locally…', 'neutral');
  } else if (state.items.some(i => i.error)) {
    setStatus('One or more files are unsupported. Remove them to merge.', 'error');
  } else if (has && !compat.ok) {
    setStatus(compat.message, 'error');
  } else if (has) {
    const family = analyses[0]?.label || compat.family;
    const total = state.items.reduce((s, i) => s + i.file.size, 0);
    setStatus(`${family} • ${humanBytes(total)} • zero-reencode path ready`, 'ok');
  }

  const frag = document.createDocumentFragment();
  for (let idx = 0; idx < state.items.length; idx++) {
    const item = state.items[idx];
    const row = document.createElement('div');
    row.className = `file-row${item.error ? ' file-error' : ''}`;
    row.dataset.id = item.id;
    row.innerHTML = `
      <button class="drag-handle" aria-label="Drag ${escapeHtml(item.file.name)}" title="Drag to reorder">≡</button>
      <span class="file-index">${idx + 1}</span>
      <div class="file-main">
        <div class="file-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</div>
        <div class="file-meta">${fileMeta(item)}</div>
      </div>
      <div class="move-buttons">
        <button class="mini-btn move-up" aria-label="Move up">↑</button>
        <button class="mini-btn move-down" aria-label="Move down">↓</button>
        <button class="mini-btn remove" aria-label="Remove">×</button>
      </div>`;
    frag.appendChild(row);
  }
  els.list.replaceChildren(frag);
  bindRowEvents();
}

function escapeHtml(s = '') {
  return s.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function fileMeta(item) {
  if (item.error) return `<span class="bad">${escapeHtml(item.error.message || 'Unsupported')}</span>`;
  if (!item.analysis) return `Analyzing… • ${humanBytes(item.file.size)}`;
  const a = item.analysis;
  const d = new Date(a.createdMs);
  const date = Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }).format(d) : 'unknown date';
  const dur = Number.isFinite(a.durationSeconds) ? ` • ${formatDuration(a.durationSeconds)}` : '';
  return `${escapeHtml(a.label)} • ${humanBytes(item.file.size)}${dur} • ${escapeHtml(date)}`;
}

function setStatus(text, kind = 'neutral') {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

function setProgress(fraction, label) {
  els.progress.hidden = false;
  els.progressFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  setStatus(label, 'neutral');
}

function hideProgress() {
  els.progress.hidden = true;
  els.progressFill.style.width = '0%';
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const firstBatch = state.items.length === 0;
  state.selectedAt = new Date().toISOString();
  log('info', 'files.selected', files.map(f => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })));
  for (const file of files) state.items.push({ id: state.nextId++, file, analysis: null, error: null });
  sortItems(state.sortMode);
  render();

  if (firstBatch) showNameModal(inferDefaultBase(files));
  analyzePending();
  els.input.value = '';
}

function inferDefaultBase(files) {
  if (!files.length) return 'merged-audio';
  const stem = files[0].name.replace(/\.[^.]+$/, '').trim();
  if (files.length === 1) return `${stem || 'audio'}-merged`;
  return 'merged-audio';
}

async function analyzePending() {
  const pending = state.items.filter(i => !i.analysis && !i.error);
  const concurrency = Math.min(2, pending.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      const t0 = performance.now();
      try {
        item.analysis = await analyzeAudioFile(item.file);
        log('info', 'file.analyzed', { id: item.id, name: item.file.name, ms: Math.round(performance.now() - t0), analysis: compactAnalysis(item.analysis) });
      } catch (error) {
        item.error = error instanceof Error ? error : new Error(String(error));
        log('error', 'file.analysis_failed', { id: item.id, name: item.file.name, error: item.error });
      }
      if (state.sortMode !== 'manual') sortItems();
      render();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (state.items.length && state.items.every(i => i.analysis || i.error)) {
    const analyses = state.items.map(i => i.analysis).filter(Boolean);
    const ext = analyses.length === state.items.length ? expectedExtension(analyses) : '';
    if (ext && els.output.value) els.output.value = safeFilename(els.output.value, ext);
  }
}

function showNameModal(defaultName) {
  els.modal.classList.add('open');
  els.modal.setAttribute('aria-hidden', 'false');
  els.modalInput.value = defaultName;
  requestAnimationFrame(() => { els.modalInput.focus(); els.modalInput.select(); });
}

function closeNameModal(commit = true) {
  if (commit) {
    const analyses = state.items.map(i => i.analysis).filter(Boolean);
    const ext = analyses.length === state.items.length ? expectedExtension(analyses) : '';
    els.output.value = safeFilename(els.modalInput.value || 'merged-audio', ext);
  }
  els.modal.classList.remove('open');
  els.modal.setAttribute('aria-hidden', 'true');
}

function setManual() {
  state.sortMode = 'manual';
  els.sort.value = 'manual';
}

function moveItem(id, direction) {
  const i = state.items.findIndex(x => x.id === id);
  if (i < 0 || state.items.length < 2) return;
  const item = state.items.splice(i, 1)[0];
  let target;
  if (direction < 0) target = i === 0 ? state.items.length : i - 1;
  else target = i >= state.items.length ? 0 : i + 1;
  state.items.splice(target, 0, item);
  setManual();
  log('info', 'list.move_button', { id, direction, target });
  render();
}

function removeItem(id) {
  const i = state.items.findIndex(x => x.id === id);
  if (i < 0) return;
  log('info', 'file.removed', { id, name: state.items[i].file.name });
  state.items.splice(i, 1);
  if (!state.items.length) {
    els.output.value = '';
    state.sortMode = 'dateAsc';
    hideProgress();
  }
  render();
}

function bindRowEvents() {
  for (const row of els.list.querySelectorAll('.file-row')) {
    const id = Number(row.dataset.id);
    row.querySelector('.move-up').onclick = () => moveItem(id, -1);
    row.querySelector('.move-down').onclick = () => moveItem(id, 1);
    row.querySelector('.remove').onclick = () => removeItem(id);
    installDrag(row.querySelector('.drag-handle'), row, id);
  }
}

function installDrag(handle, row, id) {
  let active = false;
  let pointerId = null;
  let lastY = 0;
  let raf = 0;
  const start = (e) => {
    if (state.busy) return;
    active = true;
    pointerId = e.pointerId;
    lastY = e.clientY;
    handle.setPointerCapture?.(pointerId);
    row.classList.add('dragging');
    document.body.classList.add('is-dragging');
    e.preventDefault();
    log('info', 'drag.start', { id });
  };
  const move = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    lastY = e.clientY;
    e.preventDefault();
    const rows = Array.from(els.list.querySelectorAll('.file-row:not(.dragging)'));
    let insertBefore = null;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (lastY < rect.top + rect.height / 2) { insertBefore = r; break; }
    }
    if (insertBefore) els.list.insertBefore(row, insertBefore);
    else els.list.appendChild(row);
    scheduleAutoScroll();
  };
  const end = (e) => {
    if (!active || (e.pointerId != null && e.pointerId !== pointerId)) return;
    active = false;
    cancelAnimationFrame(raf);
    row.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    try { handle.releasePointerCapture?.(pointerId); } catch {}
    const order = Array.from(els.list.querySelectorAll('.file-row')).map(r => Number(r.dataset.id));
    const map = new Map(state.items.map(x => [x.id, x]));
    state.items = order.map(x => map.get(x)).filter(Boolean);
    setManual();
    log('info', 'drag.end', { id, order });
    render();
  };
  function scheduleAutoScroll() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!active) return;
      const zone = 58;
      if (lastY < zone) window.scrollBy({ top: -10, behavior: 'auto' });
      else if (lastY > innerHeight - zone) window.scrollBy({ top: 10, behavior: 'auto' });
      if (lastY < zone || lastY > innerHeight - zone) scheduleAutoScroll();
    });
  }
  if ('PointerEvent' in window) {
    handle.addEventListener('pointerdown', start, { passive: false });
    handle.addEventListener('pointermove', move, { passive: false });
    handle.addEventListener('pointerup', end, { passive: false });
    handle.addEventListener('pointercancel', end, { passive: false });
  } else {
    // Older Safari fallback.
    let touchId = null;
    handle.addEventListener('touchstart', e => {
      const t = e.changedTouches[0]; touchId = t.identifier;
      start({ pointerId: touchId, clientY: t.clientY, preventDefault: () => e.preventDefault() });
    }, { passive: false });
    handle.addEventListener('touchmove', e => {
      const t = Array.from(e.changedTouches).find(x => x.identifier === touchId); if (!t) return;
      move({ pointerId: touchId, clientY: t.clientY, preventDefault: () => e.preventDefault() });
    }, { passive: false });
    handle.addEventListener('touchend', e => end({ pointerId: touchId, preventDefault: () => e.preventDefault() }), { passive: false });
  }
}

async function mergeNow() {
  if (state.busy || !state.items.length) return;
  const analyses = state.items.map(i => i.analysis);
  const comp = compatibilitySummary(analyses);
  if (!comp.ok) { toast(comp.message || 'Files are not compatible'); return; }
  state.busy = true;
  render();
  const files = state.items.map(i => i.file);
  const filename = safeFilename(els.output.value || 'merged-audio', comp.extension);
  els.output.value = filename;
  const t0 = performance.now();
  log('info', 'merge.start', { filename, order: state.items.map(i => i.file.name), family: comp.family });
  try {
    const result = await mergeAudioFiles(files, analyses, { progress: setProgress });
    state.lastResult = { filename, size: result.blob.size, details: result.details, verification: result.verification, elapsedMs: Math.round(performance.now() - t0) };
    log('info', 'merge.verified', state.lastResult);
    setProgress(1, `Verified • ${humanBytes(result.blob.size)} • opening download… (tap Download if needed)`);
    triggerDownload(result.blob, filename);
    toast('Merged & verified — download opened', 2600);
    setTimeout(() => { if (!state.busy) hideProgress(); }, 2500);
  } catch (error) {
    log('error', 'merge.failed', error);
    const msg = error instanceof MergeError ? error.message : `Merge failed: ${error.message || error}`;
    setStatus(msg, 'error');
    toast('Merge failed — tap diag if you want the full log', 3500);
  } finally {
    state.busy = false;
    render();
  }
}

function cleanupDownload() {
  if (state.downloadTimer) clearTimeout(state.downloadTimer);
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = null;
  state.downloadTimer = null;
  els.downloadAgain.hidden = true;
  els.downloadAgain.removeAttribute('href');
  els.downloadAgain.removeAttribute('download');
}

function triggerDownload(blob, filename) {
  cleanupDownload();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // application/octet-stream is a useful WebKit fallback when a displayable MIME type would open inline.
  const downloadBlob = isIOS ? new Blob([blob], { type: 'application/octet-stream' }) : blob;
  const url = URL.createObjectURL(downloadBlob);
  state.downloadUrl = url;

  // Keep a real, user-tappable anchor visible after the automatic attempt. On iOS, a long async merge
  // can outlive the original user activation; this explicit tap is the reliable fallback.
  els.downloadAgain.href = url;
  els.downloadAgain.download = filename;
  els.downloadAgain.hidden = false;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  log('info', 'download.trigger', { filename, blobType: blob.type, downloadType: downloadBlob.type, size: blob.size, isIOS, standalone: navigator.standalone === true || matchMedia('(display-mode: standalone)').matches });
  a.click();
  a.remove();

  state.downloadTimer = setTimeout(() => {
    if (state.downloadUrl === url) cleanupDownload();
  }, 15 * 60 * 1000);
}


async function diagnosticsText() {
  let storage = null;
  let cacheKeys = null;
  let sw = null;
  try { storage = await navigator.storage?.estimate?.(); } catch (e) { storage = { error: String(e) }; }
  try { cacheKeys = 'caches' in window ? await caches.keys() : null; } catch (e) { cacheKeys = { error: String(e) }; }
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    sw = reg ? { scope: reg.scope, active: reg.active?.state, waiting: reg.waiting?.state, installing: reg.installing?.state } : null;
  } catch (e) { sw = { error: String(e) }; }
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const snapshot = {
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    url: location.href,
    secureContext: isSecureContext,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: navigator.languages,
    vendor: navigator.vendor,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: navigator.standalone,
    displayModeStandalone: matchMedia('(display-mode: standalone)').matches,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, dpr: devicePixelRatio, innerWidth, innerHeight, visualViewport: window.visualViewport ? { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale } : null },
    connection: connection ? { effectiveType: connection.effectiveType, downlink: connection.downlink, rtt: connection.rtt, saveData: connection.saveData, type: connection.type } : null,
    features: {
      pointerEvent: 'PointerEvent' in window,
      blobStream: 'stream' in Blob.prototype,
      clipboard: !!navigator.clipboard,
      share: !!navigator.share,
      canShare: !!navigator.canShare,
      serviceWorker: 'serviceWorker' in navigator,
      cacheStorage: 'caches' in window,
      downloadAttribute: 'download' in document.createElement('a'),
      fileSystemAccess: 'showOpenFilePicker' in window,
    },
    storage,
    cacheKeys,
    serviceWorker: sw,
    sortMode: state.sortMode,
    selectedAt: state.selectedAt,
    outputName: els.output.value,
    lastResult: state.lastResult,
    files: state.items.map((item, index) => ({
      index,
      id: item.id,
      name: item.file.name,
      size: item.file.size,
      type: item.file.type,
      lastModified: item.file.lastModified,
      lastModifiedISO: new Date(item.file.lastModified).toISOString(),
      analysis: compactAnalysis(item.analysis),
      error: item.error ? cleanForLog(item.error) : null,
    })),
    logs: state.logs,
  };
  return `SOUNDSTITCH DIAGNOSTICS\n${JSON.stringify(snapshot, null, 2)}`;
}

async function copyDiagnostics() {
  log('info', 'diagnostics.copy_requested');
  const text = await diagnosticsText();
  try {
    await navigator.clipboard.writeText(text);
    toast(`Diagnostics copied (${Math.round(text.length / 1024)} KB)`);
    log('info', 'diagnostics.copy_ok', { chars: text.length, method: 'clipboard' });
  } catch (error) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    if (!ok) throw error;
    toast(`Diagnostics copied (${Math.round(text.length / 1024)} KB)`);
    log('info', 'diagnostics.copy_ok', { chars: text.length, method: 'execCommand' });
  }
}

function clearAll() {
  if (state.busy) return;
  log('info', 'files.cleared', { count: state.items.length });
  state.items = [];
  state.sortMode = 'dateAsc';
  state.lastResult = null;
  cleanupDownload();
  els.output.value = '';
  hideProgress();
  render();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) { log('warn', 'sw.unsupported'); return; }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    log('info', 'sw.registered', { scope: reg.scope, active: reg.active?.state });
    navigator.serviceWorker.addEventListener('message', e => log('info', 'sw.message', e.data));
  } catch (error) { log('error', 'sw.register_failed', error); }
}

els.selectHero.addEventListener('click', () => els.input.click());
els.addMore.addEventListener('click', () => els.input.click());
els.input.addEventListener('change', e => addFiles(e.target.files));
els.sort.addEventListener('change', () => { sortItems(els.sort.value); log('info', 'sort.changed', { mode: state.sortMode }); render(); });
els.merge.addEventListener('click', mergeNow);
els.diag.addEventListener('click', () => copyDiagnostics().catch(e => { log('error', 'diagnostics.copy_failed', e); toast('Could not copy diagnostics'); }));
els.clear.addEventListener('click', clearAll);
els.modalOk.addEventListener('click', () => closeNameModal(true));
els.modalCancel.addEventListener('click', () => closeNameModal(false));
els.modalInput.addEventListener('keydown', e => { if (e.key === 'Enter') closeNameModal(true); if (e.key === 'Escape') closeNameModal(false); });
els.modal.addEventListener('click', e => { if (e.target === els.modal) closeNameModal(true); });

log('info', 'app.start', { version: APP_VERSION, href: location.href, userAgent: navigator.userAgent, standalone: navigator.standalone, screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}` });
if (navigator.standalone === true || matchMedia('(display-mode: standalone)').matches) els.installHint.hidden = true;
render();
registerServiceWorker();
