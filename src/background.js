/**
 * background.js — SnapHAR MV3 service worker.
 *
 * Responsibilities:
 *  - attach/detach the CDP debugger to the active tab and enable Network/Page
 *  - feed `chrome.debugger.onEvent` into a CdpCollector
 *  - fetch response bodies (size-capped) as requests finish
 *  - persist capture state to chrome.storage.session so an SW restart mid-capture
 *    doesn't lose data; keep the SW alive with a chrome.alarms heartbeat
 *  - on stop: build a HAR 1.2 log and download it (data: URL, or offscreen Blob
 *    fallback for very large captures)
 *
 * Listeners are registered at top level (synchronously) so they survive SW
 * suspension/restart, per MV3 guidance.
 */

import { CdpCollector } from './cdp-collector.js';
import { buildHar } from './har.js';
import { harToDataUrl, formatFilename, DATA_URL_LIMIT } from './download.js';

const CDP_VERSION = '1.3';
const SESSION_KEY = 'snaphar:capture';
const KEEPALIVE_ALARM = 'snaphar-keepalive';
const PERSIST_THROTTLE_MS = 750;

const DEFAULT_SETTINGS = {
  includeBodies: true,
  maxBodySize: 5 * 1024 * 1024, // 5 MB per response body
  redactHeaders: true, // safe-by-default: sanitize sensitive headers/cookies
  redactQuery: true, // safe-by-default: sanitize sensitive URL tokens
  redactBodies: false, // opt-in: bodies are often the point of the capture
  filenamePattern: 'snaphar_{host}_{datetime}',
};

/**
 * In-memory capture state. Mirrors what we persist to storage.session.
 * @type {{active:boolean, interrupted:boolean, error:string|null, tabId:number,
 *   startedAt:number, settings:object, targetUrl:string, targetTitle:string} | null}
 */
let capture = null;
let collector = null;
let loadPromise = null;
let persistTimer = null;
const pendingRevokes = new Map(); // downloadId -> blob url

/* ------------------------------------------------------------------ wiring */

chrome.debugger.onEvent.addListener(onDebuggerEvent);
chrome.debugger.onDetach.addListener(onDebuggerDetach);
chrome.runtime.onMessage.addListener(onMessage);
chrome.alarms.onAlarm.addListener(onAlarm);
chrome.downloads.onChanged.addListener(onDownloadChanged);

/* ------------------------------------------------------------- persistence */

async function ensureLoaded() {
  if (capture !== null) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      const saved = stored[SESSION_KEY];
      if (saved && saved.active) {
        capture = saved.capture;
        collector = CdpCollector.fromJSON(saved.collector);
      } else {
        capture = false; // sentinel: "loaded, nothing active"
      }
    })();
  }
  await loadPromise;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, PERSIST_THROTTLE_MS);
}

async function persistNow() {
  if (!capture || !collector) return;
  await chrome.storage.session.set({
    [SESSION_KEY]: { active: true, capture, collector: collector.toJSON() },
  });
}

async function clearPersisted() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await chrome.storage.session.remove(SESSION_KEY);
}

function isActive() {
  return !!capture && capture.active;
}

/* --------------------------------------------------------------- messaging */

function onMessage(message, _sender, sendResponse) {
  (async () => {
    await ensureLoaded();
    try {
      switch (message && message.type) {
        case 'getStatus':
          sendResponse(getStatus());
          break;
        case 'startCapture':
          sendResponse(await startCapture());
          break;
        case 'stopCapture':
          sendResponse(await stopCapture({ export: true }));
          break;
        case 'cancelCapture':
          sendResponse(await stopCapture({ export: false }));
          break;
        default:
          sendResponse({ error: `unknown message: ${message && message.type}` });
      }
    } catch (err) {
      sendResponse({ error: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // async sendResponse
}

function getStatus() {
  if (!isActive()) {
    return { active: false, interrupted: false, error: null, requestCount: 0, elapsedMs: 0 };
  }
  return {
    active: !capture.interrupted,
    interrupted: !!capture.interrupted,
    error: capture.error || null,
    warning: capture.warning || null,
    requestCount: collector ? collector.requestCount : 0,
    elapsedMs: Date.now() - capture.startedAt,
    tabId: capture.tabId,
    targetUrl: capture.targetUrl,
    targetTitle: capture.targetTitle,
  };
}

/* ----------------------------------------------------------------- capture */

async function getSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function startCapture() {
  if (isActive()) return { error: 'A capture is already running.' };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return { error: 'No active tab to record.' };
  if (/^(edge|chrome|about|devtools|view-source):/i.test(tab.url || '')) {
    return { error: 'Cannot record browser-internal pages. Open a normal http(s) page.' };
  }

  const settings = await getSettings();
  const target = { tabId: tab.id };

  // Detect DevTools / another debugger *before* we attach (afterwards the tab
  // target reports attached:true because of our own session). Modern Chromium
  // allows multiple debugger clients per tab, so this is a warning, not a block.
  const sharedWithOther = await isTabBeingDebugged(tab.id);

  try {
    await chrome.debugger.attach(target, CDP_VERSION);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/already attached|another debugger/i.test(msg)) {
      // Genuine exclusive conflict (typically another extension holding the tab).
      return { error: 'Another extension is debugging this tab. Close it and retry.' };
    }
    return { error: `Could not attach debugger: ${msg}` };
  }

  try {
    await sendCommand(target, 'Network.enable', {
      maxResourceBufferSize: 100 * 1024 * 1024,
      maxTotalBufferSize: 200 * 1024 * 1024,
    });
    await sendCommand(target, 'Page.enable', {});
  } catch (err) {
    await safeDetach(target);
    return { error: `Could not enable CDP domains: ${errText(err)}` };
  }

  collector = new CdpCollector();
  capture = {
    active: true,
    interrupted: false,
    error: null,
    warning: sharedWithOther
      ? 'DevTools (or another debugger) is open on this tab. Recording still works; in rare cases a response body may be missing.'
      : null,
    tabId: tab.id,
    startedAt: Date.now(),
    settings,
    targetUrl: tab.url || '',
    targetTitle: tab.title || tab.url || '',
  };

  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  await persistNow();
  return { ok: true };
}

async function stopCapture({ export: doExport }) {
  if (!capture || !capture.active) return { error: 'No capture is running.' };

  const target = { tabId: capture.tabId };
  capture.active = false;

  if (!capture.interrupted) {
    await safeSend(target, 'Network.disable');
    await safeSend(target, 'Page.disable');
    await safeDetach(target);
  }
  await chrome.alarms.clear(KEEPALIVE_ALARM);

  let result = { ok: true };
  if (doExport) {
    try {
      result = await exportHar();
    } catch (err) {
      result = { error: `Failed to build/download HAR: ${errText(err)}` };
    }
  }

  collector = null;
  capture = false;
  await clearPersisted();
  return result;
}

async function exportHar() {
  const { settings, targetUrl, targetTitle } = capture;
  const collected = collector.getCollected();
  if (!collected.entries.length) {
    return { error: 'No network requests were captured.' };
  }

  const browser = detectBrowser();
  const har = buildHar(collected, {
    redactHeaders: settings.redactHeaders,
    redactQuery: settings.redactQuery,
    redactBodies: settings.redactBodies,
    browser: browser.name,
    browserVersion: browser.version,
  });
  const json = JSON.stringify(har, null, 2);

  const filename = formatFilename(settings.filenamePattern, {
    host: hostOf(targetUrl),
    title: targetTitle,
  });

  const downloadId = await triggerDownload(json, filename);
  return { ok: true, filename, downloadId, requestCount: collected.entries.length, bytes: json.length };
}

/* --------------------------------------------------------- debugger events */

function onDebuggerEvent(source, method, params) {
  void (async () => {
    await ensureLoaded();
    if (!isActive() || !collector) return;
    if (source.tabId !== capture.tabId) return;

    collector.addEvent(method, params);

    if (method === 'Network.loadingFinished') {
      await maybeFetchBody(source, params.requestId);
    }
    schedulePersist();
  })();
}

async function maybeFetchBody(source, requestId) {
  const settings = capture.settings;
  if (!settings.includeBodies) return;

  const record = collector.requests.get(requestId);
  if (!record || record.failed || !record.response) return;

  const known = record.dataLength || record.encodedDataLength || 0;
  if (known && known > settings.maxBodySize) return; // too large; skip body, keep metadata

  try {
    const res = await sendCommand(source, 'Network.getResponseBody', { requestId });
    if (res && res.body != null) {
      const size = res.base64Encoded ? res.body.length * 0.75 : res.body.length;
      if (size > settings.maxBodySize) return;
      collector.setResponseBody(requestId, res);
      schedulePersist();
    }
  } catch {
    // No body available (redirects, 204, evicted buffer, ...). Non-fatal.
  }
}

function onDebuggerDetach(source, reason) {
  void (async () => {
    await ensureLoaded();
    if (!isActive() || source.tabId !== capture.tabId) return;
    // The user closed our debugger session (banner "Cancel"), navigated away, or
    // the tab closed. Keep the data; let the popup offer "Export anyway".
    capture.interrupted = true;
    capture.error = `Recording interrupted (${reason}). You can still export what was captured.`;
    await chrome.alarms.clear(KEEPALIVE_ALARM);
    await persistNow();
  })();
}

/* ------------------------------------------------------------------ alarms */

function onAlarm(alarm) {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Touching an async chrome API resets the SW idle timer while recording.
  void chrome.storage.session.get(SESSION_KEY);
}

/* ---------------------------------------------------------------- download */

async function triggerDownload(json, filename) {
  if (json.length <= DATA_URL_LIMIT) {
    const url = harToDataUrl(json);
    return chrome.downloads.download({ url, filename, saveAs: false });
  }

  // Large HAR: mint a real blob: URL in an offscreen document.
  const url = await createBlobUrlViaOffscreen(json);
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
  pendingRevokes.set(downloadId, url);
  return downloadId;
}

async function createBlobUrlViaOffscreen(json) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'create-blob-url', json });
  if (!response || !response.url) throw new Error('offscreen could not create blob URL');
  return response.url;
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Create a Blob URL to download very large HAR files.',
  });
}

function onDownloadChanged(delta) {
  if (!delta.state || !pendingRevokes.has(delta.id)) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    const url = pendingRevokes.get(delta.id);
    pendingRevokes.delete(delta.id);
    void chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke-blob-url', url });
    if (pendingRevokes.size === 0) {
      void chrome.offscreen.closeDocument?.().catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ utils */

/** Identify the host Chromium browser for the HAR `log.browser` field. */
function detectBrowser() {
  const ua = (self.navigator && self.navigator.userAgent) || '';
  let m;
  if ((m = ua.match(/Edg(?:A|iOS)?\/([\d.]+)/))) return { name: 'Microsoft Edge', version: m[1] };
  if ((m = ua.match(/OPR\/([\d.]+)/))) return { name: 'Opera', version: m[1] };
  if ((m = ua.match(/Brave\/([\d.]+)/))) return { name: 'Brave', version: m[1] };
  if ((m = ua.match(/Chrome\/([\d.]+)/))) return { name: 'Google Chrome', version: m[1] };
  return { name: 'Chromium', version: '' };
}

/** True if a debugger (DevTools or another extension) is attached to the tab. */
async function isTabBeingDebugged(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    return targets.some((t) => t.tabId === tabId && t.type === 'page' && t.attached);
  } catch {
    return false;
  }
}

function sendCommand(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function safeSend(target, method, params = {}) {
  try {
    await sendCommand(target, method, params);
  } catch {
    /* ignore — tab may be gone */
  }
}

async function safeDetach(target) {
  try {
    await chrome.debugger.detach(target);
  } catch {
    /* already detached */
  }
}

function errText(err) {
  return String(err && err.message ? err.message : err);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'capture';
  }
}
