// The local collector and the static browser share this dependency-free contract.
export const SNAPSHOT_VERSION = 1;
// Legacy three-hub fixture labels; live hubs come from collector configuration.
export const HUBS = [
  { id: "jita", name: "Jita" },
  { id: "tortuga", name: "Tortuga · Siseide" },
  { id: "cj6mt", name: "C-J6MT" },
];

function check(condition, message) {
  if (!condition) throw new Error(`Invalid snapshot: ${message}`);
}

function keys(value, allowed) {
  check(value && typeof value === "object" && !Array.isArray(value), "expected object");
  check(Object.keys(value).every((key) => allowed.includes(key)), "unexpected field");
}

export function validateSnapshot(snapshot) {
  keys(snapshot, ["schemaVersion", "mode", "generatedAt", "scope", "hubs", "statistics", "omittedHubs"]);
  check(snapshot.schemaVersion === SNAPSHOT_VERSION, "unsupported schema version");
  check(["fixture", "live"].includes(snapshot.mode), "unknown data mode");
  check(Number.isFinite(Date.parse(snapshot.generatedAt)), "missing generation time");
  keys(snapshot.scope, ["typeLimit", "historyLimit"]);
  check(Number.isInteger(snapshot.scope.typeLimit) && snapshot.scope.typeLimit >= 0, "type limit");
  check(Number.isInteger(snapshot.scope.historyLimit) && snapshot.scope.historyLimit >= 0, "history limit");
  keys(snapshot.statistics, ["durationMs", "requests", "cacheHits"]);
  for (const value of Object.values(snapshot.statistics)) check(Number.isFinite(value) && value >= 0, "statistics");
  check(Array.isArray(snapshot.hubs) && snapshot.hubs.length >= 1 && snapshot.hubs.length <= 16, "expected 1–16 hubs");
  const seenHubs = new Set();
  for (const hub of snapshot.hubs) {
    keys(hub, ["id", "name", "locationId", "regionId", "observedAt", "competitionAsOf", "rows"]);
    if (hub.competitionAsOf !== undefined) check(Number.isFinite(Date.parse(hub.competitionAsOf)), "competition timestamp");
    check(typeof hub.id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(hub.id) && !seenHubs.has(hub.id), "hub identity");
    seenHubs.add(hub.id);
    check(typeof hub.name === "string" && typeof hub.locationId === "string" && typeof hub.regionId === "string", "hub metadata");
    check(Number.isFinite(Date.parse(hub.observedAt)) && Array.isArray(hub.rows), "hub data");
    const types = new Set();
    for (const row of hub.rows) {
      keys(row, ["typeId", "itemName", "buy", "sell", "buyUnits", "sellUnits", "volumeM3", "regionalWeekVolume", "regionalFortnightVolume", "history", "competition"]);
      if (row.regionalFortnightVolume !== undefined) check(row.regionalFortnightVolume === null || Number.isSafeInteger(row.regionalFortnightVolume) && row.regionalFortnightVolume >= 0, "fourteen day volume");
      if (row.history != null) {
        keys(row.history, ["asOfDate", "checkedAt", "sourceUpdatedAt", "lastRecordDate", "retainedDays", "missingDays7", "missingDays14"]);
        for (const key of ["asOfDate", "checkedAt", "sourceUpdatedAt", "lastRecordDate"]) check(row.history[key] === null || typeof row.history[key] === "string" && Number.isFinite(Date.parse(row.history[key])), "history timestamp");
        for (const [key, max] of [["retainedDays", 21], ["missingDays7", 7], ["missingDays14", 14]]) check(Number.isInteger(row.history[key]) && row.history[key] >= 0 && row.history[key] <= max, "history coverage");
      }
      if (row.competition !== undefined) {
        const allowed = ["askOrders", "recentAskOrders24h", "recentAskUnits24h", "recentAskOriginalUnits24h", "unknownIssuedAskOrders"];
        keys(row.competition, allowed);
        for (const key of allowed) check(row.competition[key] === null && key.startsWith("recent") || Number.isSafeInteger(row.competition[key]) && row.competition[key] >= 0, "competition aggregate");
      }
      check(typeof row.typeId === "string" && /^\d+$/.test(row.typeId) && !types.has(row.typeId), "duplicate/invalid type ID");
      types.add(row.typeId);
      check(typeof row.itemName === "string" && row.itemName.length > 0, "item name");
      for (const key of ["buy", "sell", "volumeM3", "regionalWeekVolume"]) {
        check(row[key] === null || (Number.isFinite(row[key]) && row[key] >= 0), key);
      }
      for (const key of ["buyUnits", "sellUnits"]) check(Number.isSafeInteger(row[key]) && row[key] >= 0, key);
    }
  }
  if (snapshot.omittedHubs !== undefined) {
    check(Array.isArray(snapshot.omittedHubs) && snapshot.omittedHubs.length <= 16, "omitted hubs");
    for (const hub of snapshot.omittedHubs) {
      keys(hub, ["id", "name", "reason", "status"]);
      check(typeof hub.id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(hub.id) && !seenHubs.has(hub.id), "omitted hub identity");
      seenHubs.add(hub.id);
      check(typeof hub.name === "string" && hub.name.length > 0 && ["disabled", "access-denied", "not-found"].includes(hub.reason) &&
        [null, 403, 404].includes(hub.status), "omitted hub status");
    }
  }
  return snapshot;
}

export function describeDataAge(observedAt, now = Date.now()) {
  const ageMs = Math.max(0, now - Date.parse(observedAt));
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const count = (value, unit) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  const parts = days ? [count(days, "day"), hours % 24 ? count(hours % 24, "hour") : ""] :
    hours ? [count(hours, "hour"), minutes % 60 ? count(minutes % 60, "minute") : ""] : [count(minutes, "minute")];
  return { ageMs, text: minutes ? `${parts.filter(Boolean).join(" ")} old` : "Less than a minute old",
    tone: hours >= 8 ? "stale" : hours >= 1 ? "aging" : "fresh" };
}

export function compareHubs(snapshot, sourceId, destinationId, { sale = "listing", haul = 700, tax = 5.37, windowDays = 7 } = {}) {
  if (sourceId === destinationId) return [];
  const source = snapshot.hubs.find((hub) => hub.id === sourceId);
  const destination = snapshot.hubs.find((hub) => hub.id === destinationId);
  if (!source || !destination) return [];
  const destinations = new Map(destination.rows.map((row) => [row.typeId, row]));
  const result = source.rows.map((row) => {
    const target = destinations.get(row.typeId);
    const destinationPrice = sale === "instant" ? target?.buy : target?.sell;
    const transport = row.volumeM3 === null ? null : row.volumeM3 * haul;
    const landed = row.sell === null || transport === null ? null : row.sell + transport;
    const profit = landed === null || destinationPrice == null ? null : destinationPrice * (1 - tax / 100) - landed;
    const regionalWeekVolume = windowDays === 14 ? target?.regionalFortnightVolume == null ? null : target.regionalFortnightVolume / 2 : target?.regionalWeekVolume ?? null;
    return { ...row, acquisition: row.sell, destinationPrice: destinationPrice ?? null, transport, landed, profit,
      grossWeekProfit: regionalWeekVolume === null || destinationPrice == null || row.sell === null ? null : (destinationPrice - row.sell) * regionalWeekVolume,
      weeklySizeMoved: regionalWeekVolume === null || row.volumeM3 === null ? null : regionalWeekVolume * row.volumeM3,
      pricePerM3: row.volumeM3 > 0 && row.sell !== null ? row.sell / row.volumeM3 : null,
      margin: profit === null || !landed ? null : profit / landed * 100,
      destinationUnits: (sale === "instant" ? target?.buyUnits : target?.sellUnits) ?? 0,
      regionalWeekVolume, estimatedWeekProfit: profit === null || regionalWeekVolume === null ? null : profit * regionalWeekVolume,
      history: target?.history ?? null, competition: target?.competition ?? null };
  });
  return addFillerScores(result);
}

export function addFillerScores(rows) {
  const eligible = rows.filter((row) => row.weeklySizeMoved !== null && row.estimatedWeekProfit !== null && row.pricePerM3 !== null);
  const rank = (key) => new Map([...eligible].sort((a, b) => a[key] - b[key] || Number(a.typeId) - Number(b.typeId)).map((row, index) => [row.typeId, eligible.length === 1 ? 50 : index / (eligible.length - 1) * 100]));
  const volumes = rank("weeklySizeMoved"), profits = rank("estimatedWeekProfit");
  return rows.map((row) => {
    if (!volumes.has(row.typeId)) return { ...row, fillerScore: null };
    const price = row.pricePerM3, transport = price < 50_000 ? 100 : price < 100_000 ? 70 : price < 150_000 ? 40 : price < 170_000 ? 10 : -50;
    return { ...row, fillerScore: .8 * volumes.get(row.typeId) + .1 * (profits.get(row.typeId) - (row.estimatedWeekProfit < 0 ? 100 : 0)) + .1 * transport };
  });
}

export function sortOpportunities(rows, key = "profit", direction = "desc") {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a[key] == null) return b[key] == null ? a.itemName.localeCompare(b.itemName) : 1;
    if (b[key] == null) return -1;
    const order = key === "typeId" ? Number(a[key]) - Number(b[key]) : typeof a[key] === "string" ? a[key].localeCompare(b[key]) : a[key] - b[key];
    return order * multiplier || a.itemName.localeCompare(b.itemName);
  });
}
