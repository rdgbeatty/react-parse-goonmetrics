import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore, reconcileHistoryRecord, compactHistorySummary, verifyHistory } from "../lib/history-store.mjs";
import { refreshHistory, historyTargets, attachHistory } from "../lib/history-refresh.mjs";
import { runJob, recentRuns } from "../lib/jobs.mjs";
import { createFixture } from "../lib/fixture.mjs";
import { readJson, writeJson, publishSnapshot } from "../lib/storage.mjs";
import { compareHubs } from "../../../packages/shared/src/marketSnapshot.mjs";

const DAY = 86400000, START = Date.parse("2026-11-07T15:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
function source(now, count = 30) {
  const end = Math.floor(now / DAY) * DAY - DAY;
  return Array.from({ length: count }, (_, index) => ({ date: iso(end - (count - index - 1) * DAY).slice(0, 10),
    volume: 10, order_count: 3, average: 20, highest: 30, lowest: 10 }));
}
function entry(now, body = source(now)) { return { body, expiresAt: now + 3600000, etag: 'W/"test"', sourceUpdatedAt: iso(now), notModified: false }; }
function live(count = 2) {
  const snapshot = createFixture(count, new Date(START)); snapshot.mode = "live";
  snapshot.hubs.forEach((hub, i) => { hub.regionId = String(10000002 + i); hub.locationId = String(60003760 + i); });
  return snapshot;
}
async function temp(t) { const path = await mkdtemp(join(tmpdir(), "market-history-test-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test("retention upserts corrections, verifies overlap and advances exactly 21 completed days", () => {
  const first = reconcileHistoryRecord("1", "34", null, source(START), { checkedAt: iso(START), sourceUpdatedAt: iso(START), expiresAt: iso(START + 3600000) });
  assert.equal(first.record.rows.length, 21); assert.equal(first.delta.insertedDays, 21);
  assert.equal(compactHistorySummary("1", "34", first.record).volume14d, 140);
  const next = source(START + DAY); next.at(-2).volume = 99;
  const second = reconcileHistoryRecord("1", "34", first.record, next, { checkedAt: iso(START + DAY), sourceUpdatedAt: iso(START + DAY), expiresAt: iso(START + DAY + 3600000) });
  assert.equal(second.record.rows.length, 21);
  assert.deepEqual(second.delta, { insertedDays: 1, correctedDays: 1, unchangedDays: 19, prunedDays: 1, verifiedDays: 20, sourceRows: 30 });
  const third = reconcileHistoryRecord("1", "34", second.record, null, { checkedAt: iso(START + DAY + 1), expiresAt: iso(START + 2 * DAY), notModified: true });
  assert.equal(third.delta.verifiedDays, 21); assert.deepEqual(third.record.rows, second.record.rows);
  assert.throws(() => reconcileHistoryRecord("1", "34", second.record, source(START), { checkedAt: iso(START + DAY), expiresAt: null }), /backwards/);
});

test("pre-update UTC midnight uses source coverage; missing dates stay unknown", () => {
  const now = Date.parse("2026-11-08T04:00:00Z");
  const body = source(START); body.splice(-3, 1);
  const { record } = reconcileHistoryRecord("1", "34", null, body, { checkedAt: iso(now), sourceUpdatedAt: iso(START), expiresAt: iso(now + DAY) });
  assert.equal(record.asOfDate, "2026-11-06");
  const summary = compactHistorySummary("1", "34", record);
  assert.equal(summary.volume7d, null); assert.equal(summary.missingDays7, 1);
  assert.equal(summary.lastRecordDate, "2026-11-06");
  const empty = reconcileHistoryRecord("1", "35", null, [], { checkedAt: iso(now), expiresAt: null });
  assert.equal(empty.record.asOfDate, null); assert.equal(compactHistorySummary("1", "35", empty.record).volume7d, null);
});

test("HTTP backfill resumes across fresh processes, honors expiry and 304 without storing full responses", async (t) => {
  const directory = await temp(t), snapshot = live(); let clock = START, calls = 0, conditional = 0;
  const fetchImpl = async (url, options) => {
    assert.match(url, /history\?type_id=/); assert.equal(options.headers.Authorization, undefined); calls++;
    if (options.headers["If-None-Match"]) conditional++;
    return new Response(options.headers["If-None-Match"] ? null : JSON.stringify(source(clock)), { status: options.headers["If-None-Match"] ? 304 : 200,
      headers: { Expires: new Date(clock + 3600000).toUTCString(), "Last-Modified": new Date(START).toUTCString(), ETag: 'W/"test"' } });
  };
  const options = { contact: "test@example.com", now: () => clock, fetchImpl, maxPairs: 3 };
  const first = await refreshHistory(snapshot, directory, options);
  assert.equal(first.refreshedPairs, 3); assert.equal(first.pendingPairs, 3); assert.equal(first.stopReason, "pair-budget");
  assert.deepEqual(historyTargets(snapshot).slice(0, 3).map((pair) => pair.regionId), snapshot.hubs.map((hub) => hub.regionId));
  const second = await refreshHistory(snapshot, directory, options);
  assert.equal(second.freshPairs, 3); assert.equal(second.refreshedPairs, 3); assert.equal(second.pendingPairs, 0);
  const third = await refreshHistory(snapshot, directory, options);
  assert.equal(third.requests, 0); assert.equal(third.freshPairs, 6); assert.equal(calls, 6);
  clock += 2 * 3600000;
  const fourth = await refreshHistory(snapshot, directory, { ...options, maxPairs: 0 });
  assert.equal(fourth.refreshedPairs, 6); assert.equal(fourth.verifiedDays, 126); assert.equal(conditional, 6);
  assert.equal(fourth.network.statuses[304], 6);
  assert.equal((await readdir(directory)).includes("cache"), false);
  const attached = await attachHistory(snapshot, directory);
  assert.equal(attached.hubs[2].rows[0].regionalWeekVolume, 70); assert.equal(attached.hubs[2].rows[0].regionalFortnightVolume, 140);
  assert.equal(attached.hubs[2].rows[0].history.retainedDays, 21);
});

test("time budgets, cancellation and source failures checkpoint successes and preserve prior summaries", async (t) => {
  const directory = await temp(t), snapshot = live(); let clock = START;
  const options = { contact: "test@example.com", now: () => clock, concurrency: 1, maxSeconds: 1,
    request: async () => { const value = entry(clock); clock += 2000; return value; } };
  const first = await refreshHistory(snapshot, directory, options);
  assert.equal(first.refreshedPairs, 1); assert.equal(first.stopReason, "time-budget"); assert.equal(first.pendingPairs, 5);
  const cancelled = new AbortController(); cancelled.abort();
  const second = await refreshHistory(snapshot, directory, { ...options, signal: cancelled.signal });
  assert.equal(second.attemptedPairs, 0); assert.equal(second.stopReason, "cancelled");
  clock += DAY;
  const failed = await refreshHistory(snapshot, directory, { ...options, maxSeconds: 0, request: async () => { throw Object.assign(new Error("limit"), { rateLimited: true, retryAfter: "600" }); } });
  assert.equal(failed.failedPairs, 1); assert.equal(failed.stopReason, "rate-limit");
  const saved = await attachHistory(snapshot, directory); assert.equal(saved.hubs[0].rows[0].regionalWeekVolume, 70);
  const retry = await refreshHistory(snapshot, directory, { ...options, maxSeconds: 0, maxPairs: 1, request: async () => entry(clock) });
  assert.equal(retry.deferredPairs, 1); assert.equal(retry.refreshedPairs, 1);
});

test("local verification detects corrupt shards and rebuilds derived summaries", async (t) => {
  const directory = await temp(t), snapshot = live(1);
  await refreshHistory(snapshot, directory, { contact: "test", now: () => START, request: async () => entry(START) });
  const summaryPath = join(directory, "history", "summaries", snapshot.hubs[0].regionId + ".json");
  await writeJson(summaryPath, { corrupted: true });
  await assert.rejects(verifyHistory(directory, snapshot.hubs.map((hub) => hub.regionId)), /integrity/);
  const result = await verifyHistory(directory, snapshot.hubs.map((hub) => hub.regionId), { repair: true });
  assert.ok(result.repaired > 0);
  assert.equal((await verifyHistory(directory, snapshot.hubs.map((hub) => hub.regionId))).mismatches, 0);
  const store = await new HistoryStore(directory).load([snapshot.hubs[0].regionId]);
  const path = store.path(snapshot.hubs[0].regionId, Number(snapshot.hubs[0].rows[0].typeId) % 32);
  const shard = await readJson(path); Object.values(shard.series)[0].rows[0][1]++;
  await writeJson(path, shard);
  await assert.rejects(verifyHistory(directory, [snapshot.hubs[0].regionId], { repair: true }), /integrity/);
});

test("shared job publishes quotes before history, keeps them after failure, and persists safe run metrics", async (t) => {
  const directory = await temp(t), snapshot = live(1), path = join(directory, "public", "data", "market.json");
  await publishSnapshot(path, createFixture(1));
  let sawQuotes = false;
  const result = await runJob("collect", directory, { contact: "test", refreshToken: "do-not-log-this" }, null, {
    collector: async () => snapshot, consoleImpl: { log() {} }, historyOptions: { now: () => START, request: async () => {
      sawQuotes = (await readJson(path)).mode === "live"; return entry(START);
    } },
  });
  assert.equal(sawQuotes, true); assert.equal(result.history.insertedDays, 63);
  const runs = await recentRuns(directory); assert.equal(runs[0].status, "complete");
  assert.equal(JSON.stringify(runs).includes("do-not-log-this"), false); assert.ok(runs[0].cpuUserMs >= 0);
  const failure = await runJob("collect", directory, { contact: "test" }, null, { collector: async () => snapshot, consoleImpl: { log() {} }, historyOptions: { maxSeconds: -1 } });
  assert.equal(failure.status, "partial"); assert.equal((await readJson(path)).mode, "live");
});

test("weekly opportunity columns match legacy economics and fourteen-day mode stays weekly", () => {
  const snapshot = live(1);
  for (const hub of snapshot.hubs) Object.assign(hub.rows[0], { sell: hub.id === "jita" ? 100 : 200, buy: 150, volumeM3: .01, regionalWeekVolume: 70, regionalFortnightVolume: 280 });
  const row = compareHubs(snapshot, "jita", "cj6mt")[0];
  assert.equal(row.landed, 107); assert.equal(row.profit, 200 * .9463 - 107);
  assert.equal(row.grossWeekProfit, 7000); assert.equal(row.estimatedWeekProfit, row.profit * 70);
  assert.equal(row.pricePerM3, 10000); assert.equal(row.fillerScore, 55);
  const fortnight = compareHubs(snapshot, "jita", "cj6mt", { windowDays: 14 })[0];
  assert.equal(fortnight.regionalWeekVolume, 140); assert.equal(fortnight.estimatedWeekProfit, row.estimatedWeekProfit * 2);
  snapshot.hubs[2].rows[0].regionalWeekVolume = null;
  const unknown = compareHubs(snapshot, "jita", "cj6mt")[0]; assert.equal(unknown.estimatedWeekProfit, null); assert.equal(unknown.fillerScore, null);
});

test("legacy public history cache migrates once without re-requesting a fresh response", async (t) => {
  const { createHash } = await import("node:crypto");
  const directory = await temp(t), snapshot = live(1), pair = historyTargets(snapshot)[0];
  const name = createHash("sha256").update(`public:2026-11-05:/markets/${pair.regionId}/history?type_id=${pair.typeId}`).digest("hex") + ".json";
  await writeJson(join(directory, "cache", name), { body: source(START), expiresAt: START + DAY, observedAt: iso(START), etag: '"legacy"' });
  const result = await refreshHistory(snapshot, directory, { contact: "test", now: () => START, request: async ({ regionId }) => {
    assert.notEqual(regionId, pair.regionId); return entry(START);
  } });
  assert.equal(result.legacySeededPairs, 1); assert.equal(result.freshPairs, 1); assert.equal(result.refreshedPairs, 2);
  assert.equal((await readdir(join(directory, "cache"))).includes(name), false);
  assert.equal((await attachHistory(snapshot, directory)).hubs[0].rows[0].regionalWeekVolume, 70);
});

test("compact JSON checkpoints recover interrupted batches and compaction without rolling updates backwards", async (t) => {
  const directory = await temp(t), store = await new HistoryStore(directory).load(["1", "2"]);
  const first = reconcileHistoryRecord("1", "34", null, source(START), { checkedAt: iso(START), expiresAt: iso(START + DAY) }).record;
  store.set("1", "34", first); store.set("2", "35", first); await store.checkpoint();
  const second = reconcileHistoryRecord("1", "34", first, source(START + DAY), { checkedAt: iso(START + DAY), expiresAt: iso(START + 2 * DAY) }).record;
  store.set("1", "34", second); await store.checkpoint();
  const checkpoints = await readdir(join(directory, "history", "checkpoints"));
  assert.equal(checkpoints.length, 2);
  const recovered = await new HistoryStore(directory).load(["1"]);
  assert.equal(recovered.get("1", "34").asOfDate, second.asOfDate);
  assert.equal(recovered.get("2", "35").asOfDate, first.asOfDate); // Journal regions outside caller scope also survive.
  const patches = await Promise.all(checkpoints.map((name) => readJson(join(directory, "history", "checkpoints", name))));
  await recovered.compact();
  assert.equal((await readdir(join(directory, "history", "checkpoints"))).length, 0);
  // Simulate a process dying while folding patches into shards: a shard is missing,
  // and both checkpoints still exist. Replay supplies it and preserves the latest edit.
  await rm(recovered.path("2", 35 % 32));
  for (let i = 0; i < checkpoints.length; i++) await writeJson(join(directory, "history", "checkpoints", checkpoints[i]), patches[i]);
  const interrupted = await new HistoryStore(directory).load(["1"]);
  assert.equal(interrupted.get("1", "34").asOfDate, second.asOfDate);
  assert.equal(interrupted.get("2", "35").asOfDate, first.asOfDate);
  await interrupted.compact();
  // A leftover suffix after oldest-first cleanup also cannot roll a newer shard back.
  await writeJson(join(directory, "history", "checkpoints", checkpoints[1]), patches[1]);
  assert.equal((await new HistoryStore(directory).load(["1"])).get("1", "34").asOfDate, second.asOfDate);
  patches[1].changes[0][2].rows[0][1]++;
  await writeJson(join(directory, "history", "checkpoints", checkpoints[1]), patches[1]);
  await assert.rejects(new HistoryStore(directory).load(["1"]), /checkpoint integrity/);
});

test("price-only jobs use prepared summaries and never start a history request", async (t) => {
  const directory = await temp(t), snapshot = live(1); let historyCalls = 0;
  const report = await runJob("quotes", directory, {}, null, { collector: async () => snapshot, consoleImpl: { log() {} },
    historyOptions: { request: async () => { historyCalls++; throw new Error("History must not run."); } } });
  assert.equal(historyCalls, 0); assert.equal(report.history, undefined); assert.equal(report.status, "complete");
  assert.equal((await readJson(join(directory, "public", "data", "market.json"))).mode, "live");
});
