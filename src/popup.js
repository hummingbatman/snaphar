/**
 * popup.js — Start/Stop UI + live status polling.
 *
 * The popup owns no capture state; it just renders what the service worker
 * reports via `getStatus` and sends start/stop/discard commands.
 */

const els = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  stats: document.getElementById('stats'),
  elapsed: document.getElementById('elapsed'),
  count: document.getElementById('count'),
  target: document.getElementById('target'),
  notice: document.getElementById('notice'),
  error: document.getElementById('error'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  discard: document.getElementById('discard'),
  settings: document.getElementById('settings'),
  hint: document.getElementById('hint'),
};

let pollTimer = null;

function send(type) {
  return chrome.runtime.sendMessage({ type });
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function render(status) {
  els.error.hidden = !status.error;
  if (status.error) els.error.textContent = status.error;

  els.notice.hidden = !status.warning;
  if (status.warning) els.notice.textContent = status.warning;

  if (status.active) {
    setMode('recording', 'Recording…');
    els.stats.hidden = false;
    els.elapsed.textContent = formatElapsed(status.elapsedMs || 0);
    els.count.textContent = status.requestCount ?? 0;
    showTarget(status);
    toggle(els.start, false);
    toggle(els.stop, true);
    toggle(els.discard, true);
    els.hint.textContent = 'Reproduce the issue, then Stop & Export.';
  } else if (status.interrupted) {
    setMode('interrupted', 'Recording interrupted');
    els.stats.hidden = false;
    els.count.textContent = status.requestCount ?? 0;
    showTarget(status);
    toggle(els.start, false);
    toggle(els.stop, true);
    toggle(els.discard, true);
    els.stop.textContent = 'Export anyway';
    els.hint.textContent = 'The debugger was detached — export what was captured.';
  } else {
    setMode('idle', 'Ready to record');
    els.stats.hidden = true;
    els.target.hidden = true;
    toggle(els.start, true);
    toggle(els.stop, false);
    toggle(els.discard, false);
    els.stop.textContent = 'Stop & Export';
    els.hint.textContent = 'Your browser will show a “debugging” banner while recording.';
  }
}

function setMode(mode, text) {
  els.status.className = `status status--${mode}`;
  els.statusText.textContent = text;
}

function showTarget(status) {
  if (status.targetUrl) {
    els.target.hidden = false;
    els.target.textContent = status.targetTitle || status.targetUrl;
    els.target.title = status.targetUrl;
  }
}

function toggle(el, visible) {
  el.hidden = !visible;
}

async function refresh() {
  try {
    const status = await send('getStatus');
    render(status || { active: false });
    if (status && status.active) startPolling();
    else stopPolling();
  } catch {
    /* SW may be spinning up; next poll will catch it */
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refresh, 1000);
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function busy(label) {
  els.start.disabled = els.stop.disabled = els.discard.disabled = true;
  if (label) els.statusText.textContent = label;
}
function idleButtons() {
  els.start.disabled = els.stop.disabled = els.discard.disabled = false;
}

els.start.addEventListener('click', async () => {
  busy('Starting…');
  const res = await send('startCapture');
  idleButtons();
  if (res && res.error) showError(res.error);
  await refresh();
});

els.stop.addEventListener('click', async () => {
  busy('Exporting…');
  const res = await send('stopCapture');
  idleButtons();
  if (res && res.error) showError(res.error);
  else if (res && res.filename) flashDone(res.filename);
  await refresh();
});

els.discard.addEventListener('click', async () => {
  busy('Discarding…');
  await send('cancelCapture');
  idleButtons();
  await refresh();
});

els.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

function showError(message) {
  els.error.hidden = false;
  els.error.textContent = message;
}

function flashDone(filename) {
  setMode('done', `Saved ${filename}`);
  els.hint.textContent = 'HAR downloaded. Re-import it in DevTools to verify.';
}

refresh();
