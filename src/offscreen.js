/**
 * offscreen.js — runs in the offscreen document.
 *
 * The service worker can't call `URL.createObjectURL`, so for very large HARs it
 * asks us to wrap the JSON in a Blob and hand back a `blob:` URL it can pass to
 * `chrome.downloads.download`. We hold the URL alive until the SW tells us the
 * download finished, then revoke it.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  switch (message.type) {
    case 'create-blob-url': {
      try {
        const blob = new Blob([message.json], { type: 'application/json' });
        sendResponse({ url: URL.createObjectURL(blob) });
      } catch (err) {
        sendResponse({ error: String(err && err.message ? err.message : err) });
      }
      return true;
    }
    case 'revoke-blob-url': {
      try {
        URL.revokeObjectURL(message.url);
      } catch {
        /* already revoked */
      }
      sendResponse({ ok: true });
      return true;
    }
    default:
      return false;
  }
});
