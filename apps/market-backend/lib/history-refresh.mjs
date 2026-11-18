import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readJson } from "./storage.mjs";
import { performance } from "node:perf_hooks";
import { EsiClient } from "./esi.mjs";
import { HistoryStore, loadHistorySummaries, reconcileHistoryRecord } from "./history-store.mjs";
import { validateSnapshot } from "../../../packages/shared/src/marketSnapshot.mjs";

export function historyTargets(snapshot) {
  const regions = new Map();
  for (const hub of snapshot.hubs) {
    if (!regions.has(hub.regionId)) regions.set(hub.regionId, new Set());
    for (const row of hub.rows) regions.get(hub.regionId).add(row.typeId);
  }
  const lists = [...regions].map(([regionId, types]) => [...types].sort((a, b) => Number(a) - Number(b)).map((typeId) => ({ regionId, typeId })));
  const result = [];
  // Round-robin regions so a partial backfill serves all destinations.
  for (let i = 0; lists.some((list) => i < list.length); i++) for (const list of lists) if (list[i]) result.push(list[i]);
  return result;
}

export async function attachHistory(snapshot, directory) {
  const summaries = await loadHistorySummaries(directory, snapshot.hubs.map((hub) => hub.regionId));
  return validateSnapshot({ ...snapshot, hubs: snapshot.hubs.map((hub) => ({ ...hub, rows: hub.rows.map((row) => {
    const summary = summaries.get(hub.regionId)?.get(Number(row.typeId));
    return { ...row, regionalWeekVolume: summary?.volume7d ?? null, regionalFortnightVolume: summary?.volume14d ?? null,
      history: summary ? { asOfDate: summary.asOfDate, checkedAt: summary.checkedAt, sourceUpdatedAt: summary.sourceUpdatedAt,
        lastRecordDate: summary.lastRecordDate, retainedDays: summary.retainedDays, missingDays7: summary.missingDays7, missingDays14: summary.missingDays14 } : null };
  }) })) });
}

export async function refreshHistory(snapshot, directory, { contact, maxSeconds = 300, maxPairs = 1000,
  concurrency = 3, fetchImpl = fetch, now = () => Date.now(), signal, onProgress = () => {}, checkpointPairs = 500,
  checkpointMs = 10_000, request = null, excludeTargets = new Set() } = {}) {
  if (snapshot.mode !== "live") throw new Error("Collect a live snapshot before updating regional history.");
  if (!contact?.trim()) throw new Error("Save an ESI application contact before updating history.");
  if (!Number.isFinite(maxSeconds) || maxSeconds < 0 || !Number.isInteger(maxPairs) || maxPairs < 0 ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("Invalid history batch limits.");
  const start = performance.now(), cpu = process.cpuUsage(), startedAt = now(), deadline = maxSeconds ? startedAt + maxSeconds * 1000 : Infinity;
  const targets = historyTargets(snapshot), store = await new HistoryStore(directory).load(targets.map((pair) => pair.regionId));
  const esi = new EsiClient({ cacheDirectory: join(directory, "cache"), userAgent: `GoonmetricsMarketBackend/0.3 (${contact})`,
    fetchImpl, now, requestConcurrency: concurrency, stopOnError: false, signal, deadlineMs: deadline, maxRequests: maxPairs || Infinity });
  const counts = { legacySeededPairs: 0, targetPairs: targets.length, freshPairs: 0, deferredPairs: 0, attemptedPairs: 0, refreshedPairs: 0, failedPairs: 0,
    insertedDays: 0, correctedDays: 0, unchangedDays: 0, verifiedDays: 0, prunedDays: 0, sourceRows: 0 };
  // Adopt the old proof's small public history cache without re-requesting fresh bodies.
  const oldNames = new Set(await readdir(join(directory, "cache")).catch((error) => { if (error.code === "ENOENT") return []; throw error; }));
  const migrated = [];
  if (oldNames.size) for (const { regionId, typeId } of targets) {
    if (store.get(regionId, typeId)) continue;
    const name = createHash("sha256").update(`public:2026-11-05:/markets/${regionId}/history?type_id=${typeId}`).digest("hex") + ".json";
    if (!oldNames.has(name)) continue;
    const path = join(directory, "cache", name);
    let record;
    try {
      const old = await readJson(path);
      if (!Array.isArray(old?.body) || !Number.isFinite(old.expiresAt) || !Number.isFinite(Date.parse(old.observedAt))) continue;
      ({ record } = reconcileHistoryRecord(regionId, typeId, null, old.body, { checkedAt: old.observedAt,
        expiresAt: new Date(old.expiresAt).toISOString(), etag: old.etag ?? null, sourceUpdatedAt: old.sourceUpdatedAt ?? old.observedAt }));
    } catch { continue; } // A corrupt rebuildable legacy response must not block a clean fetch.
    store.set(regionId, typeId, record); migrated.push(path); counts.legacySeededPairs++;
  }
  if (migrated.length) {
    await store.checkpoint();
    // Delete only identified public history files, after their retained records are durable.
    for (const path of migrated) await unlink(path);
  }
  const pending = targets.filter(({ regionId, typeId }) => {
    const record = store.get(regionId, typeId);
    if (record?.checkedAt && Date.parse(record.expiresAt) > startedAt) { counts.freshPairs++; return false; }
    if (record?.retryAt && Date.parse(record.retryAt) > startedAt) { counts.deferredPairs++; return false; }
    return !excludeTargets.has(`${regionId}:${typeId}`);
  }).sort((a, b) => (Date.parse(store.get(a.regionId, a.typeId)?.checkedAt) || 0) - (Date.parse(store.get(b.regionId, b.typeId)?.checkedAt) || 0));
  const { historicalDeferrals } = await import("./history-diagnostics.mjs");
  let deferralEvidence;
  const earlierDeferrals = () => deferralEvidence ??= historicalDeferrals(directory);
  const failures = [], completedTargets = [];
  const diagnostics = () => {
    let collectedPairs = 0, freshPairs = 0, deferredPairs = 0;
    for (const { regionId, typeId } of targets) { const record = store.get(regionId, typeId);
      if (record?.checkedAt) collectedPairs++;
      if (record?.checkedAt && Date.parse(record.expiresAt) > now()) freshPairs++;
      else if (record?.retryAt && Date.parse(record.retryAt) > now()) deferredPairs++;
    }
    return { collectedPairs, neverCollectedPairs: targets.length - collectedPairs, freshPairsNow: freshPairs, deferredPairsNow: deferredPairs };
  };
  let stopReason = "complete", cursor = 0, consecutiveFailures = 0, lastCheckpoint = now(), sinceCheckpoint = 0;
  const report = () => onProgress({ phase: "history", message: `Updating 21-day regional history · ${counts.refreshedPairs} verified this batch · ${counts.freshPairs} already fresh`,
    completed: counts.attemptedPairs, total: maxPairs ? Math.min(maxPairs, pending.length) : pending.length, unit: "pairs attempted this batch", history: { ...counts, requests: esi.statistics.requests, retries: esi.metrics.retries }, batchLimit: maxPairs,
    elapsedMs: Math.round(performance.now() - start), budgetSeconds: maxSeconds });
  report();
  // Workers drain as a group before each checkpoint; publication never races a write.
  try {
    while (cursor < pending.length) {
      if (signal?.aborted) { stopReason = "cancelled"; break; }
      if (now() >= deadline) { stopReason = "time-budget"; break; }
      if (maxPairs && counts.attemptedPairs >= maxPairs) { stopReason = "pair-budget"; break; }
      const group = pending.slice(cursor, cursor + Math.min(concurrency, maxPairs ? maxPairs - counts.attemptedPairs : concurrency));
      cursor += group.length;
      await Promise.all(group.map(async ({ regionId, typeId }) => {
        const previous = store.get(regionId, typeId), checkedAt = new Date(now()).toISOString();
        counts.attemptedPairs++;
        try {
          const entry = await (request ? request({ regionId, typeId, previous }) : esi.get(`/markets/${regionId}/history?type_id=${typeId}`,
            { cache: "none", conditional: previous, allowNotModified: Boolean(previous?.checkedAt) }));
          const result = reconcileHistoryRecord(regionId, typeId, previous, entry.body, { checkedAt,
            expiresAt: new Date(Math.max(now() + 60_000, entry.expiresAt)).toISOString(), sourceUpdatedAt: entry.sourceUpdatedAt,
            etag: entry.etag, notModified: entry.notModified });
          store.set(regionId, typeId, result.record);
          for (const [key, value] of Object.entries(result.delta)) counts[key] += value;
          counts.refreshedPairs++; consecutiveFailures = 0;
          completedTargets.push([regionId, typeId]);
        } catch (error) {
          if (error.budgetExceeded || error.cancelled) { stopReason = error.cancelled ? "cancelled" : error.requestBudgetExceeded ? "request-budget" : "time-budget"; return; }
          counts.failedPairs++;
          const notFound = error.status === 404 && error.notFoundScope !== "resource";
          if (!notFound) consecutiveFailures++;
          const lastError = notFound ? "not-found" : error.rateLimited ? "rate-limit" : error.status ? "http" : /Invalid|Duplicate|coverage|History|history/.test(error.message) ? "invalid-data" : "network";
          const retryAt = new Date(now() + (notFound ? 86_400_000 : Math.max(300_000, Math.min(3_600_000, Number(error.retryAfter) * 1000 || 0)))).toISOString();
          const oldEvidence = previous?.deferredSince ? null : (await earlierDeferrals()).get(`${regionId}:${typeId}`);
          const deferredSince = previous?.deferredSince ?? oldEvidence?.since ?? (previous?.lastError ? previous.lastAttemptAt : null) ?? checkedAt;
          const failureCount = (previous?.failureCount ?? oldEvidence?.count ?? 0) + 1;
          failures.push({ regionId, typeId, category: lastError, status: error.status ?? null, deferredSince, retryAt, failureCount });
          if (notFound) completedTargets.push([regionId, typeId]);
          store.set(regionId, typeId, { ...(previous ?? { asOfDate: null, checkedAt: null, expiresAt: null, etag: null, sourceUpdatedAt: null, coverageBasis: "unknown", rows: [] }),
            lastAttemptAt: checkedAt, retryAt, lastError, deferredSince, failureCount });
          onProgress({ phase: "history", message: `Deferred type ${typeId} in region ${regionId} (${lastError}) until ${retryAt}.`,
            deferred: { regionId, typeId, reason: lastError, deferredSince, retryAt, failureCount } });
          if (error.rateLimited) stopReason = "rate-limit";
        }
      }));
      sinceCheckpoint += group.length; report();
      if (sinceCheckpoint >= checkpointPairs || now() - lastCheckpoint >= checkpointMs) {
        await store.checkpoint(); sinceCheckpoint = 0; lastCheckpoint = now();
      }
      if (stopReason !== "complete") break;
      if (consecutiveFailures >= 3) { stopReason = "source-errors"; break; }
    }
  } finally {
    await store.compact();
    await store.publishSummaries();
  }
  const used = process.cpuUsage(cpu);
  const handled = new Set(completedTargets.map((pair) => pair.join(":")));
  const remainingEligiblePairs = pending.filter(({ regionId, typeId }) => {
    const record = store.get(regionId, typeId);
    return !handled.has(`${regionId}:${typeId}`) && !(record?.retryAt && Date.parse(record.retryAt) > now());
  }).length;
  return { ...counts, ...diagnostics(), completedTargets, failures, remainingEligiblePairs, pendingPairs: counts.targetPairs - counts.freshPairs - counts.refreshedPairs, stopReason,
    durationMs: Math.round(performance.now() - start), cpuMs: (used.user + used.system) / 1000,
    maxRssKiB: process.resourceUsage().maxRSS, ...store.metrics, ...esi.statistics, network: esi.metrics };
}
