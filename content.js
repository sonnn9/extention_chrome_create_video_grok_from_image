(() => {
  if (window.__grokBatchInjected) return;
  window.__grokBatchInjected = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function waitFor(fn, timeoutMs = 30000, intervalMs = 250) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function tick() {
        let v;
        try { v = fn(); } catch {}
        if (v) return resolve(v);
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout ${timeoutMs}ms`));
        setTimeout(tick, intervalMs);
      })();
    });
  }

  function findFileInput() {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    return inputs.find(i => !i.disabled) || inputs[0] || null;
  }

  function findUploadButton() {
    const btns = document.querySelectorAll('button');
    for (const b of btns) {
      if (b.querySelector('svg.lucide-upload')) return b;
      if (/upload\s*or\s*drop/i.test(b.textContent || '')) return b;
    }
    return null;
  }

  function findPromptEditor() {
    return document.querySelector('div.ProseMirror[contenteditable="true"]')
        || document.querySelector('[contenteditable="true"].ProseMirror')
        || document.querySelector('[contenteditable="true"]');
  }

  function findGenerateButton() {
    const paths = document.querySelectorAll('svg path[d^="M6 11L12 5"]');
    for (const p of paths) {
      const btn = p.closest('button') || p.closest('[role="button"]');
      if (btn) return btn;
      let el = p.parentElement;
      while (el && el !== document.body) {
        const cls = (el.className && el.className.baseVal) || el.className || '';
        if (typeof cls === 'string' && /rounded-full|cursor-pointer|bg-button-filled/.test(cls)) {
          return el;
        }
        el = el.parentElement;
      }
    }
    return null;
  }

  function getVideoSrc(v) {
    if (!v) return '';
    return v.getAttribute('src') || v.currentSrc || '';
  }

  function getCurrentVideoElement() {
    return document.querySelector('video#sd-video') || document.querySelector('video');
  }

  function snapshotVideoSrcs() {
    const set = new Set();
    document.querySelectorAll('video').forEach(v => {
      const s = getVideoSrc(v);
      if (s) set.add(s.split('?')[0]); // ignore cache-buster
    });
    return set;
  }

  function findNewVideoSrc(beforeSet) {
    const vids = document.querySelectorAll('video');
    for (const v of vids) {
      const src = getVideoSrc(v);
      if (!src || !/\.mp4(\?|$)/i.test(src)) continue;
      const base = src.split('?')[0];
      if (!beforeSet.has(base)) return src;
    }
    return null;
  }

  function bufToBase64(arr) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < arr.length; i += chunk) {
      bin += String.fromCharCode.apply(null, arr.subarray(i, Math.min(i + chunk, arr.length)));
    }
    return btoa(bin);
  }

  function dispatchClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  async function uploadImage(file) {
    let input = findFileInput();
    if (!input) {
      const btn = findUploadButton();
      if (btn) {
        dispatchClick(btn);
        await sleep(400);
      }
      input = findFileInput();
    }
    if (input) {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // Fallback: simulate drop on the upload button / dropzone
    const dropTarget = findUploadButton() || document.body;
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true });
      try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch {}
      dropTarget.dispatchEvent(ev);
    }
  }

  async function waitForImageAttached(timeoutMs = 60000) {
    return waitFor(() => {
      if (document.querySelector('[data-mention-type="attachment"]')) return true;
      const imgs = document.querySelectorAll('img[src*="assets.grok.com"]');
      if (imgs.length > 0) return true;
      const editor = findPromptEditor();
      if (editor && /@Image/i.test(editor.textContent || '')) return true;
      return null;
    }, timeoutMs, 400);
  }

  async function fillPrompt(text) {
    const editor = findPromptEditor();
    if (!editor) throw new Error('Không tìm thấy ô prompt (ProseMirror)');
    editor.focus();
    await sleep(50);

    // Place caret at start so user prompt comes BEFORE the auto-inserted @Image mention
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch {}
    if (!ok) {
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: text, bubbles: true, cancelable: true,
      }));
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: text, bubbles: true,
      }));
    }
  }

  async function clickGenerate() {
    const btn = await waitFor(() => findGenerateButton(), 10000, 250);
    dispatchClick(btn);
  }

  async function waitForNewVideo(beforeSet, timeoutMs) {
    // First wait for a NEW <video> src that wasn't there before
    const newSrc = await waitFor(() => findNewVideoSrc(beforeSet), timeoutMs, 1500);
    // Then settle: wait until src stops changing for 1.5s (final cache-busted URL)
    let lastSrc = newSrc;
    let stableSince = Date.now();
    const stableDeadline = Date.now() + 15000;
    while (Date.now() < stableDeadline) {
      await sleep(500);
      const cur = findNewVideoSrc(beforeSet) || lastSrc;
      if (cur !== lastSrc) {
        lastSrc = cur;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1500) {
        break;
      }
    }
    return lastSrc;
  }

  async function fetchVideoAsBase64(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} khi tải video`);
    const blob = await res.blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { videoData: bufToBase64(buf), videoMime: blob.type || 'video/mp4', size: buf.length };
  }

  async function processImage({ fileName, fileType, fileData, prompt, timeoutMs }) {
    const bin = atob(fileData);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], fileName, { type: fileType || 'image/png' });

    await waitFor(() => findFileInput() || findUploadButton(), 20000, 300);
    await uploadImage(file);

    try { await waitForImageAttached(60000); }
    catch { /* continue anyway */ }
    await sleep(500);

    await fillPrompt(prompt);
    await sleep(400);

    // Snapshot existing video URLs BEFORE clicking generate, to ignore stale videos
    const beforeSet = snapshotVideoSrcs();

    await clickGenerate();

    const videoUrl = await waitForNewVideo(beforeSet, timeoutMs);
    const { videoData, videoMime, size } = await fetchVideoAsBase64(videoUrl);
    return { videoUrl, videoData, videoMime, size };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'PROCESS_IMAGE') {
      processImage(msg).then(
        (data) => sendResponse({ ok: true, ...data }),
        (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }),
      );
      return true; // async
    }
  });
})();
