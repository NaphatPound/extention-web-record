# Development Logs

Running log of bugs found, fixes applied, and feature updates during the build of web-record.

Format: `## [YYYY-MM-DD iteration-N] Title` with **Symptom**, **Root cause**, **Fix**.

---

## [2026-04-14 iter-1] `node --test tests/` cannot resolve directory
- **Symptom**: `npm test` failed with `Cannot find module 'G:\project\web-record\tests'` even though the directory existed.
- **Root cause**: Node's `--test` flag on Windows treats the argument as a file/module path, not a directory of tests. It doesn't auto-discover files in a directory without a glob pattern.
- **Fix**: Updated `package.json` test script to point at `tests/api.test.js` directly. When more test files are added, use an explicit list or a glob.

## [2026-04-14 iter-1] Initial API stood up successfully
- **Summary**: Implemented `server/index.js` (http server) and `server/db.js` (JSON-file store). Seven integration tests pass on first run: health check, CORS preflight, recordings CRUD, validation, datasets+rows, file upload/download roundtrip, 404 on unknown path.
- **Completion promise**: `GET /api/health` returns `{"status":"ok","message":"API IS WORKING"}`. ✅

## [2026-04-14 iter-2] Manifest referenced missing icon files
- **Symptom**: `manifest.json` declared `icons/icon16.png`..`icon128.png` and an `action.default_icon` map, but no `extension/icons/` directory was created. Chrome would show a warning and might refuse to load the extension.
- **Root cause**: Scaffolded manifest from a template without generating placeholder icons.
- **Fix**: Removed the `default_icon` and top-level `icons` blocks from the manifest. Chrome will fall back to a default puzzle-piece icon. Real icons can be added later without code changes.


