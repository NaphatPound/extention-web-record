import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server/index.js';

let ctx;
let base;
let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webrecord-test-'));
  ctx = await startServer({ port: 0, dataDir: tmpDir });
  base = ctx.url;
});

after(async () => {
  if (ctx) await ctx.close();
  if (tmpDir) {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

async function jsonFetch(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

test('GET /api/health returns API IS WORKING', async () => {
  const res = await jsonFetch('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'ok');
  assert.equal(res.data.message, 'API IS WORKING');
});

test('CORS preflight responds with 204 and allow headers', async () => {
  const res = await fetch(base + '/api/recordings', { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('recordings CRUD', async () => {
  // list empty
  let res = await jsonFetch('GET', '/api/recordings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.recordings, []);

  // create
  res = await jsonFetch('POST', '/api/recordings', {
    name: 'Login flow',
    description: 'Login to example.com',
    steps: [
      { step: 1, action: 'click', selector: '#login' },
      { step: 2, action: 'type_text', selector: '#user', value: 'alice' },
    ],
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.name, 'Login flow');
  assert.equal(res.data.steps.length, 2);
  assert.ok(res.data.id);
  const id = res.data.id;

  // get
  res = await jsonFetch('GET', `/api/recordings/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.id, id);

  // list
  res = await jsonFetch('GET', '/api/recordings');
  assert.equal(res.data.recordings.length, 1);

  // update
  res = await jsonFetch('PUT', `/api/recordings/${id}`, {
    description: 'Updated',
    steps: [{ step: 1, action: 'click', selector: '#btn' }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.description, 'Updated');
  assert.equal(res.data.steps.length, 1);

  // delete
  res = await jsonFetch('DELETE', `/api/recordings/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.deleted, true);

  // confirm 404
  res = await jsonFetch('GET', `/api/recordings/${id}`);
  assert.equal(res.status, 404);
});

test('recordings validation', async () => {
  let res = await jsonFetch('POST', '/api/recordings', {});
  assert.equal(res.status, 400);

  res = await jsonFetch('POST', '/api/recordings', { name: 'bad', steps: 'nope' });
  assert.equal(res.status, 400);
});

test('datasets and rows', async () => {
  // create dataset
  let res = await jsonFetch('POST', '/api/datasets', { name: 'prompts' });
  assert.equal(res.status, 201);
  const datasetId = res.data.id;

  // rows empty
  res = await jsonFetch('GET', `/api/datasets/${datasetId}/rows`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.rows, []);

  // add row
  res = await jsonFetch('POST', `/api/datasets/${datasetId}/rows`, {
    data: { prompt_text: 'A cat in space', base_image_url: '/api/files/1' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.data.prompt_text, 'A cat in space');

  // list rows
  res = await jsonFetch('GET', `/api/datasets/${datasetId}/rows`);
  assert.equal(res.data.rows.length, 1);

  // list datasets
  res = await jsonFetch('GET', '/api/datasets');
  assert.ok(res.data.datasets.some((d) => d.id === datasetId));

  // 404 on unknown dataset rows
  res = await jsonFetch('GET', '/api/datasets/9999/rows');
  assert.equal(res.status, 404);
});

test('files upload and download roundtrip', async () => {
  const payload = Buffer.from('hello web-record', 'utf8');
  let res = await fetch(base + '/api/files?name=hello.txt', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: payload,
  });
  assert.equal(res.status, 201);
  const meta = await res.json();
  assert.equal(meta.name, 'hello.txt');
  assert.equal(meta.size, payload.length);

  res = await fetch(base + `/api/files/${meta.id}`);
  assert.equal(res.status, 200);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.toString('utf8'), 'hello web-record');
});

test('unknown path returns 404', async () => {
  const res = await jsonFetch('GET', '/api/nope');
  assert.equal(res.status, 404);
});
