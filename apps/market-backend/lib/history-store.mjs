import { join } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./storage.mjs";
import { historyDateNumber, mergeDailyHistory, summarizeHistory } from "../../../packages/shared/src/marketHistory.mjs";

const DAY = 86_400_000;
export const HISTORY_SHARDS = 32;
export const HISTORY_COLUMNS = ["day", "volume", "orderCount", "average", "highest", "lowest"];
const date = (day) => new Date(day * DAY).toISOString().slice(0, 10);
const idCheck = (id) => { if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw new Error("Invalid history identity."); return String(id); };
const shardFor = (id) => Number(id) % HISTORY_SHARDS;
const checksum = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function unpackHistoryRecord(regionId, typeId, record) {
  return { schemaVersion: 1, regionId, typeId, retentionDays: 21, asOfDate: record.asOfDate,
    checkedAt: record.checkedAt, expiresAt: record.expiresAt, lastRecordDate: record.rows.length ? date(record.rows.at(-1)[0]) : null,
    days: Object.fromEntries(record.rows.map(([day, volume, orderCount, average, highest, lowest]) => [date(day), { volume, orderCount, average, highest, lowest }])) };
}

export function validateHistoryRecord(record) {
  const allowed = ["asOfDate", "checkedAt", "expiresAt", "etag", "sourceUpdatedAt", "coverageBasis", "lastAttemptAt", "retryAt", "lastError", "rows", "deferredSince", "failureCount"];
  if (!record || Object.keys(record).some((key) => !allowed.includes(key)) || !Array.isArray(record.rows) || record.rows.length > 21 ||
    !["last-modified", "latest-record", "unknown"].includes(record.coverageBasis)) throw new Error("Invalid retained history record.");
  for (const key of ["checkedAt", "expiresAt", "sourceUpdatedAt", "lastAttemptAt", "retryAt"]) {
    if (record[key] !== null && !Number.isFinite(Date.parse(record[key]))) throw new Error(`Invalid history ${key}.`);
  }
  if (!(record.etag === null || typeof record.etag === "string" && record.etag.length < 1024) ||
    !(record.lastError === null || ["network", "rate-limit", "invalid-data", "http", "not-found", "budget", "cancelled"].includes(record.lastError))) throw new Error("Invalid history source metadata.");
  if (record.deferredSince != null && !Number.isFinite(Date.parse(record.deferredSince)) || record.failureCount !== undefined && (!Number.isSafeInteger(record.failureCount) || record.failureCount < 0)) throw new Error("Invalid history deferral metadata.");
  const end = record.asOfDate === null ? null : historyDateNumber(record.asOfDate) / DAY;
  if (end === null && record.rows.length) throw new Error("History rows require a coverage date.");
  let previous = -Infinity;
  for (const row of record.rows) {
    if (!Array.isArray(row) || row.length !== 6 || !Number.isInteger(row[0]) || row[0] <= previous || row[0] > end || row[0] < end - 20 ||
      ![row[1], row[2]].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !row.slice(3).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) || row[5] > row[4]) throw new Error("Invalid retained daily history row.");
    previous = row[0];
  }
  return record;
}

export function compactHistorySummary(regionId, typeId, record) {
  const series = record.asOfDate && record.checkedAt ? unpackHistoryRecord(regionId, typeId, record) : null;
  const seven = series ? summarizeHistory(series, 7) : null, fourteen = series ? summarizeHistory(series, 14) : null;
  return { asOfDate: record.asOfDate, checkedAt: record.checkedAt, sourceUpdatedAt: record.sourceUpdatedAt,
    lastRecordDate: series?.lastRecordDate ?? null, volume7d: seven?.volume ?? null, volume14d: fourteen?.volume ?? null,
    missingDays7: seven?.missingDates.length ?? 7, missingDays14: fourteen?.missingDates.length ?? 14, retainedDays: record.rows.length };
}

export function reconcileHistoryRecord(regionId, typeId, previous, response, { checkedAt, sourceUpdatedAt = null, expiresAt, etag = null, notModified = false }) {
  const delta = { insertedDays: 0, correctedDays: 0, unchangedDays: 0, prunedDays: 0, verifiedDays: 0, sourceRows: 0 };
  if (notModified) {
    if (!previous?.checkedAt) throw new Error("A 304 history response needs retained data.");
    delta.unchangedDays = previous.rows.length; delta.verifiedDays = previous.rows.length;
    return { record: validateHistoryRecord({ ...previous, checkedAt, expiresAt, etag: etag ?? previous.etag,
      sourceUpdatedAt: sourceUpdatedAt ?? previous.sourceUpdatedAt, lastAttemptAt: checkedAt, retryAt: null, lastError: null, deferredSince: null, failureCount: 0 }), delta };
  }
  if (!Array.isArray(response)) throw new Error("Invalid daily history response.");
  const yesterday = Math.floor(Date.parse(checkedAt) / DAY) - 1;
  const returnedDays = response.map((row) => historyDateNumber(row.date) / DAY).filter((day) => day <= yesterday);
  const sourceDay = sourceUpdatedAt ? Math.floor(Date.parse(sourceUpdatedAt) / DAY) - 1 : null;
  const latestReturnedDay = Math.max(-Infinity, ...returnedDays);
  const end = Math.max(sourceDay ?? -Infinity, latestReturnedDay);
  const asOfDate = Number.isFinite(end) ? date(Math.min(yesterday, end)) : previous?.asOfDate ?? null;
  const coverageBasis = sourceDay !== null && sourceDay >= latestReturnedDay ? "last-modified" : returnedDays.length ? "latest-record" : "unknown";
  let rows = [];
  if (asOfDate) {
    const oldSeries = previous?.asOfDate && previous.checkedAt ? unpackHistoryRecord(regionId, typeId, previous) : null;
    const next = mergeDailyHistory(oldSeries, response, { regionId, typeId, asOfDate, checkedAt, expiresAt });
    const old = oldSeries?.days ?? {};
    const incoming = new Set(response.map((row) => row.date));
    for (const [day, value] of Object.entries(next.days)) {
      if (!old[day]) delta.insertedDays++;
      else if (incoming.has(day)) {
        delta.verifiedDays++;
        if (JSON.stringify(old[day]) === JSON.stringify(value)) delta.unchangedDays++;
        else delta.correctedDays++;
      }
      rows.push([historyDateNumber(day) / DAY, value.volume, value.orderCount, value.average, value.highest, value.lowest]);
    }
    delta.prunedDays = Object.keys(old).filter((day) => !Object.hasOwn(next.days, day)).length;
  } else if (response.length) throw new Error("History contains no valid completed-day coverage.");
  delta.sourceRows = response.length;
  const record = validateHistoryRecord({ asOfDate, checkedAt, expiresAt, etag, sourceUpdatedAt, coverageBasis,
    lastAttemptAt: checkedAt, retryAt: null, lastError: null, deferredSince: null, failureCount: 0, rows });
  return { record, delta };
}

export class HistoryStore {
  constructor(directory) { this.directory = directory; this.shards = new Map(); this.dirty = new Set(); this.changes = new Map(); this.journals = []; this.sequence = 0; this.metrics = { bytesRead: 0, bytesWritten: 0, checkpoints: 0, compactedShards: 0 }; }
  async load(regionIds) {
    const journalDirectory = join(this.directory, "history", "checkpoints");
    const names = (await readdir(journalDirectory).catch((error) => { if (error.code === "ENOENT") return []; throw error; })).filter((name) => /^\d{12}\.json$/.test(name)).sort();
    const patches = [];
    for (const name of names) {
      const path = join(journalDirectory, name), patch = await readJson(path);
      if (patch?.schemaVersion !== 1 || !Array.isArray(patch.changes) || patch.checksum !== checksum(patch.changes)) throw new Error("History checkpoint integrity check failed.");
      for (const [regionId, typeId, record] of patch.changes) { idCheck(regionId); idCheck(typeId); validateHistoryRecord(record); }
      patches.push(patch); this.journals.push(path); this.sequence = Math.max(this.sequence, Number(name.slice(0, 12)));
      this.metrics.bytesRead += Buffer.byteLength(JSON.stringify(patch));
    }
    const regions = new Set([...regionIds.map(idCheck), ...patches.flatMap((patch) => patch.changes.map(([regionId]) => regionId))]);
    for (const regionId of regions) {
      for (let shardId = 0; shardId < HISTORY_SHARDS; shardId++) {
        const path = this.path(regionId, shardId), stored = await readJson(path);
        const series = stored?.series ?? {};
        if (stored) {
          if (stored.schemaVersion !== 1 || stored.regionId !== regionId || stored.shardId !== shardId || stored.retentionDays !== 21 ||
            JSON.stringify(stored.columns) !== JSON.stringify(HISTORY_COLUMNS) || stored.checksum !== checksum(series)) throw new Error("History shard integrity check failed.");
          for (const [typeId, record] of Object.entries(series)) { if (shardFor(idCheck(typeId)) !== shardId) throw new Error("History shard identity mismatch."); validateHistoryRecord(record); }
          this.metrics.bytesRead += Buffer.byteLength(JSON.stringify(stored));
        }
        this.shards.set(`${regionId}:${shardId}`, { regionId, shardId, series });
      }
    }
    for (const patch of patches) for (const [regionId, typeId, record] of patch.changes) {
      const key = `${regionId}:${shardFor(typeId)}`;
      this.shards.get(key).series[typeId] = record; this.dirty.add(key);
    }
    return this;
  }
  path(regionId, shardId) { return join(this.directory, "history", "regions", regionId, `${String(shardId).padStart(2, "0")}.json`); }
  get(regionId, typeId) { return this.shards.get(`${regionId}:${shardFor(typeId)}`)?.series[typeId] ?? null; }
  set(regionId, typeId, record) {
    idCheck(regionId); idCheck(typeId); validateHistoryRecord(record);
    const key = `${regionId}:${shardFor(typeId)}`, shard = this.shards.get(key);
    if (!shard) throw new Error("Load history region before updating it.");
    shard.series[typeId] = record; this.dirty.add(key); this.changes.set(`${regionId}:${typeId}`, [regionId, typeId, record]);
  }
  async checkpoint() {
    if (!this.changes.size) return;
    const changes = [...this.changes.values()], data = { schemaVersion: 1, checksum: checksum(changes), changes };
    if (++this.sequence >= 1e12) throw new Error("History checkpoint sequence exhausted.");
    const path = join(this.directory, "history", "checkpoints", `${String(this.sequence).padStart(12, "0")}.json`);
    await writeJson(path, data);
    this.metrics.bytesWritten += Buffer.byteLength(JSON.stringify(data)); this.metrics.checkpoints++;
    this.journals.push(path); this.changes.clear();
  }
  async compact() {
    await this.checkpoint();
    for (const key of this.dirty) {
      const shard = this.shards.get(key);
      const data = { schemaVersion: 1, regionId: shard.regionId, shardId: shard.shardId, retentionDays: 21, columns: HISTORY_COLUMNS,
        checksum: checksum(shard.series), series: shard.series };
      await writeJson(this.path(shard.regionId, shard.shardId), data);
      this.metrics.bytesWritten += Buffer.byteLength(JSON.stringify(data)); this.metrics.compactedShards++;
    }
    this.dirty.clear();
    // All source shards are now durable. Delete oldest first: after an interruption,
    // replaying any remaining suffix cannot roll a newer shard value backwards.
    for (const path of this.journals) await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    this.journals = []; this.sequence = 0;
  }
  async publishSummaries() {
    const regions = new Map();
    for (const shard of this.shards.values()) {
      if (!regions.has(shard.regionId)) regions.set(shard.regionId, {});
      for (const [typeId, record] of Object.entries(shard.series)) {
        if (record.checkedAt) regions.get(shard.regionId)[typeId] = compactHistorySummary(shard.regionId, typeId, record);
      }
    }
    for (const [regionId, series] of regions) {
      const data = { schemaVersion: 1, regionId, retentionDays: 21, checksum: checksum(series), series };
      await writeJson(join(this.directory, "history", "summaries", `${regionId}.json`), data);
      this.metrics.bytesWritten += Buffer.byteLength(JSON.stringify(data));
    }
    return regions;
  }
}

export async function loadHistorySummaries(directory, regionIds) {
  const result = new Map();
  for (const regionId of [...new Set(regionIds.map(idCheck))]) {
    const stored = await readJson(join(directory, "history", "summaries", `${regionId}.json`));
    if (stored && (stored.schemaVersion !== 1 || stored.regionId !== regionId || stored.retentionDays !== 21 || stored.checksum !== checksum(stored.series))) throw new Error("History serving summary integrity check failed. Verify retained history to rebuild it.");
    result.set(regionId, new Map(Object.entries(stored?.series ?? {}).map(([id, value]) => [Number(id), value])));
  }
  return result;
}

export async function verifyHistory(directory, regionIds, { repair = false } = {}) {
  const start = performance.now(), cpu = process.cpuUsage(), store = await new HistoryStore(directory).load(regionIds);
  let series = 0, days = 0, mismatches = 0;
  let summaries, invalidSummary = false;
  try { summaries = await loadHistorySummaries(directory, regionIds); } catch (error) { if (!repair) throw error; summaries = new Map(); invalidSummary = true; }
  for (const shard of store.shards.values()) for (const [typeId, record] of Object.entries(shard.series)) {
    series++; days += record.rows.length;
    if (record.checkedAt && JSON.stringify(compactHistorySummary(shard.regionId, typeId, record)) !== JSON.stringify(summaries.get(shard.regionId)?.get(Number(typeId)))) mismatches++;
  }
  for (const [regionId, entries] of summaries) for (const typeId of entries.keys()) {
    if (!store.get(regionId, String(typeId))?.checkedAt) mismatches++;
  }
  if (invalidSummary && !mismatches) mismatches++;
  if (repair && mismatches) await store.publishSummaries();
  const used = process.cpuUsage(cpu);
  return { series, days, mismatches, repaired: repair ? mismatches : 0, durationMs: performance.now() - start,
    cpuMs: (used.user + used.system) / 1000, maxRssKiB: process.resourceUsage().maxRSS, ...store.metrics };
}
