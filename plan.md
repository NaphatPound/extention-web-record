# Project Plan: Web Record

Chrome Extension + API Server for recording web actions and replaying them with data-driven automation.

## Source
Derived from `ideas.md`. The user wants a Chrome Extension (Macro Recorder / RPA) that:
1. Watches and records clicks, inputs, and DOM interactions on any webpage
2. Saves element info (id, className, selector, XPath, innerText, coordinates)
3. Exports the sequence as JSON
4. Plays back recorded sequences as an auto-clicker bot
5. Supports data-driven automation: pull rows from a database, substitute `{{variables}}` in the recording, and loop
6. Supports file upload from database (Blob/DataTransfer trick) and download of generated content
7. Has a UI to edit recordings and map data fields to steps

## Architecture

Three components:

### 1. API Server (Node.js + Express + SQLite)
Location: `server/`

Responsibilities:
- Store recordings (JSON sequences)
- Store data rows for data-driven automation
- Serve files for upload (base images) to the extension
- Accept downloaded files from extension

Endpoints:
- `GET  /api/health` — health check (used by completion promise "API IS WORKING")
- `GET  /api/recordings` — list recordings
- `POST /api/recordings` — create recording
- `GET  /api/recordings/:id` — get recording
- `PUT  /api/recordings/:id` — update recording
- `DELETE /api/recordings/:id` — delete recording
- `GET  /api/datasets` — list datasets
- `POST /api/datasets` — create dataset
- `GET  /api/datasets/:id/rows` — get rows for a dataset
- `POST /api/datasets/:id/rows` — add rows
- `GET  /api/files/:id` — download a stored file (base images for upload)
- `POST /api/files` — upload a file

Storage: SQLite file `server/data.db`.

### 2. Chrome Extension (Manifest V3)
Location: `extension/`

Files:
- `manifest.json` — Manifest V3 config with permissions: `activeTab`, `scripting`, `storage`, `downloads`, host permissions `<all_urls>`
- `background.js` — service worker; message hub between popup/content; talks to API server
- `content.js` — injected into pages; records events and performs playback
- `recorder.js` — recording helper (DOM event listeners, selector generator)
- `player.js` — playback helper (simulate click, type, upload, download)
- `popup/popup.html` + `popup.js` + `popup.css` — start/stop recording, run playback, sync with API
- `options/options.html` + `options.js` — edit recordings, data mapping editor, choose dataset
- `lib/selector.js` — generates unique CSS selector / XPath for a DOM element

### 3. Tests
Location: `tests/`

- `tests/api.test.js` — integration tests for the API server using `node:test` + `fetch`
- Runs against a locally started server on a free port
- Asserts the completion promise: `GET /api/health → { status: "ok" }` and full CRUD on recordings works

## Data Model

```
recordings
  id            INTEGER PRIMARY KEY
  name          TEXT NOT NULL
  description   TEXT
  steps_json    TEXT NOT NULL   -- JSON array of action steps
  created_at    TEXT
  updated_at    TEXT

datasets
  id            INTEGER PRIMARY KEY
  name          TEXT NOT NULL
  created_at    TEXT

dataset_rows
  id            INTEGER PRIMARY KEY
  dataset_id    INTEGER NOT NULL REFERENCES datasets(id)
  data_json     TEXT NOT NULL   -- JSON object: { key: value }
  created_at    TEXT

files
  id            INTEGER PRIMARY KEY
  name          TEXT NOT NULL
  mime_type     TEXT
  data          BLOB
  created_at    TEXT
```

## Step/Action JSON Shape

```json
{
  "step": 1,
  "action": "click" | "type_text" | "upload_file" | "download" | "wait" | "navigate",
  "selector": "#css-selector",
  "xpath": "/html/body/...",
  "value": "literal text OR {{variable_name}}",
  "element": { "tagName": "button", "id": "x", "className": "y", "innerText": "z" },
  "position": { "x": 100, "y": 200 }
}
```

## Execution Plan

1. **Create `logs.md`** for tracking bugs/fixes during the build.
2. **Scaffold `server/`** — `package.json`, `index.js` (Express app), `db.js` (SQLite setup), route modules.
3. **Scaffold `extension/`** — `manifest.json`, background service worker, content script (recorder + player), popup, options page, selector library.
4. **Write `tests/api.test.js`** — verify all endpoints work, including health check.
5. **Run the test suite**; log failures in `logs.md` and fix until green.
6. **Completion check**: `GET /api/health` returns `{ status: "ok", message: "API IS WORKING" }` AND recordings CRUD passes.

## Tech Choices (and why)

- **SQLite via `better-sqlite3`**: zero-config, file-based, fast synchronous API, ideal for a local tool.
- **Express**: minimal and familiar; keeps routing boilerplate light.
- **Node `node:test`**: built-in, no extra dev dep, runs the same way in any environment.
- **Manifest V3**: required for new Chrome Extensions; uses service worker instead of background page.
- **No bundler in extension**: keep it plain JS + ES modules where supported, to avoid a build step.
