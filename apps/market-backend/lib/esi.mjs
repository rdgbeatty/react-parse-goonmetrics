import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "./storage.mjs";
import { createRequestLimiter, mapConcurrent } from "./concurrency.mjs";
import { aggregateOrders, validateBookSummary } from "../../../packages/shared/src/marketQuotes.mjs";
import { performance } from "node:perf_hooks";

export class EsiClient {
  constructor({ cacheDirectory, accessToken, characterId, userAgent, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), requestConcurrency = 3, pageConcurrency = 2, stopOnError = true, signal, deadlineMs = Infinity, maxRequests = Infinity }) {
    Object.assign(this, { cacheDirectory, accessToken, characterId, userAgent, now, sleep });
    this.fetch = fetchImpl;
    this.limiter = createRequestLimiter(requestConcurrency);
    this.pageConcurrency = pageConcurrency;
    this.memoryCache = new Map();
    Object.assign(this, { stopOnError, signal, deadlineMs, maxRequests });
    this.statistics = { requests: 0, cacheHits: 0 };
    this.metrics = { responseBytes: 0, requestWallMs: 0, maxRequestMs: 0, retries: 0, statuses: {} };
  }

  async get(path, { authenticated = false, cache = "disk", conditional = null, allowNotModified = false } = {}) {
    if (/^\/markets\/(?:\d+\/orders|structures\/\d+)\/?(?:\?|$)/.test(path)) cache = "memory";
    const identity = authenticated ? this.characterId : "public";
    const cacheKey = createHash("sha256").update(`${identity}:2026-11-05:${path}`).digest("hex");
    const cachePath = join(this.cacheDirectory, `${cacheKey}.json`);
    const cached = cache === "none" ? null : cache === "memory" ? this.memoryCache.get(cacheKey) : await readJson(cachePath);
    if (cached?.expiresAt > this.now()) { this.statistics.cacheHits++; return cached; }
    const headers = { "X-Compatibility-Date": "2026-11-05", "User-Agent": this.userAgent, Accept: "application/json" };
    if (authenticated) headers.Authorization = `Bearer ${this.accessToken}`;
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    else if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
    else if (conditional?.sourceUpdatedAt) headers["If-Modified-Since"] = new Date(conditional.sourceUpdatedAt).toUTCString();
    return this.limiter.run(async () => {
      try {
        const entry = await this.request(path, headers, cached, cache === "disk" ? cachePath : null, { conditional, allowNotModified });
        if (cache === "memory") this.memoryCache.set(cacheKey, entry);
        return entry;
      }
      catch (error) { if ((typeof this.stopOnError === "function" ? this.stopOnError(error) : this.stopOnError) || error.rateLimited || error.budgetExceeded || error.cancelled) this.limiter.stop(error); throw error; }
    });
  }

  async request(path, headers, cached, cachePath, { conditional, allowNotModified } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.signal?.aborted) throw Object.assign(new Error("Collection cancelled; completed history is retained."), { cancelled: true });
      if (this.now() >= this.deadlineMs) throw Object.assign(new Error("History batch time budget reached."), { budgetExceeded: true });
      if (this.statistics.requests >= this.maxRequests) throw Object.assign(new Error("History request budget reached."), { budgetExceeded: true, requestBudgetExceeded: true });
      this.statistics.requests++;
      const started = performance.now();
      let recorded = false;
      const recordTime = () => { if (recorded) return; recorded = true; const elapsed = performance.now() - started; this.metrics.requestWallMs += elapsed; this.metrics.maxRequestMs = Math.max(this.metrics.maxRequestMs, elapsed); };
      let response;
      const controller = new AbortController(), abort = () => controller.abort();
      const timeout = setTimeout(abort, Math.max(1, Math.min(25_000, this.deadlineMs - this.now())));
      this.signal?.addEventListener("abort", abort, { once: true });
      try { response = await this.fetch(`https://esi.evetech.net${path}`, { headers, signal: controller.signal }); }
      catch {
        recordTime(); clearTimeout(timeout); this.signal?.removeEventListener("abort", abort);
        if (this.signal?.aborted) throw Object.assign(new Error("Collection cancelled; completed history is retained."), { cancelled: true });
        if (this.now() >= this.deadlineMs) throw Object.assign(new Error("History batch time budget reached."), { budgetExceeded: true });
        if (attempt === 2) throw new Error("ESI network request timed out or failed. The previous snapshot is retained.");
        this.metrics.retries++;
        await this.sleep(500 * 2 ** attempt); continue;
      }
      this.metrics.statuses[response.status] = (this.metrics.statuses[response.status] ?? 0) + 1;
      try {
      const reset = response.headers.get("Retry-After") ?? response.headers.get("X-Esi-Error-Limit-Reset");
      const errorRemaining = response.headers.get("X-Esi-Error-Limit-Remain"), tokenRemaining = response.headers.get("X-Ratelimit-Remaining");
      const budgetLow = errorRemaining !== null && Number(errorRemaining) <= 5 || tokenRemaining !== null && Number(tokenRemaining) <= 2;
      // Inspect budgets on errors as well as successes. A 404 is local to a pair,
      // but continuing through many 404s must still respect the shared error limit.
      if (budgetLow) throw Object.assign(new Error("ESI request/error budget is low. Collection paused until reset."),
        { rateLimited: true, status: response.status, retryAfter: reset });
      if ([420, 429].includes(response.status)) {
        throw Object.assign(new Error(`ESI rate/error limit reached (${response.status}). Retry after the source limit resets.`),
          { rateLimited: true, status: response.status, retryAfter: response.headers.get("Retry-After") });
      }
      if (response.status >= 500 && attempt < 2) { recordTime(); this.metrics.retries++; await response.body?.cancel(); await this.sleep(500 * 2 ** attempt); continue; }
      if (response.status === 403) throw Object.assign(new Error("ESI denied structure access (403). Check the structure ID and this character's access."), { status: 403 });
      if (response.status === 401) throw Object.assign(new Error("ESI rejected the character token (401). Reconnect EVE and retry."), { status: 401 });
      if (response.status === 404) {
        let notFoundScope = "resource";
        try { const errorBody = await response.json(); if (errorBody?.error === "Type not found!") notFoundScope = "type"; } catch { /* A gateway/route 404 is not an unavailable item. */ }
        throw Object.assign(new Error("ESI history/resource not found (404)."), { status: 404, notFoundScope });
      }
      if (response.status !== 304 && !response.ok) throw Object.assign(new Error(`ESI request failed (${response.status}) for ${new URL(`https://esi.evetech.net${path}`).pathname}.`), { status: response.status });
      if (response.status === 304 && !cached && !allowNotModified) throw new Error("ESI returned 304 without a local cached body.");
      const expires = Date.parse(response.headers.get("Expires") ?? "");
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get("Cache-Control") ?? "");
      const age = Math.max(0, Number(response.headers.get("Age")) || 0);
      const expiresAt = Number.isFinite(expires) ? expires : maxAge ? this.now() + Math.max(0, Number(maxAge[1]) - age) * 1000 : this.now();
      const receivedAt = this.now();
      const modifiedAt = Date.parse(response.headers.get("Last-Modified") ?? "");
      const serverDate = Date.parse(response.headers.get("Date") ?? "");
      // A new download can still be an older ESI-cached book. A 304 keeps its data age.
      const observedAt = Number.isFinite(modifiedAt) ? new Date(Math.min(receivedAt, modifiedAt)).toISOString() :
        response.status === 304 ? cached?.observedAt ?? conditional?.sourceUpdatedAt ?? new Date(receivedAt).toISOString() :
        new Date(Math.min(receivedAt, Number.isFinite(serverDate) ? serverDate : receivedAt, receivedAt - age * 1000)).toISOString();
      let body = cached?.body ?? null;
      if (response.status !== 304) { const text = await response.text(); this.metrics.responseBytes += Buffer.byteLength(text); body = JSON.parse(text); }
      const entry = { body,
        etag: response.headers.get("ETag") ?? cached?.etag ?? conditional?.etag ?? null, expiresAt,
        pages: Number(response.headers.get("X-Pages") ?? cached?.pages ?? 1),
        observedAt, sourceUpdatedAt: Number.isFinite(modifiedAt) ? new Date(modifiedAt).toISOString() : conditional?.sourceUpdatedAt ?? null,
        notModified: response.status === 304 };
      if (!Number.isSafeInteger(entry.pages) || entry.pages < 1 || entry.pages > 1000) throw new Error("Invalid ESI page count.");
      if (cachePath) await writeJson(cachePath, entry);
      if (response.status === 304) this.statistics.cacheHits++;
      return entry;
      } finally { recordTime(); clearTimeout(timeout); this.signal?.removeEventListener("abort", abort); }
    }
  }

  async orders(path, authenticated = false, onProgress = () => {}) {
    const pagePath = (page) => `${path}${path.includes("?") ? "&" : "?"}page=${page}`;
    onProgress({ completed: 0, total: null, page: 1, ordersReceived: 0 });
    const first = await this.get(pagePath(1), { authenticated, cache: "memory" });
    const entries = [first];
    let ordersReceived = Array.isArray(first.body) ? first.body.length : 0;
    let completed = 1;
    onProgress({ completed: 1, total: first.pages, page: 1, ordersReceived });
    const rest = await mapConcurrent(Array.from({ length: first.pages - 1 }, (_, index) => index + 2), this.pageConcurrency, async (page) => {
      onProgress({ completed, total: first.pages, page, ordersReceived });
      const entry = await this.get(pagePath(page), { authenticated, cache: "memory" });
      if (entry.pages !== first.pages) throw new Error("ESI page count changed during collection. Retry after cache expiry.");
      ordersReceived += Array.isArray(entry.body) ? entry.body.length : 0;
      onProgress({ completed: ++completed, total: first.pages, page, ordersReceived });
      return entry;
    });
    entries.push(...rest);
    const unique = new Map();
    for (const entry of entries) {
      if (!Array.isArray(entry.body)) throw new Error("ESI order page is not an array.");
      for (const order of entry.body) {
        if (![order.order_id, order.type_id, order.location_id, order.volume_remain].every((value) => Number.isSafeInteger(value) && value >= 0) ||
          typeof order.is_buy_order !== "boolean" || !Number.isFinite(order.price) || order.price <= 0) throw new Error("Invalid ESI order fields or unsafe integer ID.");
        unique.set(String(order.order_id), order);
      }
    }
    return { orders: [...unique.values()], observedAt: entries.map((entry) => entry.observedAt).sort()[0],
      expiresAt: Math.min(...entries.map((entry) => entry.expiresAt)), pageCount: first.pages };
  }

  async bookSummary(path, authenticated = false, onProgress = () => {}, locationId) {
    const identity = authenticated ? this.characterId : "public";
    const key = createHash("sha256").update(`book-v1:${identity}:2026-11-05:${path}:${locationId}`).digest("hex");
    const cachePath = join(this.cacheDirectory, "books", `${key}.json`), cached = await readJson(cachePath);
    if (cached && cached.expiresAt > this.now()) {
      validateBookSummary(cached); this.statistics.cacheHits++;
      onProgress({ completed: cached.pageCount, total: cached.pageCount, page: cached.pageCount, ordersReceived: cached.orderCount });
      return cached;
    }
    const book = await this.orders(path, authenticated, onProgress);
    const orders = book.orders.filter((order) => String(order.location_id) === locationId);
    const competitionAsOf = new Date(this.now()).toISOString();
    const summary = validateBookSummary({ schemaVersion: 1, observedAt: book.observedAt, expiresAt: book.expiresAt,
      competitionAsOf, competitionWindowHours: 24, pageCount: book.pageCount, orderCount: book.orders.length,
      quotes: aggregateOrders(orders, competitionAsOf) });
    await writeJson(cachePath, summary);
    return summary;
  }
}
