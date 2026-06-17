/**
 * options.js — load/save SnapHAR settings in chrome.storage.sync.
 *
 * Keep DEFAULT_SETTINGS in sync with background.js (single source of truth would
 * require a shared import; both are intentionally tiny and identical).
 */

const DEFAULT_SETTINGS = {
  includeBodies: true,
  maxBodySize: 5 * 1024 * 1024,
  redactHeaders: true,
  redactQuery: true,
  redactBodies: false,
  filenamePattern: 'snaphar_{host}_{datetime}',
};

const els = {
  includeBodies: document.getElementById('includeBodies'),
  maxBodySize: document.getElementById('maxBodySize'),
  redactHeaders: document.getElementById('redactHeaders'),
  redactQuery: document.getElementById('redactQuery'),
  redactBodies: document.getElementById('redactBodies'),
  filenamePattern: document.getElementById('filenamePattern'),
  save: document.getElementById('save'),
  reset: document.getElementById('reset'),
  saved: document.getElementById('saved'),
};

function apply(settings) {
  els.includeBodies.checked = settings.includeBodies;
  els.maxBodySize.value = Math.round(settings.maxBodySize / 1024);
  els.redactHeaders.checked = settings.redactHeaders;
  els.redactQuery.checked = settings.redactQuery;
  els.redactBodies.checked = settings.redactBodies;
  els.filenamePattern.value = settings.filenamePattern;
}

function collect() {
  const kb = Number(els.maxBodySize.value);
  return {
    includeBodies: els.includeBodies.checked,
    maxBodySize: Number.isFinite(kb) && kb >= 0 ? Math.round(kb * 1024) : DEFAULT_SETTINGS.maxBodySize,
    redactHeaders: els.redactHeaders.checked,
    redactQuery: els.redactQuery.checked,
    redactBodies: els.redactBodies.checked,
    filenamePattern: els.filenamePattern.value.trim() || DEFAULT_SETTINGS.filenamePattern,
  };
}

async function load() {
  const stored = await chrome.storage.sync.get('settings');
  apply({ ...DEFAULT_SETTINGS, ...(stored.settings || {}) });
}

async function save() {
  await chrome.storage.sync.set({ settings: collect() });
  flashSaved();
}

function flashSaved() {
  els.saved.classList.add('show');
  setTimeout(() => els.saved.classList.remove('show'), 1500);
}

els.save.addEventListener('click', save);
els.reset.addEventListener('click', async () => {
  apply(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  flashSaved();
});

load();
