# Code Review Findings

`npm test` passes (`7/7`), but those tests only exercise the server API. The extension runtime still has several untested correctness bugs.

## 1. High: captured steps can be lost due to a storage race

- Code refs: `extension/background.js:7-20`, `extension/background.js:55-59`
- Each `recordStep` message does a read-modify-write of `recordingBuffer` through `chrome.storage.local`. If two events arrive close together, both handlers can read the same old buffer, append their own step, and then overwrite each other.
- This is especially easy to hit because clicks and form changes are recorded asynchronously and the service worker handler yields at multiple `await`s.
- Impact: recordings can silently miss steps even though the user performed them.

## 2. High: recorded file uploads replay as text entry instead of a file upload

- Code refs: `extension/content.js:53-68`, `extension/content.js:132-139`, `extension/content.js:148-165`
- The recorder treats every `INPUT` change as `type_text` unless the element is a `SELECT`. That includes `<input type="file">`.
- During playback, `type_text` routes to `doType()`, which tries to assign a string to the input's `value`. File inputs do not allow setting a non-empty value programmatically, while the real upload logic exists separately in `doUpload()` and is never reached by recorded steps.
- Impact: a recorded upload flow cannot be replayed successfully, despite the codebase explicitly supporting an `upload_file` action.

## 3. Medium: `navigate` steps cannot complete a multi-page playback

- Code refs: `extension/content.js:171-173`, `extension/content.js:188-191`, `extension/content.js:209-212`
- Playback runs the entire step list inside one content-script message on the current page. A `navigate` step changes `location.href` and unloads that page context before the loop can continue and before the original `sendResponse()` reliably completes.
- There is logic to re-arm recording after navigation, but no equivalent logic to resume playback on the new page with the remaining steps.
- Impact: recordings that include full page navigations will stop mid-run instead of continuing on the destination page.

## 4. Medium: a failed `startRecording` call can erase an unsaved buffer

- Code refs: `extension/background.js:62-66`
- `startRecording` clears `recordingBuffer` and writes new `recordingMeta` before checking whether the target tab can actually receive the `startRecording` message.
- If the tab is a Chrome-internal page, an unsupported surface, or the content script is otherwise unavailable, `forward()` fails after the old buffer has already been discarded.
- Impact: users can lose an unsaved recording by attempting to start a new one on a page where the extension cannot attach.

## 5. Medium: the editor can save recordings the player cannot execute

- Code refs: `extension/options/options.js:73-87`, `server/db.js:67-69`, `server/db.js:83-90`, `extension/content.js:176-184`
- The options editor always sends a full patch, including `name: $('#edit-name').value.trim()` and arbitrary JSON from the steps textarea. On the server, `updateRecording()` accepts an empty name and only validates that `steps` is an array.
- That means users can persist recordings with blank names or with step objects that have unknown `action` values or missing required fields. Playback then fails later in `runStep()` instead of being rejected at save time.
- Impact: the system accepts invalid recordings into durable storage and only surfaces the problem when the user tries to run them.
