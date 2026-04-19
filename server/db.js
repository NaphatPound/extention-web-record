import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VALID_ACTIONS = new Set([
  'click',
  'type_text',
  'select_option',
  'upload_file',
  'wait',
  'navigate',
]);
const ACTIONS_REQUIRING_SELECTOR = new Set(['click', 'type_text', 'select_option', 'upload_file']);
const ACTIONS_REQUIRING_VALUE = new Set(['type_text', 'select_option', 'navigate']);

function validateSteps(steps) {
  if (!Array.isArray(steps)) throw new ValidationError('steps must be an array');
  steps.forEach((step, i) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new ValidationError(`steps[${i}] must be an object`);
    }
    if (!VALID_ACTIONS.has(step.action)) {
      throw new ValidationError(`steps[${i}].action is invalid: ${step.action ?? '(missing)'}`);
    }
    if (ACTIONS_REQUIRING_SELECTOR.has(step.action)) {
      if (typeof step.selector !== 'string' || !step.selector.trim()) {
        throw new ValidationError(`steps[${i}].selector is required for ${step.action}`);
      }
    }
    if (ACTIONS_REQUIRING_VALUE.has(step.action) && step.value === undefined) {
      throw new ValidationError(`steps[${i}].value is required for ${step.action}`);
    }
  });
}

export class JsonStore {
  constructor(dataDir = path.join(__dirname, 'data')) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.filesDir = path.join(dataDir, 'files');
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.filesDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.state = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = {
        recordings: [],
        datasets: [],
        dataset_rows: [],
        files: [],
        counters: { recordings: 0, datasets: 0, dataset_rows: 0, files: 0 },
      };
      await this.#flush();
    }
    for (const key of ['recordings', 'datasets', 'dataset_rows', 'files']) {
      if (!Array.isArray(this.state[key])) this.state[key] = [];
      if (typeof this.state.counters?.[key] !== 'number') {
        this.state.counters ??= {};
        this.state.counters[key] = this.state[key].reduce((m, r) => Math.max(m, r.id ?? 0), 0);
      }
    }
  }

  async #flush() {
    this.writeQueue = this.writeQueue.then(() =>
      fs.writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8')
    );
    return this.writeQueue;
  }

  #nextId(table) {
    this.state.counters[table] = (this.state.counters[table] ?? 0) + 1;
    return this.state.counters[table];
  }

  #now() {
    return new Date().toISOString();
  }

  // ---- recordings ----
  listRecordings() {
    return this.state.recordings.slice();
  }

  getRecording(id) {
    return this.state.recordings.find((r) => r.id === Number(id)) ?? null;
  }

  async createRecording({ name, description = '', steps = [] }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('name is required');
    }
    validateSteps(steps);
    const row = {
      id: this.#nextId('recordings'),
      name,
      description,
      steps,
      created_at: this.#now(),
      updated_at: this.#now(),
    };
    this.state.recordings.push(row);
    await this.#flush();
    return row;
  }

  async updateRecording(id, patch) {
    const row = this.getRecording(id);
    if (!row) return null;
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name.trim()) {
        throw new ValidationError('name cannot be empty');
      }
      row.name = patch.name;
    }
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.steps !== undefined) {
      validateSteps(patch.steps);
      row.steps = patch.steps;
    }
    row.updated_at = this.#now();
    await this.#flush();
    return row;
  }

  async deleteRecording(id) {
    const idx = this.state.recordings.findIndex((r) => r.id === Number(id));
    if (idx === -1) return false;
    this.state.recordings.splice(idx, 1);
    await this.#flush();
    return true;
  }

  // ---- datasets ----
  listDatasets() {
    return this.state.datasets.slice();
  }

  getDataset(id) {
    return this.state.datasets.find((d) => d.id === Number(id)) ?? null;
  }

  async createDataset({ name }) {
    if (!name || typeof name !== 'string') throw new ValidationError('name is required');
    const row = { id: this.#nextId('datasets'), name, created_at: this.#now() };
    this.state.datasets.push(row);
    await this.#flush();
    return row;
  }

  async deleteDataset(id) {
    const idx = this.state.datasets.findIndex((d) => d.id === Number(id));
    if (idx === -1) return false;
    this.state.datasets.splice(idx, 1);
    this.state.dataset_rows = this.state.dataset_rows.filter((r) => r.dataset_id !== Number(id));
    await this.#flush();
    return true;
  }

  // ---- dataset rows ----
  listRows(datasetId) {
    return this.state.dataset_rows.filter((r) => r.dataset_id === Number(datasetId));
  }

  async addRow(datasetId, data) {
    if (!this.getDataset(datasetId)) throw new ValidationError('dataset not found');
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ValidationError('data must be an object');
    }
    const row = {
      id: this.#nextId('dataset_rows'),
      dataset_id: Number(datasetId),
      data,
      created_at: this.#now(),
    };
    this.state.dataset_rows.push(row);
    await this.#flush();
    return row;
  }

  async deleteRow(rowId) {
    const idx = this.state.dataset_rows.findIndex((r) => r.id === Number(rowId));
    if (idx === -1) return false;
    this.state.dataset_rows.splice(idx, 1);
    await this.#flush();
    return true;
  }

  // ---- files ----
  async addFile({ name, mime_type, data }) {
    if (!name || typeof name !== 'string') throw new ValidationError('name is required');
    if (!Buffer.isBuffer(data)) throw new ValidationError('data must be a Buffer');
    const id = this.#nextId('files');
    const filePath = path.join(this.filesDir, `${id}`);
    await fs.writeFile(filePath, data);
    const row = {
      id,
      name,
      mime_type: mime_type ?? 'application/octet-stream',
      size: data.length,
      created_at: this.#now(),
    };
    this.state.files.push(row);
    await this.#flush();
    return row;
  }

  getFileMeta(id) {
    return this.state.files.find((f) => f.id === Number(id)) ?? null;
  }

  async readFile(id) {
    const meta = this.getFileMeta(id);
    if (!meta) return null;
    const buf = await fs.readFile(path.join(this.filesDir, String(meta.id)));
    return { meta, data: buf };
  }

  async reset() {
    this.state = {
      recordings: [],
      datasets: [],
      dataset_rows: [],
      files: [],
      counters: { recordings: 0, datasets: 0, dataset_rows: 0, files: 0 },
    };
    try {
      const entries = await fs.readdir(this.filesDir);
      await Promise.all(entries.map((e) => fs.unlink(path.join(this.filesDir, e))));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await this.#flush();
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}
