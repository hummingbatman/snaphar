/**
 * cdp-collector.js — per-`requestId` accumulation of CDP `Network`/`Page` events.
 *
 * Pure logic (no `chrome.*`), so the service worker can feed it live events and
 * tests can replay a recorded event stream. The collector keeps just enough
 * state to emit the normalized records consumed by `har.js#buildHar`.
 *
 * Serialization note: the SW persists capture state to `chrome.storage.session`
 * across possible worker restarts, so the collector must round-trip through
 * `toJSON()` / `fromJSON()` without loss.
 */

export class CdpCollector {
  constructor(state) {
    /** @type {Map<string, object>} live + finished request records */
    this.requests = new Map();
    /** @type {object[]} closed-out redirect hops (same requestId, earlier response) */
    this.redirects = [];
    /** @type {object[]} */
    this.pages = [];
    /** monotonic<->wall anchor captured from the first request */
    this.timeAnchor = null; // { timestamp, wallTime }
    this.currentPageId = null;
    this.pageCounter = 0;

    if (state) this._restore(state);
  }

  /** Dispatch a single CDP event. `method` like "Network.requestWillBeSent". */
  addEvent(method, params) {
    switch (method) {
      case 'Network.requestWillBeSent':
        return this._onRequestWillBeSent(params);
      case 'Network.requestWillBeSentExtraInfo':
        return this._onRequestExtraInfo(params);
      case 'Network.responseReceived':
        return this._onResponseReceived(params);
      case 'Network.responseReceivedExtraInfo':
        return this._onResponseExtraInfo(params);
      case 'Network.dataReceived':
        return this._onDataReceived(params);
      case 'Network.loadingFinished':
        return this._onLoadingFinished(params);
      case 'Network.loadingFailed':
        return this._onLoadingFailed(params);
      case 'Page.frameNavigated':
        return this._onFrameNavigated(params);
      case 'Page.domContentEventFired':
        return this._onDomContentEventFired(params);
      case 'Page.loadEventFired':
        return this._onLoadEventFired(params);
      default:
        return undefined;
    }
  }

  /** Attach a fetched response body to a record. */
  setResponseBody(requestId, { body, base64Encoded }) {
    const record = this.requests.get(requestId);
    if (!record) return;
    record.body = body;
    record.base64Encoded = !!base64Encoded;
  }

  /** requestIds whose response finished but body hasn't been fetched yet. */
  pendingBodyRequestIds() {
    const ids = [];
    for (const [id, r] of this.requests) {
      if (r.finishedTimestamp != null && r.response && r.body == null && !r.failed) {
        ids.push(id);
      }
    }
    return ids;
  }

  /** Count of requests observed (for live popup status). */
  get requestCount() {
    return this.requests.size + this.redirects.length;
  }

  /** Produce the normalized shape for `har.js#buildHar`. */
  getCollected() {
    const entries = [...this.redirects, ...this.requests.values()];
    return {
      entries: entries.map((r) => this._normalize(r)),
      pages: this.pages.slice(),
    };
  }

  /* -------------------------------------------------------------- events */

  _onRequestWillBeSent(params) {
    const { requestId, request, timestamp, wallTime, redirectResponse } = params;
    this._anchorTime(timestamp, wallTime);

    // A redirect reuses the same requestId: close out the previous hop first.
    if (redirectResponse && this.requests.has(requestId)) {
      const prev = this.requests.get(requestId);
      prev.response = redirectResponse;
      prev.responseTimestamp = timestamp;
      prev.finishedTimestamp = timestamp;
      prev.encodedDataLength = redirectResponse.encodedDataLength;
      this.redirects.push(prev);
      this.requests.delete(requestId);
    }

    this.requests.set(requestId, {
      requestId,
      pageref: this.currentPageId,
      frameId: params.frameId,
      loaderId: params.loaderId,
      resourceType: params.type,
      initiator: params.initiator,
      request: {
        url: request.url + (request.urlFragment || ''),
        method: request.method,
        headers: request.headers || {},
        postData: request.postData,
        hasPostData: request.hasPostData,
      },
      wallTime,
      startTimestamp: timestamp,
      response: null,
      responseTimestamp: null,
      finishedTimestamp: null,
      extraRequestHeaders: null,
      extraResponseHeaders: null,
      dataLength: 0,
      encodedDataLength: null,
      serverIPAddress: null,
      connectionId: null,
      priority: request.initialPriority,
      fromCache: false,
      failed: false,
      errorText: null,
      body: null,
      base64Encoded: false,
    });
  }

  _onRequestExtraInfo(params) {
    const record = this.requests.get(params.requestId);
    if (record) record.extraRequestHeaders = params.headers || record.extraRequestHeaders;
  }

  _onResponseReceived(params) {
    const record = this.requests.get(params.requestId);
    if (!record) return;
    record.response = params.response;
    record.responseTimestamp = params.timestamp;
    record.resourceType = params.type || record.resourceType;
    record.serverIPAddress = params.response.remoteIPAddress || null;
    record.connectionId = params.response.connectionId ?? null;
    record.fromCache = !!params.response.fromDiskCache;
  }

  _onResponseExtraInfo(params) {
    const record = this.requests.get(params.requestId);
    if (record) record.extraResponseHeaders = params.headers || record.extraResponseHeaders;
  }

  _onDataReceived(params) {
    const record = this.requests.get(params.requestId);
    if (record) record.dataLength += params.dataLength || 0;
  }

  _onLoadingFinished(params) {
    const record = this.requests.get(params.requestId);
    if (!record) return;
    record.finishedTimestamp = params.timestamp;
    if (typeof params.encodedDataLength === 'number') {
      record.encodedDataLength = params.encodedDataLength;
    }
  }

  _onLoadingFailed(params) {
    const record = this.requests.get(params.requestId);
    if (!record) return;
    record.failed = true;
    record.errorText = params.errorText || params.blockedReason || 'failed';
    record.finishedTimestamp = params.timestamp;
  }

  _onFrameNavigated(params) {
    const frame = params.frame;
    if (!frame || frame.parentId) return; // top-level frame navigations only
    this.pageCounter += 1;
    const id = `page_${this.pageCounter}`;
    this.currentPageId = id;
    this.pages.push({
      id,
      url: frame.url,
      title: frame.url,
      startedDateTime: this._wallIso(null),
      onContentLoad: -1,
      onLoad: -1,
    });
  }

  _onDomContentEventFired(params) {
    const page = this._currentPage();
    if (page) page.onContentLoad = this._sincePageStartMs(page, params.timestamp);
  }

  _onLoadEventFired(params) {
    const page = this._currentPage();
    if (page) page.onLoad = this._sincePageStartMs(page, params.timestamp);
  }

  /* ------------------------------------------------------------- helpers */

  _anchorTime(timestamp, wallTime) {
    if (this.timeAnchor == null && typeof timestamp === 'number' && typeof wallTime === 'number') {
      this.timeAnchor = { timestamp, wallTime };
      // Backfill the first page's start time now that we can map the clock.
      for (const page of this.pages) {
        if (page.startedDateTime == null) page.startedDateTime = this._wallIso(null);
      }
    }
  }

  /** Map a monotonic CDP timestamp to wall-clock epoch seconds. */
  _wallTime(timestamp) {
    if (!this.timeAnchor) return null;
    if (timestamp == null) return this.timeAnchor.wallTime;
    return this.timeAnchor.wallTime + (timestamp - this.timeAnchor.timestamp);
  }

  _wallIso(timestamp) {
    const wall = this._wallTime(timestamp);
    if (wall == null) return null;
    try {
      return new Date(wall * 1000).toISOString();
    } catch {
      return null;
    }
  }

  _currentPage() {
    return this.pages.length ? this.pages[this.pages.length - 1] : null;
  }

  _sincePageStartMs(page, timestamp) {
    const start = Date.parse(page.startedDateTime);
    const wall = this._wallTime(timestamp);
    if (Number.isNaN(start) || wall == null) return -1;
    return Math.max(0, wall * 1000 - start);
  }

  _normalize(record) {
    // The record is already in the shape har.js expects; clone defensively so a
    // caller can't mutate internal state.
    return { ...record };
  }

  /* --------------------------------------------------------- persistence */

  toJSON() {
    return {
      requests: [...this.requests.entries()],
      redirects: this.redirects,
      pages: this.pages,
      timeAnchor: this.timeAnchor,
      currentPageId: this.currentPageId,
      pageCounter: this.pageCounter,
    };
  }

  _restore(state) {
    this.requests = new Map(state.requests || []);
    this.redirects = state.redirects || [];
    this.pages = state.pages || [];
    this.timeAnchor = state.timeAnchor || null;
    this.currentPageId = state.currentPageId || null;
    this.pageCounter = state.pageCounter || 0;
  }

  static fromJSON(state) {
    return new CdpCollector(state);
  }
}
