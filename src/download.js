/**
 * download.js — pure helpers for turning a HAR string into a download.
 *
 * MV3 service workers have neither `URL.createObjectURL` nor `FileReader`, so
 * the default path encodes the HAR as a base64 `data:` URL we can hand straight
 * to `chrome.downloads.download`. Very large HARs exceed practical `data:` URL
 * limits, so the SW falls back to an offscreen document that can mint a real
 * `blob:` URL (see offscreen.js). This module stays pure/testable; the actual
 * `chrome.*` calls live in background.js.
 */

// Chrome accepts large data: URLs but gets unhappy well before this; above it we
// route through the offscreen Blob fallback instead.
export const DATA_URL_LIMIT = 24 * 1024 * 1024; // ~24 MB of UTF-8 HAR text

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode a UTF-8 string into a `data:application/json;base64,...` URL without
 * relying on `btoa` (which throws on non-Latin1) or `FileReader`.
 */
export function harToDataUrl(jsonString) {
  const bytes = new TextEncoder().encode(jsonString);
  return 'data:application/json;base64,' + base64FromBytes(bytes);
}

export function base64FromBytes(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64_CHARS[(n >> 18) & 63] + BASE64_CHARS[(n >> 12) & 63]
      + BASE64_CHARS[(n >> 6) & 63] + BASE64_CHARS[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += BASE64_CHARS[(n >> 18) & 63] + BASE64_CHARS[(n >> 12) & 63] + '==';
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += BASE64_CHARS[(n >> 18) & 63] + BASE64_CHARS[(n >> 12) & 63]
      + BASE64_CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

/**
 * Expand a filename pattern. Supported tokens:
 *   {host} {title} {date} {time} {datetime} {ts}
 * Always returns a safe, `.har`-suffixed filename.
 */
export function formatFilename(pattern, context = {}) {
  const now = context.date instanceof Date ? context.date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const tokens = {
    host: sanitizeToken(context.host || 'capture'),
    title: sanitizeToken(context.title || context.host || 'capture'),
    date,
    time,
    datetime: `${date}_${time}`,
    ts: String(now.getTime()),
  };

  let name = String(pattern || 'snaphar_{host}_{datetime}').replace(
    /\{(\w+)\}/g,
    (match, key) => (key in tokens ? tokens[key] : match)
  );

  name = name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
  if (!/\.har$/i.test(name)) name += '.har';
  return name;
}

function sanitizeToken(value) {
  return String(value)
    .replace(/^https?:\/\//, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'capture';
}
