# SnapHAR

**One-click HAR capture for Chromium browsers — Edge, Chrome, Brave, and more.** Record a page's
network traffic and export a spec-compliant **HAR 1.2** file — without ever
opening DevTools.

> 📦 **[Install from the Chrome Web Store →](https://chromewebstore.google.com/detail/snaphar/aabmelinahckmnlipcglmikbaelmcanf)**

Open the popup → **Start Recording** → reproduce the issue → **Stop & Export**.
You get a `.har` you can re-import into the DevTools Network tab, attach to a bug,
or feed to the [Google HAR Analyzer](https://toolbox.googleapps.com/apps/har_analyzer/).

---

## Why

The built-in way to grab a HAR is fiddly: `F12` → **Network** → enable
**Preserve log** → reproduce → right-click → **Save all as HAR**. SnapHAR
collapses that into two clicks and gets preserve-log behavior for free.

## How it works

SnapHAR attaches the **Chrome DevTools Protocol** debugger to the active tab,
enables the `Network` (and `Page`) domain, and accumulates `Network.*` events per
`requestId`. On stop it assembles a HAR 1.2 log and downloads it. Because state is
never cleared on navigation, **capture survives reloads and redirects** — preserve
log is inherent.

```
popup.js ──messages──▶ background.js (service worker)
                          │  chrome.debugger.attach + Network.enable
                          │  collect CDP events ─▶ cdp-collector.js
                          │  fetch response bodies (size-capped)
                          ▼
                       har.js  (pure CDP ─▶ HAR 1.2 converter)
                          ▼
                  chrome.downloads.download  (data: URL, or offscreen Blob)
```

## Install

**[Get SnapHAR on the Chrome Web Store](https://chromewebstore.google.com/detail/snaphar/aabmelinahckmnlipcglmikbaelmcanf)** —
the easiest way to install. Works in Chrome, Edge, and Brave (Edge users can add
it from the Chrome Web Store).

### From source (load unpacked)

No build or `npm install` needed — there are no runtime dependencies and the
icons are committed.

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project folder.
4. Pin SnapHAR and click it to open the popup.

To produce a store-ready zip: `npm run package` → `dist/snaphar-<version>.zip`.

## Settings

Open the popup's ⚙ button (or the extension's options page):

| Setting | Default | Notes |
| --- | --- | --- |
| Include response bodies | on | Captures actual response content. |
| Max body size per response | 5 MB | Larger responses keep metadata, skip the body. |
| Redact sensitive headers & cookies | **on** | Masks `Authorization`, `Cookie`, `Set-Cookie`, and common API-key/auth headers. |
| Redact sensitive URL tokens | **on** | Masks query/fragment values like `token`, `access_token`, `code`, `api_key`, `secret`, `password`, `sig`. |
| Strip response body text | off | Keeps sizes/timings, removes body content. |
| Filename pattern | `snaphar_{host}_{datetime}` | Tokens: `{host} {title} {date} {time} {datetime} {ts}`. |

SnapHAR is **safe by default**: like recent DevTools it sanitizes sensitive
headers/cookies, and goes further by also masking sensitive URL tokens (which
DevTools leaves intact). Uncheck those options only when you need raw values
(e.g. debugging auth). Response **bodies are still included** by default and can
contain secrets — strip or cap them before sharing.

## Known behaviors & limitations

- **Debugger banner.** While recording, your browser shows a *"SnapHAR started
  debugging this browser"* banner. This is unavoidable with the `chrome.debugger`
  API and disappears when you stop. Clicking **Cancel** on the banner detaches the
  debugger — SnapHAR detects this and lets you **export what was captured**.
- **Recording alongside DevTools.** Modern Chromium allows multiple debugger
  clients per tab, so you can record even with DevTools open. SnapHAR shows a
  non-blocking notice in that case (a response body may occasionally be missing).
- **Browser-internal pages** (`edge://`, `chrome://`, `view-source:`, …) can't be
  recorded.
- **Sensitive data.** Captured HARs can contain auth tokens, cookies, and response
  bodies. See [PRIVACY.md](./PRIVACY.md) and use the redaction options when
  sharing.
- **Store review.** The `debugger` permission triggers stricter add-on review and
  a prominent permission warning at install. The justification is documented in
  PRIVACY.md.

## Development

```bash
npm test        # node:test unit tests over har.js / cdp-collector.js / download.js
npm run lint    # syntax-check all source modules
npm run icons   # regenerate PNGs from icons/icon.svg (set CHROME_BIN if needed)
npm run package # build dist/snaphar-<version>.zip
```

The correctness-critical CDP→HAR mapping lives in [`src/har.js`](./src/har.js) and
is covered by [`test/har.test.js`](./test/har.test.js) using a recorded CDP event
fixture. `har.js`, `cdp-collector.js`, and `download.js` are pure (no `chrome.*`)
so they run under plain Node. Icons are designed in
[`icons/icon.svg`](./icons/icon.svg) — the single source of truth; `npm run icons`
rasterizes each size via headless Chrome/Edge.

## License

[MIT](./LICENSE)
