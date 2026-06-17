# Changelog

All notable changes to SnapHAR are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- One-click capture via the popup: **Start Recording** / **Stop & Export**.
- CDP debugger-based capture (`Network` + `Page` domains); preserve-log behavior
  across reloads and redirects is inherent.
- Pure CDP → HAR 1.2 converter (`src/har.js`) with timings, headers, cookies,
  query strings, post data, content bodies (text/base64), pages, and redirect
  hops as discrete entries.
- Response body capture with a configurable per-response size cap.
- Safe-by-default privacy: sanitizes sensitive headers/cookies (incl. common
  API-key/auth headers) and sensitive URL query/fragment tokens by default;
  body stripping remains opt-in.
- Options page: include bodies, max body size, header redaction, URL-token
  redaction, body stripping, filename pattern.
- Non-blocking notice when DevTools/another debugger is already attached to the
  tab (capture proceeds; modern Chromium allows multiple CDP clients).
- Live popup status: elapsed time, request count, target page, error surfacing,
  and an "Export anyway" path when the debugger is detached mid-capture.
- MV3 resilience: incremental state persistence to `chrome.storage.session` and a
  `chrome.alarms` keepalive heartbeat.
- Download pipeline: base64 `data:` URL from the service worker, with an offscreen
  Blob fallback for very large HARs.
- Unit tests (`node:test`) over the converter using a recorded CDP fixture.
- Zero-dependency packaging (`npm run package`) and icon generation scripts.
- GitHub Actions CI: lint + test.

[Unreleased]: https://example.com/snaphar/commits
