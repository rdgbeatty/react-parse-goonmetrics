import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeDailyHistory, summarizeHistory } from "../../../packages/shared/src/marketHistory.mjs";
import { mapConcurrent } from "../lib/concurrency.mjs";
import { EsiClient } from "../lib/esi.mjs";

const now = new Date("2026-11-07T15:00:00Z");
const options = { regionId: "10000002", typeId: "34", asOfDate: "2026-11-06", checkedAt: now.toISOString() };
const day = (date, volume = 10) => ({ date, volume, order_count: 2, average: 5, highest: 6, lowest: 4 });

test("21 calendar days preserve seven/fourteen-day volume and full daily price/order records", () => {
  const response = Array.from({ length: 30 }, (_, index) => day(new Date(Date.UTC(2026, 10, 6 - index)).toISOString().slice(0, 10)));
  const series = mergeDailyHistory(null, response, options);
  assert.equal(Object.keys(series.days).length, 21);
  assert.deepEqual(series.days["2026-11-06"], { volume: 10, orderCount: 2, average: 5, highest: 6, lowest: 4 });
  assert.equal(summarizeHistory(series, undefined, now.getTime()).volume, 70);
  assert.equal(summarizeHistory(series, 14, now.getTime()).volume, 140);
  assert.equal(summarizeHistory(series, 14, now.getTime()).weeklyEquivalentVolume, 70);
  const corrected = mergeDailyHistory(series, [day("2026-11-03", 30), day("2026-11-06", 15)], options);
  assert.equal(summarizeHistory(corrected, 7, now.getTime()).volume, 95);
  assert.equal(series.days["2026-11-03"].volume, 10);
  const tomorrow = mergeDailyHistory(corrected, [day("2026-11-07", 20)], { ...options, asOfDate: "2026-11-07", checkedAt: "2026-11-08T15:00:00Z" });
  assert.equal(Object.keys(tomorrow.days).length, 21);
  assert.equal(tomorrow.days["2026-10-17"], undefined);
});

test("history staleness, coverage and missing dates are data, without a UI warning policy", () => {
  const series = mergeDailyHistory(null, [day("2026-11-06")], options);
  const summary = summarizeHistory(series, 7, now.getTime() + 3 * 86_400_000);
  assert.equal(summary.volume, null); assert.equal(summary.missingDates.length, 6);
  assert.equal(summary.coverageLagDays, 3); assert.equal(summary.checkAgeMs, 3 * 86_400_000);
  assert.equal(Object.hasOwn(summary, "warning"), false);
  assert.throws(() => mergeDailyHistory(series, [], { ...options, typeId: "35" }), /identity/);
  assert.throws(() => mergeDailyHistory(series, [day("2026-11-06"), day("2026-11-06")], options), /Duplicate/);
  assert.throws(() => mergeDailyHistory(series, [], { ...options, asOfDate: "2026-11-05" }), /backwards/);
});

test("bounded workers retain input order and drain in-flight work before reporting failure", async () => {
  let active = 0, maximum = 0, started = 0;
  const output = await mapConcurrent([4, 3, 2, 1], 2, async (value) => {
    active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, value)); active--; return value * 2;
  });
  assert.deepEqual(output, [8, 6, 4, 2]); assert.equal(maximum, 2);
  await assert.rejects(mapConcurrent([0, 1, 2, 3], 2, async (value) => {
    started++; if (value === 0) throw new Error("stop");
    active++; await new Promise((resolve) => setTimeout(resolve, 5)); active--;
  }), /stop/);
  assert.equal(started, 2); assert.equal(active, 0);
});

test("three parallel books respect the global request cap and two-page per-book cap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "market-concurrency-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let active = 0, maximum = 0;
  const byHub = new Map(), perHubMax = new Map(), progress = new Map();
  const client = new EsiClient({ cacheDirectory: directory, requestConcurrency: 3, pageConcurrency: 2, userAgent: "test", fetchImpl: async (url) => {
    const { pathname, searchParams } = new URL(url), page = Number(searchParams.get("page"));
    active++; maximum = Math.max(maximum, active);
    byHub.set(pathname, (byHub.get(pathname) ?? 0) + 1); perHubMax.set(pathname, Math.max(perHubMax.get(pathname) ?? 0, byHub.get(pathname)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--; byHub.set(pathname, byHub.get(pathname) - 1);
    return new Response(JSON.stringify([{ order_id: page, type_id: 34, location_id: 60003760, volume_remain: 1, is_buy_order: false, price: 5 }]), { headers: { "X-Pages": "5" } });
  } });
  const books = await Promise.all(["jita", "tortuga", "cj"].map((hub) => client.orders(`/book/${hub}`, false, (value) => progress.set(hub, value))));
  assert.equal(maximum, 3); assert.ok([...perHubMax.values()].every((value) => value <= 2));
  assert.ok(books.every((book) => book.orders.length === 5));
  assert.ok([...progress.values()].every((value) => value.completed === 5 && value.total === 5));
});

test("a fatal ESI response stops queued network work and settles active requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "market-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let started = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = new EsiClient({ cacheDirectory: directory, requestConcurrency: 2, userAgent: "test", fetchImpl: async () => {
    const ordinal = ++started;
    if (started === 2) release();
    await gate;
    if (ordinal === 1) return new Response(null, { status: 403 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response("[]");
  } });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => client.get(`/request/${index}`)));
  assert.equal(started, 2);
  assert.equal(results.filter((result) => result.status === "rejected").length, 5);
  assert.equal(client.statistics.requests, 2);
});
