// background.js — service worker.
// Holds in-flight recording state and talks to the API server.

const DEFAULT_API = 'http://localhost:8787';
const STORAGE_KEY = 'webrecord';

async function getConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const s = stored[STORAGE_KEY] ?? {};
  return {
    apiUrl: s.apiUrl || DEFAULT_API,
    recordingBuffer: s.recordingBuffer || [],
    recordingMeta: s.recordingMeta || null,
  };
}

async function setConfig(patch) {
  const cur = await getConfig();
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...cur, ...patch } });
}

// Ring buffer of recent events surfaced to the popup Logs panel.
// Persisted in chrome.storage.local so it survives service-worker restarts
// (which otherwise happen after ~30s idle and would wipe an in-memory array).
const LOG_KEY = 'webrecord_logs';
const LOG_LIMIT = 200;
let logs = [];
let logsHydrated = false;
let logPersistChain = Promise.resolve();

(async function hydrateLogs() {
  try {
    const stored = await chrome.storage.local.get(LOG_KEY);
    if (Array.isArray(stored[LOG_KEY])) logs = stored[LOG_KEY];
  } catch {}
  logsHydrated = true;
})();

async function ensureLogsHydrated() {
  if (logsHydrated) return;
  try {
    const stored = await chrome.storage.local.get(LOG_KEY);
    if (Array.isArray(stored[LOG_KEY])) logs = stored[LOG_KEY];
  } catch {}
  logsHydrated = true;
}

function log(level, message, details) {
  const entry = { ts: Date.now(), level, message: String(message) };
  if (details !== undefined) entry.details = details;
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  const snapshot = logs.slice();
  logPersistChain = logPersistChain
    .then(() => chrome.storage.local.set({ [LOG_KEY]: snapshot }))
    .catch(() => {});
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[web-record] ${message}`, details ?? '');
}

// Serialize recording-buffer appends so concurrent events don't clobber each other.
let recordChain = Promise.resolve();
function appendRecordStep(step) {
  recordChain = recordChain.then(async () => {
    const cur = await getConfig();
    const buf = [...cur.recordingBuffer, step];
    await setConfig({ recordingBuffer: buf });
    return buf.length;
  });
  return recordChain;
}

function interpolateValue(value, row) {
  if (typeof value !== 'string' || !row) return value;
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(row, key) ? String(row[key] ?? '') : `{{${key}}}`
  );
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('navigation timeout'));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 200); // let content script attach
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function playRow(tabId, steps, row, delayMs) {
  let idx = 0;
  while (idx < steps.length) {
    let navIdx = -1;
    for (let i = idx; i < steps.length; i++) {
      if (steps[i]?.action === 'navigate') { navIdx = i; break; }
    }
    const end = navIdx === -1 ? steps.length : navIdx;
    const slice = steps.slice(idx, end);
    if (slice.length > 0) {
      const result = await forward(tabId, { type: 'playRecording', steps: slice, row, delayMs });
      if (result && result.ok === false) throw new Error(result.error || 'playback failed');
    }
    if (navIdx !== -1) {
      const url = interpolateValue(steps[navIdx].value, row);
      if (!url) throw new Error(`navigate step ${navIdx + 1} missing value`);
      await chrome.tabs.update(tabId, { url });
      await waitForTabLoad(tabId);
      idx = navIdx + 1;
    } else {
      idx = end;
    }
  }
}

async function api(path, init = {}) {
  const { apiUrl } = await getConfig();
  const fullUrl = apiUrl + path;
  let res;
  try {
    res = await fetch(fullUrl, {
      ...init,
      headers: {
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    const reason = err?.message || String(err);
    throw new Error(
      `Cannot reach API at ${fullUrl} (${reason}). Check the API URL in Options and make sure the server is running.`
    );
  }
  const text = await res.text();
  const data = text ? safeParse(text) : null;
  if (!res.ok) throw new Error(`${path} ${res.status}: ${data?.error ?? res.statusText}`);
  return data;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab.id;
}

async function injectContentScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['lib/selector.js', 'content.js'],
  });
}

async function forward(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    const msgText = err?.message || String(err);
    if (/Receiving end does not exist|Could not establish connection/i.test(msgText)) {
      // Tab was open before the extension loaded, or the content script was
      // otherwise not injected. Inject on demand and retry once.
      try {
        await injectContentScripts(tabId);
      } catch (injectErr) {
        throw new Error(
          `Could not inject content script into tab ${tabId}: ${injectErr?.message || injectErr}. ` +
          `Reload the page and try again.`
        );
      }
      return await chrome.tabs.sendMessage(tabId, message);
    }
    throw err;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'recordStep': {
          const count = await appendRecordStep(msg.step);
          log('info', `recorded step ${count}: ${msg.step?.action} ${msg.step?.selector ?? ''}`.trim());
          sendResponse({ ok: true, count });
          break;
        }
        case 'startRecording': {
          const tabId = msg.tabId ?? (await activeTabId());
          const tab = await chrome.tabs.get(tabId);
          if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
            throw new Error(
              `Cannot record on this tab (${tab?.url || 'unknown URL'}). Open a regular http(s) page and try again.`
            );
          }
          // Confirm the content script can be reached before discarding any
          // existing buffer, so an invalid target page can't erase unsaved work.
          await forward(tabId, { type: 'startRecording' });
          await setConfig({ recordingBuffer: [], recordingMeta: { startedAt: Date.now(), tabId } });
          log('info', `started recording on tab ${tabId} (${tab.url})`);
          sendResponse({ ok: true });
          break;
        }
        case 'getLogs': {
          await ensureLogsHydrated();
          sendResponse({ ok: true, logs: logs.slice() });
          break;
        }
        case 'clearLogs': {
          logs = [];
          logsHydrated = true;
          logPersistChain = logPersistChain
            .then(() => chrome.storage.local.remove(LOG_KEY))
            .catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case 'stopRecording': {
          const tabId = msg.tabId ?? (await activeTabId());
          await forward(tabId, { type: 'stopRecording' });
          const { recordingBuffer } = await getConfig();
          await setConfig({ recordingMeta: null });
          sendResponse({ ok: true, steps: recordingBuffer });
          break;
        }
        case 'getRecordingState': {
          const { recordingMeta, recordingBuffer } = await getConfig();
          const tabId = sender?.tab?.id ?? msg.tabId ?? (await activeTabId());
          const active = !!(recordingMeta && recordingMeta.tabId === tabId);
          sendResponse({ ok: true, active, tabId, stepCount: recordingBuffer.length });
          break;
        }
        case 'fetchFile': {
          const { apiUrl } = await getConfig();
          let url = msg.url;
          if (typeof url !== 'string' || !url) throw new Error('fetchFile: missing url');
          if (/^\//.test(url)) url = apiUrl.replace(/\/$/, '') + url;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`fetch ${url} ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          let binary = '';
          for (let i = 0; i < buf.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          }
          sendResponse({
            ok: true,
            base64: btoa(binary),
            contentType: res.headers.get('content-type') || 'application/octet-stream',
            url,
          });
          break;
        }
        case 'getBuffer': {
          const { recordingBuffer } = await getConfig();
          sendResponse({ ok: true, steps: recordingBuffer });
          break;
        }
        case 'clearBuffer': {
          await setConfig({ recordingBuffer: [], recordingMeta: null });
          sendResponse({ ok: true });
          break;
        }
        case 'saveRecording': {
          const { name, description, steps } = msg;
          const saved = await api('/api/recordings', {
            method: 'POST',
            body: JSON.stringify({ name, description, steps }),
          });
          sendResponse({ ok: true, recording: saved });
          break;
        }
        case 'listRecordings': {
          const data = await api('/api/recordings');
          sendResponse({ ok: true, recordings: data.recordings });
          break;
        }
        case 'getRecording': {
          const data = await api(`/api/recordings/${msg.id}`);
          sendResponse({ ok: true, recording: data });
          break;
        }
        case 'updateRecording': {
          const data = await api(`/api/recordings/${msg.id}`, {
            method: 'PUT',
            body: JSON.stringify(msg.patch),
          });
          sendResponse({ ok: true, recording: data });
          break;
        }
        case 'deleteRecording': {
          await api(`/api/recordings/${msg.id}`, { method: 'DELETE' });
          sendResponse({ ok: true });
          break;
        }
        case 'listDatasets': {
          const data = await api('/api/datasets');
          sendResponse({ ok: true, datasets: data.datasets });
          break;
        }
        case 'createDataset': {
          const data = await api('/api/datasets', {
            method: 'POST',
            body: JSON.stringify({ name: msg.name }),
          });
          sendResponse({ ok: true, dataset: data });
          break;
        }
        case 'listRows': {
          const data = await api(`/api/datasets/${msg.datasetId}/rows`);
          sendResponse({ ok: true, rows: data.rows });
          break;
        }
        case 'addRow': {
          const data = await api(`/api/datasets/${msg.datasetId}/rows`, {
            method: 'POST',
            body: JSON.stringify({ data: msg.data }),
          });
          sendResponse({ ok: true, row: data });
          break;
        }
        case 'runPlayback': {
          const tabId = msg.tabId ?? (await activeTabId());
          const tab = await chrome.tabs.get(tabId);
          if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
            throw new Error(
              `Cannot play on this tab (${tab?.url || 'unknown URL'}). Open a regular http(s) page and try again.`
            );
          }
          const { steps, rows = [null], delayMs = 400 } = msg;
          log('info', `playback start: ${steps.length} steps × ${rows.length} row(s) on ${tab.url}`);
          const results = [];
          for (const row of rows) {
            try {
              await playRow(tabId, steps, row?.data ?? row, delayMs);
              results.push({ ok: true, row });
            } catch (err) {
              const error = err?.message || String(err);
              log('error', `playback row failed: ${error}`, { row });
              results.push({ ok: false, row, error });
              if (msg.stopOnError) break;
            }
          }
          const failed = results.filter((r) => !r.ok).length;
          log(failed ? 'warn' : 'info', `playback done: ${results.length - failed}/${results.length} rows ok`);
          sendResponse({ ok: true, results });
          break;
        }
        case 'setApiUrl': {
          await setConfig({ apiUrl: msg.apiUrl });
          sendResponse({ ok: true });
          break;
        }
        case 'getApiUrl': {
          const { apiUrl } = await getConfig();
          sendResponse({ ok: true, apiUrl });
          break;
        }
        case 'healthCheck': {
          const data = await api('/api/health');
          sendResponse({ ok: true, health: data });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (err) {
      const error = err?.message || String(err);
      log('error', `${msg?.type || 'message'} failed: ${error}`);
      sendResponse({ ok: false, error });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await setConfig({});
});
