import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixture } from "../lib/fixture.mjs";
import { refreshHistory } from "../lib/history-refresh.mjs";
import { historyDiagnostics } from "../lib/history-diagnostics.mjs";
import { runHistorySession } from "../lib/history-session.mjs";
import { readJson, publishSnapshot, writeJson } from "../lib/storage.mjs";
import { recentRuns } from "../lib/jobs.mjs";
const DAY = 86400000, NOW = Date.parse("2026-11-09T06:00:00Z");
const iso = (time) => new Date(time).toISOString();
async function temp(t) { const directory = await mkdtemp(join(tmpdir(), "history-batches-")); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
function live(count = 2) { const snapshot = createFixture(count, new Date(NOW)); snapshot.mode = "live";
  snapshot.hubs.forEach((hub, i) => { hub.regionId = String(10000002 + i); hub.locationId = String(60000000 + i); }); return snapshot; }
const entry = (now) => ({ body: Array.from({ length: 21 }, (_, i) => ({ date: iso(Math.floor(now / DAY) * DAY - (i + 1) * DAY).slice(0, 10), volume: 10, order_count: 1, average: 10, highest: 10, lowest: 10 })),
  expiresAt: now + DAY, sourceUpdatedAt: iso(now), etag: '"test"' });
const silent = { log() {} };

test("three regional 404s for one type do not prevent later types from collecting", async (t) => {
  const directory = await temp(t), snapshot = live(); let now = NOW, requests = 0;
  const failingId = snapshot.hubs[0].rows[0].typeId;
  const fetchImpl = async (url) => {
    requests++;
    if (new URL(url).searchParams.get('type_id') === failingId) return new Response(JSON.stringify({error:'Type not found!'}), {status:404});
    return new Response(JSON.stringify(entry(now).body), {headers:{Expires:new Date(now + DAY).toUTCString(), 'Last-Modified':new Date(now).toUTCString()}});
  };
  const options = { contact: "test", now: () => now, fetchImpl };
  const first = await refreshHistory(snapshot, directory, options);
  assert.equal(first.refreshedPairs, 3); assert.equal(first.failedPairs, 3); assert.equal(first.stopReason, "complete");
  assert.equal(first.remainingEligiblePairs, 0); assert.equal(first.deferredPairsNow, 3); assert.equal(first.failures[0].category, "not-found");
  const diagnostics = await historyDiagnostics(directory, snapshot, now);
  assert.equal(diagnostics.deferred.length, 3); assert.equal(diagnostics.collectedPairs, 3);
  assert.equal(diagnostics.deferred[0].retryAt, iso(now + DAY)); assert.equal(diagnostics.deferred[0].failureCount, 1);
  now += 12 * 3600000;
  const second = await refreshHistory(snapshot, directory, options);
  assert.equal(second.attemptedPairs, 0); assert.equal(requests, 6);
  assert.equal((await historyDiagnostics(directory, snapshot, now)).deferred[0].deferredAgeMs, 12 * 3600000);
  now = NOW + DAY + 1;
  await refreshHistory(snapshot, directory, options);
  const after = await historyDiagnostics(directory, snapshot, now);
  assert.equal(after.deferred[0].deferredSince, iso(NOW)); assert.equal(after.deferred[0].failureCount, 2);
  assert.equal(after.deferred[0].retryAt, iso(now + DAY));
});

test("historical logs recover the first failure age for preexisting invalid-data labels", async (t) => {
  const directory = await temp(t), snapshot = live(1), typeId = snapshot.hubs[0].rows[0].typeId;
  const old = NOW - DAY;
  await writeJson(join(directory, "metrics", "runs", "1794116573004-11111111.json"), { startedAt: iso(old), finishedAt: iso(old + 1000), history: { failures: [{ regionId: snapshot.hubs[0].regionId, typeId, status: 404, category: "invalid-data" }] } });
  await refreshHistory(snapshot, directory, { contact: "test", now: () => NOW, request: async ({ regionId }) => {
    if (regionId === snapshot.hubs[0].regionId) throw Object.assign(new Error("not found"), { status: 404 }); return entry(NOW);
  } });
  const deferred = (await historyDiagnostics(directory, snapshot, NOW)).deferred[0];
  assert.equal(deferred.deferredSince, iso(old + 1000)); assert.equal(deferred.failureCount, 2);
});

test("automatic pass runs bounded batches, persists pause state and resumes without duplicate work", async (t) => {
  const directory = await temp(t), snapshot = live(3); await publishSnapshot(join(directory, "public", "data", "market.json"), snapshot);
  const calls = [], options = { consoleImpl: silent, historyOptions: { maxPairs: 3, now: () => NOW,
    request: async ({ regionId, typeId }) => { calls.push(`${regionId}:${typeId}`); return entry(NOW); } } };
  const first = await runHistorySession("history", directory, { contact: "test" }, null, { ...options, shouldPause: () => true });
  assert.equal(first.session.status, "paused"); assert.equal(first.session.batchesCompleted, 1); assert.equal(calls.length, 3);
  const resumed = await runHistorySession("history", directory, { contact: "test" }, null, { ...options, resume: true });
  assert.equal(resumed.session.id, first.session.id); assert.equal(resumed.session.status, "complete"); assert.equal(resumed.session.batchesCompleted, 3);
  assert.equal(calls.length, 9); assert.equal(new Set(calls).size, 9);
  const runs = await recentRuns(directory); assert.equal(runs.length, 3); assert.ok(runs.every((run) => run.history.attemptedPairs <= 3));
});

test("default batches cap at 1000 pairs and automatic collection completes the remainder", async (t) => {
  const directory = await temp(t), snapshot = live(334); await publishSnapshot(join(directory, "public", "data", "market.json"), snapshot);
  const result = await runHistorySession("history", directory, { contact: "test" }, null, { consoleImpl: silent,
    historyOptions: { now: () => NOW, request: async () => entry(NOW) } });
  assert.equal(result.session.batchesCompleted, 2); assert.equal(result.session.refreshedPairs, 1002);
  const attempts = (await recentRuns(directory)).map((run) => run.history.attemptedPairs).sort((a, b) => a - b);
  assert.deepEqual(attempts, [2, 1000]);
});

test("a recovered source clears the deferral while preserving existing daily history until success", async (t) => {
  const directory = await temp(t), snapshot = live(1); let now = NOW;
  await refreshHistory(snapshot, directory, { contact: "test", now: () => now, request: async () => entry(now) });
  now += DAY + 1;
  await refreshHistory(snapshot, directory, { contact: "test", now: () => now, request: async () => { throw Object.assign(new Error("404"), { status: 404 }); } });
  assert.ok((await historyDiagnostics(directory, snapshot, now)).deferred.every((item) => item.hasRetainedHistory));
  now += DAY + 1;
  await refreshHistory(snapshot, directory, { contact: "test", now: () => now, request: async () => entry(now) });
  assert.equal((await historyDiagnostics(directory, snapshot, now)).deferred.length, 0);
});

test("low ESI error budget on a 404 still stops the pass before more requests", async (t) => {
  const directory = await temp(t), snapshot = live(2); let calls = 0;
  const result = await refreshHistory(snapshot, directory, { contact: "test", now: () => NOW, concurrency: 1,
    fetchImpl: async () => { calls++; return new Response('{}', { status: 404, headers: { 'X-Esi-Error-Limit-Remain': '5', 'X-Esi-Error-Limit-Reset': '30' } }); } });
  assert.equal(calls, 1); assert.equal(result.stopReason, "rate-limit"); assert.equal(result.failures[0].retryAt, iso(NOW + DAY));
});

test("HTTP retries count against the outbound request cap", async (t) => {
  const { EsiClient } = await import("../lib/esi.mjs");
  const directory = await temp(t); let calls = 0;
  const esi = new EsiClient({ cacheDirectory: directory, userAgent: 'test', maxRequests: 1,
    sleep: async () => {}, fetchImpl: async () => { calls++; return new Response('{}', { status: 503 }); } });
  await assert.rejects(esi.get('/markets/10000002/history?type_id=34', { cache: 'none' }), (error) => error.requestBudgetExceeded === true);
  assert.equal(calls, 1); assert.equal(esi.statistics.requests, 1);
});

test("a region/route 404 is treated as a source failure rather than an unavailable item", async (t) => {
  const directory = await temp(t), snapshot = live(2); let calls = 0;
  const result = await refreshHistory(snapshot, directory, { contact: 'test', now: () => NOW, concurrency: 1,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({error:'Region not found!'}), {status:404}); } });
  assert.equal(calls, 3); assert.equal(result.stopReason, 'source-errors');
  assert.ok(result.failures.every((failure) => failure.category === 'http' && Date.parse(failure.retryAt) < NOW + DAY));
});
