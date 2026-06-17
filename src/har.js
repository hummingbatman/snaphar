/**
 * har.js — pure CDP-events -> HAR 1.2 converter.
 *
 * This module is intentionally free of any `chrome.*` / DOM / Node API so it can
 * be unit-tested under `node:test` and imported by the service worker alike.
 *
 * Input is the normalized shape produced by `cdp-collector.js`:
 *   {
 *     entries: NormalizedRecord[],
 *     pages:   PageRecord[],
 *   }
 *
 * A NormalizedRecord bundles the raw CDP sub-objects we accumulated per
 * `requestId` (request, response, timing) plus a few derived fields. Keeping the
 * raw CDP objects here (rather than in the collector) concentrates the
 * correctness-critical CDP->HAR mapping in one testable place.
 */

export const HAR_VERSION = '1.2';
export const DEFAULT_CREATOR = { name: 'SnapHAR', version: '1.0.0' };

const REDACTED = '[redacted by SnapHAR]';
const REDACTED_TOKEN = 'REDACTED'; // URL-safe placeholder for query values

// Headers whose values commonly carry secrets. DevTools sanitizes the first
// four; SnapHAR also covers common custom auth headers.
const REDACTABLE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'authentication',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-amz-security-token',
  'x-functions-key',
]);

// Query-string parameters whose values commonly carry secrets (DevTools does
// not redact these).
const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'code',
  'key',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'sig',
  'signature',
  'session',
  'sessionid',
  'sid',
]);

/**
 * Build a complete HAR 1.2 log from collected, normalized records.
 *
 * @param {{entries: object[], pages: object[]}} collected
 * @param {object} [options]
 * @param {boolean} [options.redactHeaders=false] redact sensitive headers/cookies
 * @param {object} [options.creator] override creator {name, version}
 * @param {string} [options.browser] browser name for log.browser
 * @returns {object} HAR log wrapper: { log: {...} }
 */
export function buildHar(collected, options = {}) {
  const { entries = [], pages = [] } = collected || {};
  const creator = options.creator || DEFAULT_CREATOR;

  const harEntries = entries
    .map((record) => entryFromRecord(record, options))
    .filter(Boolean)
    // HAR consumers expect entries in chronological order.
    .sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));

  const harPages = pages.map((page) => ({
    id: page.id,
    startedDateTime: page.startedDateTime || harEntries[0]?.startedDateTime || new Date(0).toISOString(),
    title: page.title || page.url || page.id,
    pageTimings: {
      onContentLoad: numberOr(page.onContentLoad, -1),
      onLoad: numberOr(page.onLoad, -1),
    },
  }));

  const log = {
    version: HAR_VERSION,
    creator: { name: creator.name, version: creator.version },
    entries: harEntries,
  };
  // `pages` is optional in HAR 1.2; only emit when we actually tracked some.
  if (harPages.length) log.pages = harPages;
  if (options.browser) log.browser = { name: options.browser, version: options.browserVersion || '' };

  return { log };
}

/** Convert a single normalized record into a HAR entry (or null to skip). */
function entryFromRecord(record, options) {
  if (!record || !record.request) return null;

  const request = record.request;
  const response = record.response || null;

  const startedDateTime = toIso(record.wallTime) || toIso(0);
  const requestHeaders = bestRequestHeaders(record);
  const responseHeaders = bestResponseHeaders(record);

  const time = computeTotalTime(record);

  const entry = {
    startedDateTime,
    time,
    request: buildRequest(request, requestHeaders, options),
    response: buildResponse(record, response, responseHeaders, options),
    cache: {},
    timings: computeTimings(record),
  };

  if (record.pageref) entry.pageref = record.pageref;
  if (record.serverIPAddress) entry.serverIPAddress = record.serverIPAddress;
  if (record.connectionId != null && record.connectionId !== '') {
    entry.connection = String(record.connectionId);
  }
  if (record.resourceType) entry._resourceType = record.resourceType;
  if (record.priority) entry._priority = record.priority;
  if (record.fromCache) entry._fromCache = record.fromCache;
  if (record.initiator) entry._initiator = record.initiator;

  return entry;
}

function buildRequest(request, headers, options) {
  const headerList = redactHeaders(headersToList(headers), options);
  const url = options.redactQuery ? redactUrlTokens(request.url || '') : request.url || '';
  const out = {
    method: request.method || 'GET',
    url,
    httpVersion: 'HTTP/1.1',
    cookies: redactCookies(parseRequestCookies(headers), options),
    headers: headerList,
    queryString: parseQueryString(url),
    headersSize: -1,
    bodySize: postBodySize(request),
  };
  const postData = buildPostData(request);
  if (postData) out.postData = postData;
  return out;
}

function buildResponse(record, response, headers, options) {
  if (!response) {
    // Failed/aborted request with no response received.
    return {
      status: 0,
      statusText: record.errorText || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: 'x-unknown' },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
      _error: record.errorText || undefined,
    };
  }

  const headerList = redactHeaders(headersToList(headers), options);
  const out = {
    status: response.status ?? 0,
    statusText: response.statusText || '',
    httpVersion: normalizeProtocol(response.protocol),
    cookies: redactCookies(parseResponseCookies(headers), options),
    headers: headerList,
    content: buildContent(record, response, headers, options),
    redirectURL: redactRedirect(findHeader(headers, 'location') || '', options),
    headersSize: headersTextSize(response.headersText),
    bodySize: numberOr(record.encodedDataLength, response.encodedDataLength ?? -1),
  };
  if (record.fromCache) out._transferSize = 0;
  return out;
}

function buildContent(record, response, headers, options) {
  const mimeType = response.mimeType || findHeader(headers, 'content-type') || 'x-unknown';
  const content = { size: -1, mimeType };

  const decodedSize = decodedBodySize(record);
  if (decodedSize >= 0) content.size = decodedSize;

  const encoded = numberOr(record.encodedDataLength, response.encodedDataLength);
  if (decodedSize >= 0 && encoded >= 0 && decodedSize - encoded > 0) {
    content.compression = decodedSize - encoded;
  }

  if (record.body != null) {
    if (options.redactBodies) {
      content.text = REDACTED;
    } else {
      content.text = record.body;
      if (record.base64Encoded) content.encoding = 'base64';
    }
  }
  return content;
}

/* --------------------------------------------------------------------------
 * Timings — derived from CDP `Network.responseReceived` `response.timing`.
 *
 * All `*Start`/`*End` fields are millisecond offsets from `timing.requestTime`
 * (a monotonic clock value, in seconds), or -1 when the phase did not occur.
 * Per the HAR spec, `ssl` time is contained within `connect` time and is NOT
 * added again into the total.
 * ------------------------------------------------------------------------ */
export function computeTimings(record) {
  const timing = record.response && record.response.timing;
  if (!timing) {
    // No detailed timing (cache hit, failure, data: URL, ...). Provide a HAR-
    // valid stub; `wait` carries whatever wall-clock delta we can recover.
    const wall = wallDeltaMs(record);
    return {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: 0,
      wait: wall >= 0 ? round3(wall) : 0,
      receive: 0,
      ssl: -1,
    };
  }

  const dns = timing.dnsStart >= 0 ? timing.dnsEnd - timing.dnsStart : -1;
  const connect = timing.connectStart >= 0 ? timing.connectEnd - timing.connectStart : -1;
  const ssl = timing.sslStart >= 0 ? timing.sslEnd - timing.sslStart : -1;
  const send = timing.sendStart >= 0 ? Math.max(0, timing.sendEnd - timing.sendStart) : 0;

  // Blocked = time from requestTime baseline (0) until the first real phase.
  const blocked = firstNonNegative([timing.dnsStart, timing.connectStart, timing.sendStart]);

  const wait = timing.receiveHeadersEnd >= 0
    ? Math.max(0, timing.receiveHeadersEnd - timing.sendEnd)
    : 0;

  // Receive = from the moment headers finished arriving to loadingFinished.
  let receive = 0;
  const finishedOffset = finishedOffsetMs(record, timing);
  if (finishedOffset >= 0 && timing.receiveHeadersEnd >= 0) {
    receive = Math.max(0, finishedOffset - timing.receiveHeadersEnd);
  }

  return {
    blocked: round3(blocked),
    dns: round3(dns),
    connect: round3(connect),
    send: round3(send),
    wait: round3(wait),
    receive: round3(receive),
    ssl: round3(ssl),
  };
}

/** Total entry time = sum of non-negative timing phases (ssl excluded). */
function computeTotalTime(record) {
  const t = computeTimings(record);
  const parts = [t.blocked, t.dns, t.connect, t.send, t.wait, t.receive];
  const total = parts.reduce((sum, v) => (v > 0 ? sum + v : sum), 0);
  return round3(total);
}

/** Offset (ms) from timing.requestTime to loadingFinished, or -1. */
function finishedOffsetMs(record, timing) {
  if (record.finishedTimestamp == null || timing.requestTime == null) return -1;
  return (record.finishedTimestamp - timing.requestTime) * 1000;
}

/** Wall-clock duration (ms) from request start to finish, or -1 if unknown. */
function wallDeltaMs(record) {
  if (record.startTimestamp == null) return -1;
  const end = record.finishedTimestamp ?? record.responseTimestamp;
  if (end == null) return -1;
  return Math.max(0, (end - record.startTimestamp) * 1000);
}

/* --------------------------------------------------------------------------
 * Headers / cookies / query helpers
 * ------------------------------------------------------------------------ */

function bestRequestHeaders(record) {
  // Preference: extra-info raw headers > response.requestHeaders > request.headers.
  return record.extraRequestHeaders
    || (record.response && record.response.requestHeaders)
    || record.request.headers
    || {};
}

function bestResponseHeaders(record) {
  return record.extraResponseHeaders
    || (record.response && record.response.headers)
    || {};
}

function headersToList(headers) {
  const out = [];
  if (!headers) return out;
  for (const [name, rawValue] of Object.entries(headers)) {
    const value = rawValue == null ? '' : String(rawValue);
    // CDP joins repeated headers (e.g. Set-Cookie) with newlines.
    for (const part of value.split('\n')) {
      out.push({ name, value: part });
    }
  }
  return out;
}

function findHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value == null ? '' : String(value);
  }
  return undefined;
}

function parseQueryString(url) {
  try {
    const u = new URL(url);
    const out = [];
    for (const [name, value] of u.searchParams) out.push({ name, value });
    return out;
  } catch {
    return [];
  }
}

function parseRequestCookies(headers) {
  const raw = findHeader(headers, 'cookie');
  if (!raw) return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      return idx >= 0
        ? { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() }
        : { name: pair, value: '' };
    });
}

function parseResponseCookies(headers) {
  const raw = findHeader(headers, 'set-cookie');
  if (!raw) return [];
  return raw.split('\n').map(parseSetCookie).filter(Boolean);
}

function parseSetCookie(line) {
  const parts = line.split(';');
  const nameValue = parts.shift();
  if (!nameValue) return null;
  const eq = nameValue.indexOf('=');
  if (eq < 0) return null;

  const cookie = {
    name: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
  };
  for (const attr of parts) {
    const eqi = attr.indexOf('=');
    const key = (eqi >= 0 ? attr.slice(0, eqi) : attr).trim().toLowerCase();
    const val = eqi >= 0 ? attr.slice(eqi + 1).trim() : '';
    if (key === 'path') cookie.path = val;
    else if (key === 'domain') cookie.domain = val;
    else if (key === 'expires') cookie.expires = toIso(Date.parse(val) / 1000) || val;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') cookie.sameSite = val;
  }
  return cookie;
}

function buildPostData(request) {
  if (!request.postData && !request.hasPostData) return undefined;
  const mimeType = findHeader(request.headers, 'content-type') || 'application/octet-stream';
  const text = request.postData || '';
  const postData = { mimeType, text };
  if (/application\/x-www-form-urlencoded/i.test(mimeType) && text) {
    postData.params = parseFormParams(text);
  } else {
    postData.params = [];
  }
  return postData;
}

function parseFormParams(text) {
  return text
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      const name = idx >= 0 ? pair.slice(0, idx) : pair;
      const value = idx >= 0 ? pair.slice(idx + 1) : '';
      return { name: safeDecode(name), value: safeDecode(value) };
    });
}

/* --------------------------------------------------------------------------
 * Redaction
 * ------------------------------------------------------------------------ */

function redactHeaders(list, options) {
  if (!options.redactHeaders) return list;
  return list.map((h) =>
    REDACTABLE_HEADERS.has(h.name.toLowerCase()) ? { name: h.name, value: REDACTED } : h
  );
}

function redactCookies(list, options) {
  if (!options.redactHeaders) return list;
  return list.map((c) => ({ ...c, value: REDACTED }));
}

/** Replace values of known-sensitive query parameters in a URL. */
export function redactUrlTokens(url) {
  if (!url || (!url.includes('?') && !url.includes('#'))) return url;
  try {
    const u = new URL(url);
    let changed = false;
    const replace = (params) => {
      for (const key of [...params.keys()]) {
        if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
          params.set(key, REDACTED_TOKEN);
          changed = true;
        }
      }
    };
    replace(u.searchParams);
    // Tokens sometimes hide in the fragment (e.g. OAuth implicit flow).
    if (u.hash.length > 1) {
      const frag = new URLSearchParams(u.hash.slice(1));
      const before = frag.toString();
      replace(frag);
      if (frag.toString() !== before) u.hash = frag.toString();
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

function redactRedirect(url, options) {
  return options.redactQuery ? redactUrlTokens(url) : url;
}

/* --------------------------------------------------------------------------
 * Sizes
 * ------------------------------------------------------------------------ */

function postBodySize(request) {
  if (request.postData) return utf8ByteLength(request.postData);
  if (request.hasPostData) return -1;
  return 0;
}

function decodedBodySize(record) {
  if (record.body != null) {
    return record.base64Encoded ? base64ByteLength(record.body) : utf8ByteLength(record.body);
  }
  if (record.dataLength != null && record.dataLength >= 0) return record.dataLength;
  return -1;
}

function headersTextSize(headersText) {
  return typeof headersText === 'string' && headersText.length ? utf8ByteLength(headersText) : -1;
}

function utf8ByteLength(str) {
  return new TextEncoder().encode(String(str)).length;
}

function base64ByteLength(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/* --------------------------------------------------------------------------
 * Misc helpers
 * ------------------------------------------------------------------------ */

function normalizeProtocol(protocol) {
  if (!protocol) return 'HTTP/1.1';
  const p = String(protocol).toLowerCase();
  if (p === 'h2' || p === 'http/2' || p === 'http/2.0') return 'HTTP/2';
  if (p === 'h3' || p === 'http/3') return 'HTTP/3';
  if (p.startsWith('http/')) return protocol.toUpperCase();
  return protocol;
}

function firstNonNegative(values) {
  for (const v of values) {
    if (typeof v === 'number' && v >= 0) return v;
  }
  return -1;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round3(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (value < 0) return value;
  return Math.round(value * 1000) / 1000;
}

function toIso(epochSeconds) {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return null;
  const ms = epochSeconds * 1000;
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}
