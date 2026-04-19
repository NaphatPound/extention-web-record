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

  const CLICKABLE_SELECTOR =
    'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], ' +
    'input[type="button"], input[type="submit"], input[type="reset"], label, summary, [onclick]';

  function findClickable(el) {
    let cur = el instanceof Element ? el : null;
    while (cur) {
      if (cur.matches?.(CLICKABLE_SELECTOR)) return cur;
      cur = cur.parentElement;
    }
    return el instanceof Element ? el : null;
  }

  // Default wait between recorded actions (ms). Users can edit or delete any
  // of these steps later in the Options / Editor.
  const DEFAULT_WAIT_MS = 5000;

  function emitStep(step) {
    state.stepCounter += 1;
    sendToBackground({ type: 'recordStep', step: { step: state.stepCounter, ...step } });
    state.stepCounter += 1;
    sendToBackground({
      type: 'recordStep',
      step: {
        step: state.stepCounter,
        action: 'wait',
        value: DEFAULT_WAIT_MS,
        url: location.href,
        timestamp: now(),
      },
    });
  }

  // ---- Recorder ----
  function onClickCapture(ev) {
    if (state.mode !== 'recording') return;
    // Flush any pending contenteditable text first so the click (e.g. submit)
    // doesn't get recorded before the typing step that belongs ahead of it.
    if (ceTarget) flushContentEditable();
    const describe = getSelector()?.describe;
    if (!describe) return;
    // Clicks on icons (svg/img/span inside a button) should target the button,
    // not the inner node — otherwise the captured selector is long and brittle.
    const target = findClickable(ev.target) || ev.target;
    const info = describe(target, ev.clientX, ev.clientY);
    if (!info || !info.selector) return;
    emitStep({
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

    const isFile = el.tagName === 'INPUT' && el.type === 'file';
    const isSelect = el.tagName === 'SELECT';
    const action = isFile ? 'upload_file' : isSelect ? 'select_option' : 'type_text';
    // File inputs only expose a "C:\fakepath\..." value, so record the file
    // name as a hint and leave the upload URL for the user to fill in.
    const value = isFile ? '' : 'value' in el ? String(el.value ?? '') : '';

    emitStep({
      action,
      selector: info.selector,
      xpath: info.xpath,
      value,
      ...(isFile && el.files?.[0]?.name ? { fileName: el.files[0].name } : {}),
      element: {
        tagName: info.tagName,
        id: info.id,
        className: info.className,
        innerText: info.innerText,
      },
      url: location.href,
      timestamp: now(),
    });
  }

  function findContentEditableRoot(el) {
    let cur = el instanceof Element ? el : null;
    while (cur) {
      const attr = cur.getAttribute?.('contenteditable');
      if (attr === 'true' || attr === '') return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  let ceFlushTimer = null;
  let ceTarget = null;

  function flushContentEditable() {
    const el = ceTarget;
    ceTarget = null;
    if (ceFlushTimer) { clearTimeout(ceFlushTimer); ceFlushTimer = null; }
    if (!el || !el.isConnected) return;
    const describe = getSelector()?.describe;
    if (!describe) return;
    const info = describe(el);
    if (!info || !info.selector) return;
    const value = (el.innerText ?? el.textContent ?? '').trim();
    if (!value) return;
    emitStep({
      action: 'type_text',
      selector: info.selector,
      xpath: info.xpath,
      value,
      contentEditable: true,
      element: {
        tagName: info.tagName,
        id: info.id,
        className: info.className,
        innerText: info.innerText,
      },
      url: location.href,
      timestamp: now(),
    });
  }

  function onContentEditableInput(ev) {
    if (state.mode !== 'recording') return;
    const root = findContentEditableRoot(ev.target);
    if (!root) return;
    // If focus moved to a different editable, flush the previous one first.
    if (ceTarget && ceTarget !== root) flushContentEditable();
    ceTarget = root;
    if (ceFlushTimer) clearTimeout(ceFlushTimer);
    // Debounce so a burst of keystrokes turns into one step with the final text.
    ceFlushTimer = setTimeout(flushContentEditable, 600);
  }

  function attachRecorder() {
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('change', onInputCapture, true);
    document.addEventListener('input', onContentEditableInput, true);
  }

  function detachRecorder() {
    flushContentEditable();
    document.removeEventListener('click', onClickCapture, true);
    document.removeEventListener('change', onInputCapture, true);
    document.removeEventListener('input', onContentEditableInput, true);
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

  function trimTrailingCombinator(selector) {
    // Drop the right-most " > part" so "a > b > svg" becomes "a > b".
    const idx = selector.lastIndexOf('>');
    return idx === -1 ? '' : selector.slice(0, idx).trim();
  }

  async function resolveElement(step) {
    const resolve = getSelector()?.resolve;
    if (!resolve) return null;
    let el = resolve(step.selector, step.xpath);
    const deadline = now() + 5000;
    while (!el && now() < deadline) {
      await sleep(100);
      el = resolve(step.selector, step.xpath);
    }
    // Fallback: old recordings may have captured an inner icon (svg/span)
    // inside a button. Walk the selector up one segment at a time and try
    // again — the nearest clickable ancestor is usually what the user meant.
    if (!el && step.selector) {
      let trimmed = trimTrailingCombinator(step.selector);
      while (!el && trimmed) {
        el = resolve(trimmed, null);
        trimmed = trimTrailingCombinator(trimmed);
      }
    }
    return el;
  }

  async function doClick(step) {
    const el = await resolveElement(step);
    if (!el) throw new Error(`element not found for click: ${step.selector}`);
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    }
    // HTMLElement has a native .click(); SVGElement / MathMLElement don't.
    // Fall back to a synthesized MouseEvent so those surfaces still work.
    if (typeof el.click === 'function') {
      el.click();
    } else {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    }
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function typeIntoContentEditable(el, value) {
    el.focus();
    // Select all existing content so insertText replaces instead of appending.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    // execCommand is deprecated but still fires beforeinput/input events that
    // frameworks like ProseMirror/TipTap/Lexical rely on to update their model.
    let inserted = false;
    try {
      if (typeof document.execCommand === 'function') {
        document.execCommand('delete');
        inserted = document.execCommand('insertText', false, value);
      }
    } catch {}
    if (!inserted) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
  }

  async function doType(step, row) {
    const el = await resolveElement(step);
    if (!el) throw new Error(`element not found for type: ${step.selector}`);
    const value = interpolate(step.value, row);
    if (step.contentEditable || el.isContentEditable) {
      typeIntoContentEditable(el, value);
      return;
    }
    el.focus();
    setNativeValue(el, value);
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
    const rawUrl = interpolate(step.value, row);
    const fetched = await sendToBackground({ type: 'fetchFile', url: rawUrl });
    if (!fetched?.ok) throw new Error(`failed to fetch file ${rawUrl}: ${fetched?.error || 'unknown'}`);
    const binary = atob(fetched.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const name = step.fileName || (fetched.url || rawUrl).split('/').pop() || 'upload.bin';
    const file = new File([bytes], name, { type: fetched.contentType });
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

  // Re-arm recorder if this tab was recording before navigation/reload.
  sendToBackground({ type: 'getRecordingState' }).then((res) => {
    if (res?.ok && res.active && state.mode !== 'recording') {
      state = { mode: 'recording', stepCounter: res.stepCount || 0 };
      attachRecorder();
    }
  });
})();
