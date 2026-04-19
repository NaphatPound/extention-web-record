// content.js — injected into pages. Recording + playback executor.
(function () {
  'use strict';

  const STATE_KEY = 'webrecord_state';
  let state = { mode: 'idle', stepCounter: 0 };

  function getSelector() {
    return self.WebRecordSelector;
  }

  function now() {
    return Date.now();
  }

  async function sendToBackground(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      console.warn('[web-record] sendMessage failed:', err);
      return null;
    }
  }

  // ---- Recorder ----
  function onClickCapture(ev) {
    if (state.mode !== 'recording') return;
    const describe = getSelector()?.describe;
    if (!describe) return;
    const info = describe(ev.target, ev.clientX, ev.clientY);
    if (!info || !info.selector) return;
    state.stepCounter += 1;
    sendToBackground({
      type: 'recordStep',
      step: {
        step: state.stepCounter,
        action: 'click',
        selector: info.selector,
        xpath: info.xpath,
        element: {
          tagName: info.tagName,
          id: info.id,
          className: info.className,
          innerText: info.innerText,
        },
        position: info.position,
        url: location.href,
        timestamp: now(),
      },
    });
  }

  function onInputCapture(ev) {
    if (state.mode !== 'recording') return;
    const el = ev.target;
    if (!(el instanceof Element)) return;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    const describe = getSelector()?.describe;
    if (!describe) return;
    const info = describe(el);
    if (!info || !info.selector) return;
    const value = 'value' in el ? String(el.value ?? '') : '';
    state.stepCounter += 1;
    sendToBackground({
      type: 'recordStep',
      step: {
        step: state.stepCounter,
        action: el.tagName === 'SELECT' ? 'select_option' : 'type_text',
        selector: info.selector,
        xpath: info.xpath,
        value,
        element: {
          tagName: info.tagName,
          id: info.id,
          className: info.className,
          innerText: info.innerText,
        },
        url: location.href,
        timestamp: now(),
      },
    });
  }

  function attachRecorder() {
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('change', onInputCapture, true);
  }

  function detachRecorder() {
    document.removeEventListener('click', onClickCapture, true);
    document.removeEventListener('change', onInputCapture, true);
  }

  // ---- Playback ----
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function interpolate(value, row) {
    if (typeof value !== 'string' || !row) return value;
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key) => {
      if (Object.prototype.hasOwnProperty.call(row, key)) return String(row[key] ?? '');
      return `{{${key}}}`;
    });
  }

  async function resolveElement(step) {
    const resolve = getSelector()?.resolve;
    let el = resolve ? resolve(step.selector, step.xpath) : null;
    const deadline = now() + 5000;
    while (!el && now() < deadline) {
      await sleep(100);
      el = resolve ? resolve(step.selector, step.xpath) : null;
    }
    return el;
  }

  async function doClick(step) {
    const el = await resolveElement(step);
    if (!el) throw new Error(`element not found for click: ${step.selector}`);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  async function doType(step, row) {
    const el = await resolveElement(step);
    if (!el) throw new Error(`element not found for type: ${step.selector}`);
    el.focus();
    setNativeValue(el, interpolate(step.value, row));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function doSelect(step, row) {
    const el = await resolveElement(step);
    if (!el) throw new Error(`element not found for select: ${step.selector}`);
    setNativeValue(el, interpolate(step.value, row));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function doUpload(step, row) {
    const el = await resolveElement(step);
    if (!el || el.tagName !== 'INPUT' || el.type !== 'file') {
      throw new Error(`expected file input for upload: ${step.selector}`);
    }
    const url = interpolate(step.value, row);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch file ${url}: ${res.status}`);
    const blob = await res.blob();
    const name = step.fileName || url.split('/').pop() || 'upload.bin';
    const file = new File([blob], name, { type: blob.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function doWait(step) {
    await sleep(Number(step.value ?? step.ms ?? 500));
  }

  async function doNavigate(step, row) {
    const url = interpolate(step.value, row);
    location.href = url;
  }

  async function runStep(step, row) {
    switch (step.action) {
      case 'click': return doClick(step);
      case 'type_text': return doType(step, row);
      case 'select_option': return doSelect(step, row);
      case 'upload_file': return doUpload(step, row);
      case 'wait': return doWait(step);
      case 'navigate': return doNavigate(step, row);
      default: throw new Error(`unknown action: ${step.action}`);
    }
  }

  async function runRecording(steps, row, delayMs = 400) {
    for (const step of steps) {
      await runStep(step, row);
      await sleep(delayMs);
    }
  }

  // ---- Message handler ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === 'startRecording') {
          state = { mode: 'recording', stepCounter: 0 };
          attachRecorder();
          sendResponse({ ok: true });
        } else if (msg?.type === 'stopRecording') {
          detachRecorder();
          state.mode = 'idle';
          sendResponse({ ok: true });
        } else if (msg?.type === 'getState') {
          sendResponse({ ok: true, state });
        } else if (msg?.type === 'playRecording') {
          const { steps, row, delayMs } = msg;
          await runRecording(steps || [], row, delayMs ?? 400);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // async response
  });
})();
