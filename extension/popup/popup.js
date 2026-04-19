const $ = (sel) => document.querySelector(sel);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => resolve(res ?? { ok: false, error: 'no response' }));
  });
}

function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

async function refreshHealth() {
  const pill = $('#api-status');
  const res = await send({ type: 'healthCheck' });
  if (res.ok && res.health?.status === 'ok') {
    pill.textContent = 'API OK';
    pill.className = 'pill ok';
  } else {
    pill.textContent = 'API down';
    pill.className = 'pill bad';
  }
}

async function refreshBuffer() {
  const res = await send({ type: 'getBuffer' });
  const count = res?.steps?.length ?? 0;
  $('#step-count').textContent = `${count} steps captured`;
}

async function refreshRecordingState() {
  const res = await send({ type: 'getRecordingState' });
  const active = !!(res?.ok && res.active);
  $('#btn-record').disabled = active;
  $('#btn-stop').disabled = !active;
}

async function refreshTabTargetState() {
  let url = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = tab?.url || '';
  } catch {}
  const playable = /^https?:\/\//i.test(url);
  const playBtn = $('#btn-play');
  const recBtn = $('#btn-record');
  playBtn.disabled = !playable;
  playBtn.title = playable ? '' : 'Switch to a regular http(s) tab to play a recording';
  if (!playable) {
    // Recording is also scoped to a content script; keep the hint consistent.
    recBtn.title = 'Switch to a regular http(s) tab to start recording';
  } else {
    recBtn.title = '';
  }
}

async function refreshRecordings() {
  const res = await send({ type: 'listRecordings' });
  const sel = $('#recording-list');
  sel.innerHTML = '';
  if (!res.ok || !res.recordings?.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— none —';
    sel.appendChild(opt);
    return;
  }
  for (const r of res.recordings) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name} (${r.steps?.length ?? 0} steps)`;
    sel.appendChild(opt);
  }
}

async function refreshDatasets() {
  const res = await send({ type: 'listDatasets' });
  const sel = $('#dataset-list');
  // preserve the "none" option
  sel.innerHTML = '<option value="">— no dataset (single run) —</option>';
  if (!res.ok || !res.datasets?.length) return;
  for (const d of res.datasets) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    sel.appendChild(opt);
  }
}

$('#btn-record').addEventListener('click', async () => {
  const res = await send({ type: 'startRecording' });
  if (!res.ok) return toast(`Failed: ${res.error}`);
  $('#btn-record').disabled = true;
  $('#btn-stop').disabled = false;
  toast('Recording started — interact with the page');
});

$('#btn-stop').addEventListener('click', async () => {
  const res = await send({ type: 'stopRecording' });
  if (!res.ok) return toast(`Failed: ${res.error}`);
  $('#btn-record').disabled = false;
  $('#btn-stop').disabled = true;
  await refreshBuffer();
  toast(`Captured ${res.steps?.length ?? 0} steps`);
});

$('#btn-clear').addEventListener('click', async () => {
  await send({ type: 'clearBuffer' });
  await refreshBuffer();
  toast('Buffer cleared');
});

$('#btn-save').addEventListener('click', async () => {
  const name = $('#save-name').value.trim();
  if (!name) return toast('Enter a name first');
  const buf = await send({ type: 'getBuffer' });
  if (!buf.ok || !buf.steps?.length) return toast('Nothing to save');
  const res = await send({ type: 'saveRecording', name, description: '', steps: buf.steps });
  if (!res.ok) return toast(`Save failed: ${res.error}`);
  $('#save-name').value = '';
  await send({ type: 'clearBuffer' });
  await refreshBuffer();
  await refreshRecordings();
  toast(`Saved as #${res.recording.id}`);
});

$('#btn-delete').addEventListener('click', async () => {
  const id = $('#recording-list').value;
  if (!id) return;
  const res = await send({ type: 'deleteRecording', id });
  if (!res.ok) return toast(`Delete failed: ${res.error}`);
  await refreshRecordings();
  toast('Deleted');
});

$('#btn-play').addEventListener('click', async () => {
  const id = $('#recording-list').value;
  if (!id) return toast('No recording selected');
  const rec = await send({ type: 'getRecording', id });
  if (!rec.ok) return toast(`Load failed: ${rec.error}`);

  let rows = [null];
  const datasetId = $('#dataset-list').value;
  if (datasetId) {
    const r = await send({ type: 'listRows', datasetId });
    if (r.ok && r.rows?.length) rows = r.rows;
  }

  toast(`Playing ${rec.recording.steps.length} steps × ${rows.length} row(s)`);
  const result = await send({ type: 'runPlayback', steps: rec.recording.steps, rows });
  if (!result.ok) return toast(`Playback error: ${result.error}`, 6000);
  const failed = (result.results || []).filter((r) => !r.ok);
  if (failed.length) {
    toast(`Done with ${failed.length} failure(s): ${failed[0].error || 'unknown error'}`, 6000);
  } else {
    toast('Playback complete');
  }
});

$('#link-options').addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

async function renderLogs() {
  const list = $('#log-list');
  const res = await send({ type: 'getLogs' });
  list.innerHTML = '';
  const entries = res?.logs ?? [];
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No log entries yet — interact with the extension to generate events.';
    list.appendChild(li);
    return;
  }
  for (const entry of entries.slice().reverse()) {
    const li = document.createElement('li');
    li.className = entry.level || 'info';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTime(entry.ts);
    li.appendChild(ts);
    li.appendChild(document.createTextNode(entry.message));
    list.appendChild(li);
  }
}

$('#btn-toggle-logs').addEventListener('click', async () => {
  const list = $('#log-list');
  const clear = $('#btn-clear-logs');
  const btn = $('#btn-toggle-logs');
  const showing = !list.hidden;
  if (showing) {
    list.hidden = true;
    clear.hidden = true;
    btn.textContent = 'Show logs';
  } else {
    await renderLogs();
    list.hidden = false;
    clear.hidden = false;
    btn.textContent = 'Hide logs';
  }
});

$('#btn-clear-logs').addEventListener('click', async () => {
  await send({ type: 'clearLogs' });
  await renderLogs();
  toast('Logs cleared');
});

(async function init() {
  await refreshHealth();
  await refreshRecordingState();
  await refreshTabTargetState();
  await refreshBuffer();
  await refreshRecordings();
  await refreshDatasets();
})();
