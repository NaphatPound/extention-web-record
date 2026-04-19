# Code Review Findings

`npm test` passes (`7/7`), but the automated coverage is limited to the server API. The extension path has several correctness bugs that are currently untested.

## 1. High: playback failures are reported as success

- Code refs: `extension/background.js:148-151`, `extension/content.js:214-215`, `extension/popup/popup.js:129`
- `content.js` returns `{ ok: false, error }` when a step fails, but `background.js` always pushes `results.push({ ok: true, row, result })` as long as `chrome.tabs.sendMessage()` resolves.
- The popup counts failures with `filter((r) => !r.ok)`, so selector misses and action errors are silently shown as `Playback complete`.
- Impact: a broken automation run can look successful to the user, which makes debugging and trust in the tool much worse.

## 2. High: recording stops after page navigation or reload

- Code refs: `extension/content.js:6`, `extension/content.js:197-204`, `extension/background.js:62-65`
- Recording mode exists only in the content script's in-memory `state`. When the page navigates or reloads, that script instance is destroyed and the next instance starts again with `mode: 'idle'`.
- The background worker stores `recordingMeta`, but nothing uses it to re-arm recording on the new page.
- Impact: multi-page flows only capture the steps before navigation, even though the user still thinks recording is active.

## 3. Medium: documented file-upload dataset values resolve against the wrong origin

- Code refs: `extension/content.js:153-155`, `extension/options/options.html:50`
- The options UI example tells users to store file references like `/api/files/1`, but `doUpload()` calls `fetch(url)` directly from the content script.
- On a target site like `https://example.com`, that requests `https://example.com/api/files/1` instead of the configured API server.
- Impact: the documented dataset-driven upload flow fails on any non-localhost page unless every row is manually converted to an absolute API URL.

## 4. Medium: reopening the popup can reset an active recording

- Code refs: `extension/popup/popup.js:67-72`, `extension/popup/popup.js:138-143`, `extension/content.js:205-206`, `extension/background.js:62-65`
- The popup never queries the existing recording state on startup, even though the content script exposes `getState`.
- After closing and reopening the popup, the UI comes back with `Start recording` enabled. Clicking it clears the existing buffer in the background and starts over from step 1.
- Impact: users can accidentally lose a partially recorded flow just by reopening the popup and trusting the reset UI state.
