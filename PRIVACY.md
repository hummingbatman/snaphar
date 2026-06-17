# SnapHAR — Privacy & Permissions

SnapHAR is a developer tool for capturing network traffic into HAR files. It is
designed to keep your data **on your machine**.

## Data handling

- **No data leaves your device.** SnapHAR has no servers, no analytics, no
  telemetry, and makes no network requests of its own. Captured traffic is
  assembled locally and saved to your **Downloads** folder as a `.har` file.
- **No background collection.** Capture happens only between when you click
  **Start Recording** and **Stop & Export**. Nothing is recorded otherwise.
- **Local settings only.** Your preferences are stored via `chrome.storage.sync`
  (synced by the browser to your own account, if sync is enabled). In-progress
  capture state is held in `chrome.storage.session` and cleared when you stop.

## What a HAR file can contain

A HAR is a full record of the captured requests and responses. Depending on the
site and your settings, it **may include sensitive data**:

- URLs, query strings, request/response headers
- **Cookies** and **`Authorization`** tokens
- Request bodies (form data, JSON payloads)
- **Response bodies** (page content, API responses) — included by default

**Treat exported HAR files as sensitive.** Before sharing one, consider enabling:

- **Redact sensitive headers & cookies** — masks `Authorization`, `Cookie`,
  `Set-Cookie`, `Proxy-Authorization`.
- **Strip response body text** — removes captured body content (keeps sizes/timings).
- A **smaller max body size**, or **disable bodies** entirely.

You can also edit or delete entries in the `.har` (it's plain JSON) before sharing.

## Permissions & justifications

| Permission | Why it's needed |
| --- | --- |
| `debugger` | Attaches the Chrome DevTools Protocol to the active tab to read `Network.*` events and response bodies. This is the core capture mechanism and the reason no DevTools window is required. |
| `downloads` | Saves the assembled `.har` file to your Downloads folder. |
| `storage` | Persists your settings and short-lived in-progress capture state. |
| `activeTab` / `tabs` | Identifies the active tab to record and shows its URL/title in the popup. |
| `alarms` | A periodic heartbeat that keeps the service worker alive during long recordings (MV3 workers are otherwise suspended when idle). |
| `offscreen` | Creates a Blob URL to download unusually large HAR files that exceed `data:` URL limits. |

### About the `debugger` permission

Because SnapHAR uses `chrome.debugger`, the browser:

1. Shows a **"SnapHAR started debugging this browser"** banner while recording
   (it disappears when you stop), and
2. Displays a stronger permission warning at install time.

This is expected. The debugger connection is only active during a recording
session, is attached solely to the tab you are recording, and is detached as soon
as you stop or close the capture.

## Contact

SnapHAR is open source. Report concerns or issues on the project's repository.
