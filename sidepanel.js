const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'grokBatchSettings';
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'];

let dirHandle = null;
let stopRequested = false;
let running = false;
let stats = { done: 0, skipped: 0, failed: 0, total: 0 };

function log(msg, level = 'info') {
  const el = document.createElement('div');
  el.className = `log-line log-${level}`;
  const time = new Date().toLocaleTimeString();
  el.textContent = `[${time}] ${msg}`;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}

function setProgress(text, pct) {
  $('progress').textContent = text;
  if (pct !== undefined) $('progressBarFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function updateStats() {
  $('stats').textContent = `✓ ${stats.done}  ⏭ ${stats.skipped}  ✗ ${stats.failed} / ${stats.total}`;
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function loadSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const s = data[STORAGE_KEY] || {};
  if (s.prompt) $('prompt').value = s.prompt;
  if (s.timeout) $('timeout').value = s.timeout;
  if (s.retry !== undefined) $('retry').value = s.retry;
  if (s.delay !== undefined) $('delay').value = s.delay;
  if (s.skipExisting !== undefined) $('skipExisting').checked = s.skipExisting;
  if (s.resetUrl) $('resetUrl').value = s.resetUrl;
}

async function saveSettings() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      prompt: $('prompt').value,
      timeout: +$('timeout').value,
      retry: +$('retry').value,
      delay: +$('delay').value,
      skipExisting: $('skipExisting').checked,
      resetUrl: $('resetUrl').value.trim(),
    }
  });
}

async function pickFolder() {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const imgs = await listImages();
    $('folderInfo').textContent = `📂 ${dirHandle.name} — ${imgs.length} ảnh`;
    log(`Đã chọn folder: ${dirHandle.name} (${imgs.length} ảnh)`, 'success');
  } catch (e) {
    if (e.name !== 'AbortError') log(`Lỗi chọn folder: ${e.message}`, 'error');
  }
}

async function listImages() {
  if (!dirHandle) return [];
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    const lower = name.toLowerCase();
    if (IMG_EXTS.some(e => lower.endsWith(e))) out.push({ name, handle });
  }
  out.sort((a, b) => naturalSort(a.name, b.name));
  return out;
}

async function videoExists(imageName) {
  const base = imageName.replace(/\.[^.]+$/, '');
  try {
    await dirHandle.getFileHandle(`${base}.mp4`);
    return true;
  } catch { return false; }
}

function bufToBase64(buf) {
  const arr = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + chunk, arr.length)));
  }
  return btoa(bin);
}

async function getActiveGrokTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('Không tìm thấy tab nào active');
  if (!tab.url || !tab.url.includes('grok.com')) {
    throw new Error('Tab active phải là grok.com — hãy mở grok.com (trang tạo video) rồi bấm Start lại');
  }
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (r && r.ok) return;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await sleep(300);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function resetGrokTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitTabComplete(tabId);
  await sleep(1500);
  await ensureContentScript(tabId);
}

async function processOneImage(tabId, file, prompt, timeoutMs) {
  const buf = await file.arrayBuffer();
  const fileData = bufToBase64(buf);
  const result = await chrome.tabs.sendMessage(tabId, {
    type: 'PROCESS_IMAGE',
    fileName: file.name,
    fileType: file.type || 'image/png',
    fileData,
    prompt,
    timeoutMs,
  });
  if (!result) throw new Error('Không nhận được phản hồi từ content script');
  if (!result.ok) throw new Error(result.error || 'Lỗi không rõ');
  return result; // { ok, videoUrl, videoData, videoMime, size }
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime || 'video/mp4' });
}

async function saveVideoBase64(b64, mime, baseName) {
  const blob = base64ToBlob(b64, mime);
  const fileHandle = await dirHandle.getFileHandle(`${baseName}.mp4`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return blob.size;
}

function fmtSize(bytes) {
  if (!bytes) return '?';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

async function runBatch() {
  if (running) return;
  if (!dirHandle) { log('Chưa chọn folder ảnh', 'error'); return; }
  const promptTpl = $('prompt').value.trim();
  if (!promptTpl) { log('Chưa nhập prompt', 'error'); return; }

  await saveSettings();

  let tab;
  try { tab = await getActiveGrokTab(); }
  catch (e) { log(e.message, 'error'); return; }

  const resetUrl = $('resetUrl').value.trim() || tab.url;
  log(`Tab grok: ${tab.url}`, 'info');
  log(`URL reset giữa các lần: ${resetUrl}`, 'info');

  const images = await listImages();
  if (images.length === 0) { log('Folder không có ảnh', 'error'); return; }

  stats = { done: 0, skipped: 0, failed: 0, total: images.length };
  updateStats();

  const skipExisting = $('skipExisting').checked;
  const timeoutSec = +$('timeout').value;
  const maxRetry = +$('retry').value;
  const delaySec = +$('delay').value;

  running = true;
  stopRequested = false;
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('pickFolder').disabled = true;

  log(`▶ Bắt đầu xử lý ${images.length} ảnh`, 'success');

  await ensureContentScript(tab.id);

  for (let i = 0; i < images.length; i++) {
    if (stopRequested) { log('⏸ Đã dừng theo yêu cầu', 'warn'); break; }

    const { name, handle } = images[i];
    const baseName = name.replace(/\.[^.]+$/, '');
    setProgress(`[${i + 1}/${images.length}] ${name}`, (i / images.length) * 100);

    if (skipExisting && await videoExists(name)) {
      log(`⏭ Bỏ qua: ${name} (đã có ${baseName}.mp4)`, 'info');
      stats.skipped++;
      updateStats();
      continue;
    }

    const file = await handle.getFile();
    const userPrompt = promptTpl
      .replaceAll('{filename}', baseName)
      .replaceAll('{index}', String(i + 1));

    let success = false;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      if (stopRequested) break;
      try {
        if (attempt > 0) {
          log(`🔄 Retry ${attempt}/${maxRetry}: ${name}`, 'warn');
          await resetGrokTab(tab.id, resetUrl);
        }
        log(`▶ ${name}: upload + generate...`, 'info');
        const r = await processOneImage(tab.id, file, userPrompt, timeoutSec * 1000);
        log(`📥 Nhận video: ${r.videoUrl.split('?')[0].split('/').pop()} (${fmtSize(r.size)})`, 'info');
        const written = await saveVideoBase64(r.videoData, r.videoMime, baseName);
        log(`✅ Lưu xong: ${baseName}.mp4 (${fmtSize(written)})`, 'success');
        success = true;
        break;
      } catch (e) {
        log(`❌ ${name} (lần ${attempt + 1}): ${e.message}`, 'error');
      }
    }

    if (success) stats.done++;
    else stats.failed++;
    updateStats();

    if (i < images.length - 1 && !stopRequested) {
      await resetGrokTab(tab.id, resetUrl);
      if (delaySec > 0) await sleep(delaySec * 1000);
    }
  }

  setProgress(`Xong. ✓${stats.done} ⏭${stats.skipped} ✗${stats.failed} / ${stats.total}`, 100);
  log(`=== Kết thúc batch ===`, 'success');

  running = false;
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  $('pickFolder').disabled = false;
}

$('pickFolder').addEventListener('click', pickFolder);
$('startBtn').addEventListener('click', () => {
  runBatch().catch(e => {
    log(`Crash: ${e.message}`, 'error');
    running = false;
    $('startBtn').disabled = false;
    $('stopBtn').disabled = true;
    $('pickFolder').disabled = false;
  });
});
$('stopBtn').addEventListener('click', () => {
  stopRequested = true;
  log('⏸ Đang dừng sau ảnh hiện tại...', 'warn');
});
$('clearLogBtn').addEventListener('click', () => { $('log').innerHTML = ''; });

['prompt', 'timeout', 'retry', 'delay', 'skipExisting', 'resetUrl'].forEach(id => {
  $(id).addEventListener('change', saveSettings);
});

loadSettings();
updateStats();
