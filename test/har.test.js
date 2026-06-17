import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CdpCollector } from '../src/cdp-collector.js';
import { buildHar, computeTimings } from '../src/har.js';
import { harToDataUrl, base64FromBytes, formatFilename } from '../src/download.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/sample-events.json', import.meta.url)), 'utf8')
);

function collectFixture() {
  const collector = new CdpCollector();
  for (const { method, params } of fixture.events) collector.addEvent(method, params);
  for (const [requestId, body] of Object.entries(fixture.bodies || {})) {
    collector.setResponseBody(requestId, body);
  }
  return collector;
}

function buildFromFixture(options) {
  return buildHar(collectFixture().getCollected(), options).log;
}

const findEntry = (log, url) => log.entries.find((e) => e.request.url === url);

test('produces a HAR 1.2 log with SnapHAR creator', () => {
  const log = buildFromFixture();
  assert.equal(log.version, '1.2');
  assert.equal(log.creator.name, 'SnapHAR');
  assert.ok(Array.isArray(log.entries));
});

test('captures one page from the top-level navigation', () => {
  const log = buildFromFixture();
  assert.equal(log.pages.length, 1);
  assert.equal(log.pages[0].id, 'page_1');
  assert.equal(log.pages[0].title, 'https://example.com/');
  // dom/load event timings were recorded relative to page start.
  assert.ok(log.pages[0].pageTimings.onLoad >= 0);
});

test('emits an entry per request, including each redirect hop', () => {
  const log = buildFromFixture();
  assert.equal(log.entries.length, 3);
  const urls = log.entries.map((e) => e.request.url);
  assert.deepEqual(urls, [
    'https://example.com/',
    'https://example.com/old',
    'https://example.com/new',
  ]);
});

test('entries are chronologically ordered by startedDateTime', () => {
  const log = buildFromFixture();
  const times = log.entries.map((e) => Date.parse(e.startedDateTime));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('request: method, cookies, queryString and headers', () => {
  const log = buildFromFixture();
  const req = findEntry(log, 'https://example.com/').request;
  assert.equal(req.method, 'GET');
  assert.deepEqual(req.cookies, [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
  ]);
  assert.deepEqual(req.queryString, []);
  assert.ok(req.headers.some((h) => h.name === 'Host' && h.value === 'example.com'));
});

test('response: status, content body, size, and parsed Set-Cookie', () => {
  const log = buildFromFixture();
  const res = findEntry(log, 'https://example.com/').response;
  assert.equal(res.status, 200);
  assert.equal(res.httpVersion, 'HTTP/2');
  assert.equal(res.content.mimeType, 'text/html');
  assert.equal(res.content.text, '<!doctype html><title>Example</title>');
  assert.equal(res.content.size, 37);
  assert.equal(res.bodySize, 800);
  assert.deepEqual(res.cookies, [
    { name: 'sid', value: 'xyz', path: '/', httpOnly: true, secure: true },
  ]);
  assert.equal(res.redirectURL, '');
});

test('startedDateTime derives from CDP wallTime', () => {
  const log = buildFromFixture();
  const entry = findEntry(log, 'https://example.com/');
  assert.equal(entry.startedDateTime, new Date(1700000000000).toISOString());
});

test('timings derive correctly from CDP timing offsets', () => {
  const log = buildFromFixture();
  const entry = findEntry(log, 'https://example.com/');
  assert.deepEqual(entry.timings, {
    blocked: 0.5,
    dns: 1.5,
    connect: 8,
    ssl: 5.5,
    send: 0.5,
    wait: 39,
    receive: 30,
  });
  // total time = sum of non-negative phases (ssl excluded).
  assert.equal(entry.time, 79.5);
});

test('redirect hop becomes its own entry with redirectURL', () => {
  const log = buildFromFixture();
  const hop = findEntry(log, 'https://example.com/old');
  assert.equal(hop.response.status, 301);
  assert.equal(hop.response.redirectURL, 'https://example.com/new');
});

test('entry without DNS/connect phases reports -1 and excludes them from time', () => {
  const log = buildFromFixture();
  const entry = findEntry(log, 'https://example.com/new');
  assert.equal(entry.timings.dns, -1);
  assert.equal(entry.timings.connect, -1);
  assert.equal(entry.timings.blocked, 0.2);
  assert.equal(entry.time, 50);
});

test('redactHeaders option masks Authorization/Cookie/Set-Cookie and cookie values', () => {
  const log = buildFromFixture({ redactHeaders: true });
  const entry = findEntry(log, 'https://example.com/');
  const cookieHeader = entry.request.headers.find((h) => h.name === 'Cookie');
  assert.match(cookieHeader.value, /redacted/);
  const setCookie = entry.response.headers.find((h) => h.name === 'Set-Cookie');
  assert.match(setCookie.value, /redacted/);
  assert.match(entry.request.cookies[0].value, /redacted/);
});

test('redactBodies option strips response body text', () => {
  const log = buildFromFixture({ redactBodies: true });
  const entry = findEntry(log, 'https://example.com/');
  assert.match(entry.response.content.text, /redacted/);
});

test('computeTimings falls back to a valid stub without timing data', () => {
  const t = computeTimings({ request: {}, response: null, startTimestamp: 1, finishedTimestamp: 1.02 });
  assert.equal(t.blocked, -1);
  assert.equal(t.dns, -1);
  assert.equal(t.wait, 20); // 0.02s wall delta
});

test('collector survives a toJSON/fromJSON round-trip', () => {
  const collector = collectFixture();
  const restored = CdpCollector.fromJSON(JSON.parse(JSON.stringify(collector.toJSON())));
  assert.equal(restored.requestCount, collector.requestCount);
  // Compare the HAR each produces — JSON drops `undefined`-valued keys, so the
  // raw record objects differ only cosmetically after a round-trip.
  assert.deepEqual(buildHar(restored.getCollected()), buildHar(collector.getCollected()));
});

test('harToDataUrl / base64FromBytes match Node Buffer base64', () => {
  const bytes = new TextEncoder().encode('SnapHAR ☃ 你好');
  assert.equal(base64FromBytes(bytes), Buffer.from(bytes).toString('base64'));

  const json = JSON.stringify({ hello: 'wörld' });
  const url = harToDataUrl(json);
  assert.ok(url.startsWith('data:application/json;base64,'));
  const decoded = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
  assert.equal(decoded, json);
});

test('formatFilename expands tokens and enforces a .har suffix', () => {
  const name = formatFilename('snaphar_{host}_{datetime}', {
    host: 'https://example.com',
    date: new Date('2026-06-17T09:08:07'),
  });
  assert.match(name, /^snaphar_example\.com_2026-06-17_090807\.har$/);

  assert.match(formatFilename('plain', {}), /^plain\.har$/);
  assert.match(formatFilename('has/bad:chars', {}), /^has_bad_chars\.har$/);
});
