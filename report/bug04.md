# Code Review Findings

`Play on active tab` fails when the active tab is the extension's own `Options / Editor` page.

## 1. High: playback targets unsupported extension pages without any guard

- Code refs: `extension/manifest.json:12-18`, `extension/manifest.json:24-26`, `extension/popup/popup.js:120-141`, `extension/background.js:111-119`, `extension/background.js:242-255`
- The popup always runs playback against `activeTabId()`, and the UI offers an `Options / Editor` link that opens the editor as a normal browser tab.
- Playback depends on `chrome.tabs.sendMessage()` reaching the content script, but the manifest only registers that content script for normal web pages via `content_scripts.matches`. The extension's own `chrome-extension://.../options/options.html` page is not a valid playback target for that message path.
- When the options tab is active and the user clicks Play from the popup, `runPlayback` catches the failed `sendMessage()` call and reduces it to `Done with 1 failure(s)` instead of blocking the action up front.
- Impact: the UI presents the editor tab like any other runnable page, but playback can never succeed there.

## 2. Medium: the popup gives the wrong level of feedback for this case

- Code refs: `extension/popup/popup.js:133-141`, `extension/background.js:247-252`
- This is a deterministic unsupported-target error, not a row-specific automation failure, but the popup reports it as a generic playback failure count.
- That message makes users inspect the recording or dataset even though the real issue is simply that the active tab is the extension page itself.
- Impact: debugging time is wasted and the product appears flaky instead of clearly refusing an invalid target.
