// Shared history reductions used by the persistent refresher and its tests.
export const HISTORY_RETENTION_DAYS = 21;
export const DEFAULT_HISTORY_WINDOW_DAYS = 7;
const DAY = 86_400_000;

export function historyDateNumber(value) {
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error("Invalid UTC history date.");
  return time;
}
const dateNumber = historyDateNumber;
const dateAt = (time) => new Date(time).toISOString().slice(0, 10);

export function mergeDailyHistory(previous, response, { regionId, typeId, asOfDate, checkedAt, expiresAt = null }) {
  if (![regionId, typeId].every((id) => typeof id === "string" && /^[1-9]\d*$/.test(id)) ||
    !Number.isFinite(Date.parse(checkedAt)) || expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) throw new Error("Invalid history identity or timestamp.");
  if (previous && (previous.regionId !== regionId || previous.typeId !== typeId)) throw new Error("History region/type identity changed.");
  const end = dateNumber(asOfDate), first = end - (HISTORY_RETENTION_DAYS - 1) * DAY;
  if (previous && dateNumber(previous.asOfDate) > end) throw new Error("History coverage cannot move backwards.");
  if (end >= dateNumber(new Date(checkedAt).toISOString().slice(0, 10))) throw new Error("History can include only completed UTC days.");
  if (!Array.isArray(response)) throw new Error("Invalid daily history response.");
  const days = Object.assign(Object.create(null), previous?.days);
  const seen = new Set();
  for (const row of response) {
    const time = dateNumber(row.date);
    if (seen.has(row.date)) throw new Error("Duplicate daily history date.");
    seen.add(row.date);
    if (![row.volume, row.order_count].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      ![row.average, row.highest, row.lowest].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
      row.lowest > row.highest) throw new Error("Invalid daily history values.");
    if (time >= first && time <= end) days[row.date] = { volume: row.volume, orderCount: row.order_count,
      average: row.average, highest: row.highest, lowest: row.lowest };
  }
  for (const date of Object.keys(days)) if (dateNumber(date) < first || dateNumber(date) > end) delete days[date];
  return { schemaVersion: 1, regionId, typeId, retentionDays: HISTORY_RETENTION_DAYS, asOfDate, checkedAt, expiresAt,
    lastRecordDate: Object.keys(days).sort().at(-1) ?? null, days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))) };
}

export function summarizeHistory(series, windowDays = DEFAULT_HISTORY_WINDOW_DAYS, now = Date.now()) {
  if (![7, 14].includes(windowDays)) throw new Error("Supported history windows are 7 and 14 days.");
  const end = dateNumber(series.asOfDate), missingDates = [];
  let volume = 0;
  for (let offset = windowDays - 1; offset >= 0; offset--) {
    const date = dateAt(end - offset * DAY), day = series.days[date];
    if (!day) missingDates.push(date); else volume += day.volume;
  }
  const completeVolume = missingDates.length || !Number.isSafeInteger(volume) ? null : volume;
  return { windowDays, windowStart: dateAt(end - (windowDays - 1) * DAY), windowEnd: series.asOfDate,
    volume: completeVolume, weeklyEquivalentVolume: completeVolume === null ? null : windowDays === 7 ? completeVolume : completeVolume / 2,
    missingDates, checkedAt: series.checkedAt, lastRecordDate: series.lastRecordDate,
    checkAgeMs: Math.max(0, now - Date.parse(series.checkedAt)),
    coverageLagDays: Math.max(0, Math.floor((dateNumber(dateAt(now)) - DAY - end) / DAY)) };
}
