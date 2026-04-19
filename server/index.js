import http from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, ValidationError } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer ? body : body == null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuffer ? headers['Content-Type'] ?? 'application/octet-stream' : 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...CORS_HEADERS,
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ValidationError('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new ValidationError('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function readRawBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ValidationError('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function match(pathname, pattern) {
  const pParts = pattern.split('/').filter(Boolean);
  const uParts = pathname.split('/').filter(Boolean);
  if (pParts.length !== uParts.length) return null;
  const params = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = decodeURIComponent(uParts[i]);
    else if (pParts[i] !== uParts[i]) return null;
  }
  return params;
}

export function createApp(store) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
      send(res, 204, null);
      return;
    }

    try {
      // Health check — the completion promise
      if (method === 'GET' && pathname === '/api/health') {
        return send(res, 200, { status: 'ok', message: 'API IS WORKING' });
      }

      // Recordings CRUD
      if (method === 'GET' && pathname === '/api/recordings') {
        return send(res, 200, { recordings: store.listRecordings() });
      }
      if (method === 'POST' && pathname === '/api/recordings') {
        const body = await readJsonBody(req);
        const row = await store.createRecording(body);
        return send(res, 201, row);
      }
      {
        const p = match(pathname, '/api/recordings/:id');
        if (p) {
          if (method === 'GET') {
            const row = store.getRecording(p.id);
            if (!row) return send(res, 404, { error: 'not found' });
            return send(res, 200, row);
          }
          if (method === 'PUT') {
            const body = await readJsonBody(req);
            const row = await store.updateRecording(p.id, body);
            if (!row) return send(res, 404, { error: 'not found' });
            return send(res, 200, row);
          }
          if (method === 'DELETE') {
            const ok = await store.deleteRecording(p.id);
            if (!ok) return send(res, 404, { error: 'not found' });
            return send(res, 200, { deleted: true });
          }
        }
      }

      // Datasets
      if (method === 'GET' && pathname === '/api/datasets') {
        return send(res, 200, { datasets: store.listDatasets() });
      }
      if (method === 'POST' && pathname === '/api/datasets') {
        const body = await readJsonBody(req);
        const row = await store.createDataset(body);
        return send(res, 201, row);
      }
      {
        const p = match(pathname, '/api/datasets/:id');
        if (p && method === 'DELETE') {
          const ok = await store.deleteDataset(p.id);
          if (!ok) return send(res, 404, { error: 'not found' });
          return send(res, 200, { deleted: true });
        }
      }
      {
        const p = match(pathname, '/api/datasets/:id/rows');
        if (p) {
          if (method === 'GET') {
            if (!store.getDataset(p.id)) return send(res, 404, { error: 'dataset not found' });
            return send(res, 200, { rows: store.listRows(p.id) });
          }
          if (method === 'POST') {
            const body = await readJsonBody(req);
            const row = await store.addRow(p.id, body.data ?? body);
            return send(res, 201, row);
          }
        }
      }
      {
        const p = match(pathname, '/api/rows/:id');
        if (p && method === 'DELETE') {
          const ok = await store.deleteRow(p.id);
          if (!ok) return send(res, 404, { error: 'not found' });
          return send(res, 200, { deleted: true });
        }
      }

      // Files
      if (method === 'POST' && pathname === '/api/files') {
        const name = url.searchParams.get('name') ?? 'upload.bin';
        const mime = req.headers['content-type'] ?? 'application/octet-stream';
        const data = await readRawBody(req);
        const row = await store.addFile({ name, mime_type: mime, data });
        return send(res, 201, row);
      }
      {
        const p = match(pathname, '/api/files/:id');
        if (p && method === 'GET') {
          const result = await store.readFile(p.id);
          if (!result) return send(res, 404, { error: 'not found' });
          return send(res, 200, result.data, {
            'Content-Type': result.meta.mime_type,
            'Content-Disposition': `inline; filename="${result.meta.name}"`,
          });
        }
      }

      return send(res, 404, { error: 'not found', pathname });
    } catch (err) {
      if (err instanceof ValidationError) {
        return send(res, err.status ?? 400, { error: err.message });
      }
      console.error('[server] unexpected error:', err);
      return send(res, 500, { error: 'internal server error' });
    }
  };
}

export async function startServer({ port = Number(process.env.PORT ?? 8787), dataDir } = {}) {
  const store = new JsonStore(dataDir);
  await store.init();
  const server = http.createServer(createApp(store));
  await new Promise((resolve) => server.listen(port, resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server,
    store,
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server/index.js') ||
  process.argv[1]?.endsWith('server\\index.js');

if (isMain) {
  startServer().then(({ url }) => {
    console.log(`[web-record] API listening at ${url}`);
    console.log(`[web-record] Health check: ${url}/api/health`);
  }).catch((err) => {
    console.error('[web-record] failed to start:', err);
    process.exit(1);
  });
}
