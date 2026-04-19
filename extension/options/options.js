const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

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

let currentRecording = null;
let currentDatasetId = null;

async function loadApiUrl() {
  const res = await send({ type: 'getApiUrl' });
  if (res.ok) $('#api-url').value = res.apiUrl;
}

async function checkHealth() {
  const res = await send({ type: 'healthCheck' });
  const pill = $('#api-status');
  if (res.ok && res.health?.status === 'ok') {
    pill.textContent = 'API OK';
    pill.className = 'pill ok';
  } else {
    pill.textContent = 'API down';
    pill.className = 'pill bad';
  }
}

$('#btn-save-api').addEventListener('click', async () => {
  const raw = $('#api-url').value.trim();
  if (!raw) return toast('Enter an API URL');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return toast('Invalid URL — include http:// or https://');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return toast('API URL must use http:// or https://');
  }
  const base = raw.replace(/\/$/, '');
  try {
    const probe = await fetch(`${base}/api/health`);
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    const data = await probe.json();
    if (data?.status !== 'ok') throw new Error('unexpected health response');
  } catch (err) {
    $('#api-status').textContent = 'API down';
    $('#api-status').className = 'pill bad';
    return toast(`API URL unreachable: ${err.message || err}`);
  }
  await send({ type: 'setApiUrl', apiUrl: base });
  await checkHealth();
  toast('API URL saved');
});

async function refreshRecordings() {
  const res = await send({ type: 'listRecordings' });
  const ul = $('#recording-list');
  ul.innerHTML = '';
  if (!res.ok || !res.recordings?.length) {
    ul.innerHTML = '<li>no recordings yet</li>';
    return;
  }
  for (const r of res.recordings) {
    const li = document.createElement('li');
    li.textContent = `#${r.id} — ${r.name} (${r.steps?.length ?? 0} steps)`;
    li.dataset.id = r.id;
    li.addEventListener('click', () => selectRecording(r.id));
    if (currentRecording && currentRecording.id === r.id) li.classList.add('active');
    ul.appendChild(li);
  }
}

async function selectRecording(id) {
  const res = await send({ type: 'getRecording', id });
  if (!res.ok) return toast(`Load failed: ${res.error}`);
  currentRecording = res.recording;
  $('#edit-name').value = currentRecording.name || '';
  $('#edit-description').value = currentRecording.description || '';
  $('#edit-steps').value = JSON.stringify(currentRecording.steps ?? [], null, 2);
  $$('#recording-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === String(id)));
}

$('#btn-save-edit').addEventListener('click', async () => {
  if (!currentRecording) return toast('Select a recording first');
  let steps;
  try {
    steps = JSON.parse($('#edit-steps').value);
  } catch (err) {
    return toast(`Invalid JSON: ${err.message}`);
  }
  const patch = {
    name: $('#edit-name').value.trim(),
    description: $('#edit-description').value,
    steps,
  };
  const res = await send({ type: 'updateRecording', id: currentRecording.id, patch });
  if (!res.ok) return toast(`Save failed: ${res.error}`);
  currentRecording = res.recording;
  toast('Saved');
  await refreshRecordings();
});

$('#btn-refresh-recordings').addEventListener('click', refreshRecordings);

async function refreshDatasets() {
  const res = await send({ type: 'listDatasets' });
  const sel = $('#dataset-select');
  sel.innerHTML = '<option value="">— choose dataset —</option>';
  if (!res.ok) return;
  for (const d of res.datasets) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name} (#${d.id})`;
    sel.appendChild(opt);
  }
}

$('#btn-create-dataset').addEventListener('click', async () => {
  const name = $('#new-dataset-name').value.trim();
  if (!name) return;
  const res = await send({ type: 'createDataset', name });
  if (!res.ok) return toast(`Create failed: ${res.error}`);
  $('#new-dataset-name').value = '';
  await refreshDatasets();
  toast(`Created dataset #${res.dataset.id}`);
});

$('#dataset-select').addEventListener('change', async (ev) => {
  currentDatasetId = ev.target.value;
  await refreshRows();
});

async function refreshRows() {
  const ul = $('#row-list');
  ul.innerHTML = '';
  if (!currentDatasetId) return;
  const res = await send({ type: 'listRows', datasetId: currentDatasetId });
  if (!res.ok) return;
  for (const row of res.rows) {
    const li = document.createElement('li');
    li.textContent = `#${row.id} — ${JSON.stringify(row.data)}`;
    ul.appendChild(li);
  }
}

$('#btn-add-row').addEventListener('click', async () => {
  if (!currentDatasetId) return toast('Choose a dataset first');
  let data;
  try {
    data = JSON.parse($('#new-row-json').value);
  } catch (err) {
    return toast(`Invalid JSON: ${err.message}`);
  }
  const res = await send({ type: 'addRow', datasetId: currentDatasetId, data });
  if (!res.ok) return toast(`Add failed: ${res.error}`);
  $('#new-row-json').value = '';
  await refreshRows();
});

(async function init() {
  await loadApiUrl();
  await checkHealth();
  await refreshRecordings();
  await refreshDatasets();
})();
