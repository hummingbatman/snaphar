# SnapHAR

**One-click HAR capture for Microsoft Edge (and Chromium).** Record a page's
network traffic and export a spec-compliant **HAR 1.2** file — without ever
opening DevTools.

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

## Install (load unpacked)

1. Run `npm install` is **not required** — there are no runtime dependencies.
   The PNG icons are committed, so no build step is needed to load the extension.
2. Open `edge://extensions` (or `chrome://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this project folder.
5. Pin SnapHAR and click it to open the popup.

To produce a store-ready zip: `npm run package` → `dist/snaphar-<version>.zip`.

The icons are designed in [`icons/icon.svg`](./icons/icon.svg) (the single source of
truth). Regenerate the PNGs after editing it with `npm run icons`, which rasterizes
each size via a headless Chrome/Edge (set `CHROME_BIN` if auto-detection fails).

## Settings

Open the popup's ⚙ button (or the extension's options page):

| Setting | Default | Notes |
| --- | --- | --- |
| Include response bodies | on | Captures actual response content. |
| Max body size per response | 5 MB | Larger responses keep metadata, skip the body. |
| Redact sensitive headers & cookies | off | Masks `Authorization`, `Cookie`, `Set-Cookie`. |
| Strip response body text | off | Keeps sizes/timings, removes body content. |
| Filename pattern | `snaphar_{host}_{datetime}` | Tokens: `{host} {title} {date} {time} {datetime} {ts}`. |

## Known behaviors & limitations

- **Debugger banner.** While recording, Edge shows a *"SnapHAR started debugging
  this browser"* banner. This is unavoidable with the `chrome.debugger` API and
  disappears when you stop. Clicking **Cancel** on the banner detaches the
  debugger — SnapHAR detects this and lets you **export what was captured**.
- **One debugger per tab.** If DevTools is already open on the tab, attach fails;
  the popup explains how to resolve it.
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
npm run package # build dist/snaphar-<version>.zip
```

The correctness-critical CDP→HAR mapping lives in [`src/har.js`](./src/har.js) and
is covered by [`test/har.test.js`](./test/har.test.js) using a recorded CDP event
fixture. `har.js`, `cdp-collector.js`, and `download.js` are pure (no `chrome.*`)
so they run under plain Node.

## License

[MIT](./LICENSE)
