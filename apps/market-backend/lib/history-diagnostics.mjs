import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { readJson } from "./storage.mjs";
import { HistoryStore } from "./history-store.mjs";
import { historyTargets } from "./history-refresh.mjs";

export function needsLegacyDeferralEvidence(store) {
  for (const shard of store.shards.values()) for (const record of Object.values(shard.series)) if (record.lastError && !record.deferredSince) return true;
  return false;
}

// Upgrade the proof's existing failures without discarding their earlier log evidence.
export async function historicalDeferrals(directory) {
  const path = join(directory, "metrics", "runs"), result = new Map();
  const names = await readdir(path).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  for (const name of names.filter((name) => /^\d{13}-[a-f0-9]{8}\.json$/.test(name)).sort()) {
    const report = await readJson(join(path, name));
    for (const failure of report?.history?.failures ?? []) {
      if (failure.status !== 404) continue;
      const key = `${failure.regionId}:${failure.typeId}`, old = result.get(key);
      result.set(key, { since: old?.since ?? report.finishedAt ?? report.startedAt, count: (old?.count ?? 0) + 1 });
    }
  }
  return result;
}

export async function historyDiagnostics(directory, snapshot, now = Date.now()) {
  const targets = historyTargets(snapshot), store = await new HistoryStore(directory).load(snapshot.hubs.map((hub) => hub.regionId));
  const evidence = needsLegacyDeferralEvidence(store) ? await historicalDeferrals(directory) : new Map(), names = new Map(snapshot.hubs.flatMap((hub) => hub.rows.map((row) => [row.typeId, row.itemName])));
  const counts = { targetPairs: targets.length, collectedPairs: 0, freshPairs: 0, deferredPairs: 0, eligiblePairs: 0, neverCollectedPairs: 0 };
  const deferred = [];
  for (const { regionId, typeId } of targets) {
    const record = store.get(regionId, typeId);
    if (record?.checkedAt) counts.collectedPairs++; else counts.neverCollectedPairs++;
    const fresh = record?.checkedAt && Date.parse(record.expiresAt) > now, waiting = record?.retryAt && Date.parse(record.retryAt) > now;
    if (fresh) counts.freshPairs++; else if (waiting) counts.deferredPairs++; else counts.eligiblePairs++;
    if (record?.lastError && record.retryAt) {
      const prior = evidence.get(`${regionId}:${typeId}`), since = record.deferredSince ?? prior?.since ?? record.lastAttemptAt;
      deferred.push({ regionId, typeId, itemName: names.get(typeId), reason: record.lastError === "invalid-data" && prior ? "not-found" : record.lastError, deferredSince: since,
        deferredAgeMs: Math.max(0, now - Date.parse(since)), lastAttemptAt: record.lastAttemptAt, retryAt: record.retryAt,
        retryInMs: Math.max(0, Date.parse(record.retryAt) - now), failureCount: record.failureCount ?? prior?.count ?? 1,
        hasRetainedHistory: Boolean(record.checkedAt), eligibleForRetry: !waiting });
    }
  }
  deferred.sort((a, b) => a.deferredSince.localeCompare(b.deferredSince) || Number(a.typeId) - Number(b.typeId) || a.regionId.localeCompare(b.regionId));
  return { observedAt: new Date(now).toISOString(), ...counts, deferred };
}
