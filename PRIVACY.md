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

**SnapHAR is safe by default.** Out of the box it sanitizes the data that most
often leaks credentials:

- **Redact sensitive headers & cookies** (on) — masks `Authorization`, `Cookie`,
  `Set-Cookie`, `Proxy-Authorization`, and common API-key/auth headers.
- **Redact sensitive URL tokens** (on) — masks query/fragment values such as
  `token`, `access_token`, `id_token`, `code`, `api_key`, `secret`, `password`,
  `sig`. (Browser DevTools does not redact these.)

**Treat exported HAR files as sensitive anyway.** Redaction cannot catch secrets
embedded in response bodies. Before sharing, also consider:

- **Strip response body text** — removes captured body content (keeps sizes/timings).
- A **smaller max body size**, or **disable bodies** entirely.

You can turn the redaction options off when you specifically need raw values
(e.g. debugging an auth flow).

You can also edit or delete entries in the `.har` (it's plain JSON) before sharing.

## Permissions & justifications

| Permission | Why it's needed |
| --- | --- |
| `debugger` | Attaches the Chrome DevTools Protocol to the active tab to read `Network.*` events and response bodies. This is the core capture mechanism and the reason no DevTools window is required. |
| `downloads` | Saves the assembled `.har` file to your Downloads folder. |
| `storage` | Persists your settings and short-lived in-progress capture state. |
| `activeTab` | Grants access to the tab you choose to record (when you open the popup) so SnapHAR can attach to it and show its URL/title. |
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
