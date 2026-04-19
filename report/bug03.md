# Code Review Findings

`npm test` passes (`7/7`), but the extension save flow still has an untested failure mode that matches `Save failed: Failed to fetch`.

## 1. High: the options page can save a broken API URL and falsely report success

- Code refs: `extension/options/options.js:37-42`, `extension/background.js:83-95`, `extension/background.js:249-260`, `extension/popup/popup.js:97-103`
- `options.js` persists whatever the user typed via `setApiUrl` before verifying it, then always shows `API URL saved` even if the follow-up `healthCheck` fails.
- Once that bad value is stored in `chrome.storage.local`, popup saves call `saveRecording`, which goes through `background.js -> api() -> fetch(apiUrl + '/api/recordings')`.
- If the URL is malformed, missing a scheme, points to a dead server, or otherwise cannot be reached, `fetch()` rejects and the popup shows the raw error as `Save failed: Failed to fetch`.
- Impact: the UI actively confirms a broken configuration, and the next recording save fails with a generic network error instead of stopping the bad config at the source.

## 2. Medium: network failures are surfaced without enough context to debug

- Code refs: `extension/background.js:83-95`, `extension/popup/popup.js:102-103`
- `api()` only decorates HTTP responses. When `fetch()` itself rejects, the user gets the bare platform message `Failed to fetch`, with no `apiUrl`, no endpoint path, and no hint that the stored API base is the likely problem.
- The popup relays that message directly, so the failure gives no actionable detail even though the extension knows both the configured base URL and the target path.
- Impact: users and maintainers have to guess whether the problem is the server being down, a bad API URL, a scheme typo, or some other connectivity issue.
