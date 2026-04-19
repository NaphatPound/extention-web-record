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

async function api(path, init = {}) {
  const { apiUrl } = await getConfig();
  const res = await fetch(apiUrl + path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
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

async function forward(tabId, message) {
  return await chrome.tabs.sendMessage(tabId, message);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'recordStep': {
          const cur = await getConfig();
          const buf = [...cur.recordingBuffer, msg.step];
          await setConfig({ recordingBuffer: buf });
          sendResponse({ ok: true, count: buf.length });
          break;
        }
        case 'startRecording': {
          const tabId = msg.tabId ?? (await activeTabId());
          await setConfig({ recordingBuffer: [], recordingMeta: { startedAt: Date.now(), tabId } });
          await forward(tabId, { type: 'startRecording' });
          sendResponse({ ok: true });
          break;
        }
        case 'stopRecording': {
          const tabId = msg.tabId ?? (await activeTabId());
          await forward(tabId, { type: 'stopRecording' });
          const { recordingBuffer } = await getConfig();
          sendResponse({ ok: true, steps: recordingBuffer });
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
          const { steps, rows = [null], delayMs = 400 } = msg;
          const results = [];
          for (const row of rows) {
            try {
              const result = await forward(tabId, { type: 'playRecording', steps, row: row?.data ?? row, delayMs });
              results.push({ ok: true, row, result });
            } catch (err) {
              results.push({ ok: false, row, error: err?.message || String(err) });
              if (msg.stopOnError) break;
            }
          }
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
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await setConfig({});
});
