import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { validateSnapshot } from "../../../packages/shared/src/marketSnapshot.mjs";
import { EsiClient } from "./esi.mjs";
import { readJson, writeJson } from "./storage.mjs";
import { loadCatalog } from "./catalog.mjs";
import { configuredHubs } from "./hubs.mjs";
import { mapConcurrent } from "./concurrency.mjs";
import { attachHistory } from "./history-refresh.mjs";
import { aggregateOrders } from "../../../packages/shared/src/marketQuotes.mjs";

export function summarizeOrders(orders, typeIds, metadata, history, asOf) {
  return rowsFromQuotes(aggregateOrders(orders, asOf), typeIds, metadata, history);
}

export function rowsFromQuotes(quotes, typeIds, metadata, history) {
  return typeIds.map((id) => ({ typeId: String(id), itemName: metadata.get(id).name,
    buy: quotes[id]?.bid ?? null, sell: quotes[id]?.ask ?? null, buyUnits: quotes[id]?.buyUnits ?? 0, sellUnits: quotes[id]?.sellUnits ?? 0,
    volumeM3: metadata.get(id).packaged_volume ?? metadata.get(id).volume ?? null,
    regionalWeekVolume: history.get(id) ?? null,
    competition: quotes[id]?.competition ?? { askOrders: 0, recentAskOrders24h: 0, recentAskUnits24h: 0, recentAskOriginalUnits24h: 0, unknownIssuedAskOrders: 0 } }));
}

export function regionalWeekVolume(history, now = new Date()) {
  if (!Array.isArray(history)) throw new Error("Invalid regional history response.");
  const byDate = new Map(history.map((day) => [day.date, day.volume]));
  let total = 0;
  for (let offset = 1; offset <= 7; offset++) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)).toISOString().slice(0, 10);
    const volume = byDate.get(date);
    if (!Number.isSafeInteger(volume) || volume < 0) return null;
    total += volume;
  }
  return Number.isSafeInteger(total) ? total : null;
}

export function selectSampleTypes(books, limit) {
  const typesFor = (book) => book.quotes ? Object.keys(book.quotes).map(Number).sort((a, b) => a - b) : [...new Set(book.orders.map((order) => order.type_id))].sort((a, b) => a - b);
  // Zero explicitly requests every type quoted at any enabled location.
  if (limit === 0) return [...new Set(books.flatMap(typesFor))].sort((a, b) => a - b);
  const privateTypes = books.slice(1).map(typesFor);
  const pools = privateTypes.some((types) => types.length) ? privateTypes : [typesFor(books[0])];
  const selected = new Set();
  // Alternate hubs so one large book's low IDs cannot hide the other hub entirely.
  for (let index = 0; selected.size < limit && pools.some((types) => index < types.length); index++) {
    for (const types of pools) {
      if (index < types.length) selected.add(types[index]);
      if (selected.size === limit) break;
    }
  }
  return [...selected].sort((a, b) => a - b);
}

export async function collectLive(config, directory, sso, { fetchImpl = fetch, now = () => new Date(), onProgress = () => {}, catalog: suppliedCatalog, onMetrics = () => {}, signal } = {}) {
  const started = performance.now(), configured = configuredHubs(config), active = configured.filter((hub) => hub.enabled);
  const omittedHubs = configured.filter((hub) => !hub.enabled).map(({ id, name }) => ({ id, name, reason: "disabled", status: null }));
  let progress = { phase: "authentication", message: "Refreshing the collector character's access…", hubsCompleted: 0,
    hubTotal: active.length, hubIndex: 0, hubName: null, completed: 0, total: null, unit: "steps" };
  const report = (update) => { progress = { ...progress, ...update }; onProgress({ ...progress }); };
  report({});
  if (!config.clientId) throw new Error("Save your EVE application client ID in Local setup first.");
  if (!config.contact?.trim()) throw new Error("Enter an application contact for the ESI User-Agent in Local setup.");
  const catalog = suppliedCatalog ?? (await loadCatalog(directory)).catalog;
  const grantPath = join(directory, "private", "grant.json");
  const grant = await readJson(grantPath);
  if (grant?.authentication !== "pkce" && !config.clientSecret) throw new Error("Connect EVE with the local PKCE flow before collecting live data.");
  const token = await sso.refresh(config, grant, (value) => writeJson(grantPath, value));
  const esi = new EsiClient({ cacheDirectory: join(directory, "cache"), accessToken: token.accessToken,
    characterId: token.character.id, userAgent: `GoonmetricsMarketBackend/0.2 (${config.contact})`, fetchImpl, signal, stopOnError: (error) => ![403, 404].includes(error.status), now: () => now().getTime() });

  const structures = active.filter((hub) => hub.kind === "structure");
  report({ phase: "structures", message: "Verifying access to enabled structures…", total: structures.length, completed: 0 });
  const definitions = active.filter((hub) => hub.kind === "public");
  const omit = (hub, error) => {
    if (hub.required || ![403, 404].includes(error.status) || error.rateLimited || error.cancelled) { esi.limiter.stop(error); throw error; }
    omittedHubs.push({ id: hub.id, name: hub.name, reason: error.status === 403 ? "access-denied" : "not-found", status: error.status });
    report({ message: `${hub.name} unavailable (${error.status}); continuing with the remaining hubs.` });
  };
  for (const [index, hub] of structures.entries()) {
    try {
      const info = (await esi.get(`/universe/structures/${hub.locationId}`, { authenticated: true })).body;
      if (!Number.isSafeInteger(info.solar_system_id)) throw new Error("ESI structure identity could not be verified.");
      const system = (await esi.get(`/universe/systems/${info.solar_system_id}`)).body;
      if (hub.expectedSystem && system.name !== hub.expectedSystem) throw new Error(`Configured ${hub.name} structure is not in ${hub.expectedSystem}. Check the structure ID.`);
      const constellation = (await esi.get(`/universe/constellations/${system.constellation_id}`)).body;
      if (!Number.isSafeInteger(constellation.region_id)) throw new Error("ESI structure region could not be resolved.");
      definitions.push({ ...hub, regionId: String(constellation.region_id) });
    } catch (error) { omit(hub, error); }
    report({ completed: index + 1 });
  }

  const hubProgress = definitions.map((hub) => ({ id: hub.id, name: hub.name, completed: 0, total: null, page: 1, ordersReceived: 0, done: false }));
  const reportBooks = () => report({ phase: "orders", message: `Collecting ${definitions.length} enabled hubs · at most 3 ESI requests in flight, 2 pages per hub…`, hubTotal: definitions.length,
    hubs: hubProgress.map((hub) => ({ ...hub })), hubsCompleted: hubProgress.filter((hub) => hub.done).length,
    completed: hubProgress.reduce((sum, hub) => sum + hub.completed, 0),
    total: hubProgress.every((hub) => hub.total !== null) ? hubProgress.reduce((sum, hub) => sum + hub.total, 0) : null,
    ordersReceived: hubProgress.reduce((sum, hub) => sum + hub.ordersReceived, 0), unit: "pages" });
  reportBooks();
  const collected = await mapConcurrent(definitions, 3, async (hub, index) => {
    try {
      const book = await esi.bookSummary(hub.id === "jita" ? `/markets/${hub.regionId}/orders?order_type=all` : `/markets/structures/${hub.locationId}`,
        hub.kind === "structure", (page) => { Object.assign(hubProgress[index], page); reportBooks(); }, hub.locationId);
      hubProgress[index].done = true; reportBooks();
      return { id: hub.id, name: hub.name, locationId: hub.locationId, regionId: hub.regionId,
        observedAt: book.observedAt, competitionAsOf: book.competitionAsOf, quotes: book.quotes };
    } catch (error) { omit(hub, error); hubProgress[index].done = true; hubProgress[index].unavailable = true; reportBooks(); return null; }
  });
  const books = collected.filter(Boolean);

  const typeIds = selectSampleTypes(books, config.typeLimit);
  if (!typeIds.length) throw new Error("The configured books contain no candidate types. Previous snapshot retained.");
  const metadata = new Map();
  report({ phase: "metadata", message: "Resolving names and volumes from the local SDE catalog…", completed: 0, total: typeIds.length, unit: "types" });
  for (const id of typeIds) {
    const item = catalog.types[String(id)];
    if (!item) throw new Error(`Type ${id} is missing from the SDE catalog. Run npm run backend:catalog to check for an update. Previous snapshot retained.`);
    metadata.set(id, { name: item.name, packaged_volume: item.packagedVolumeM3, volume: item.volumeM3 });
    report({ completed: metadata.size });
  }
  report({ phase: "publishing", message: "Building and validating the active-hub snapshot…", completed: 0, total: null, unit: "steps" });
  onMetrics({ quoteNetwork: esi.metrics, quoteRequests: { ...esi.statistics }, quoteDurationMs: Math.round(performance.now() - started), omittedHubs });
  const snapshot = validateSnapshot({ schemaVersion: 1, mode: "live", generatedAt: now().toISOString(),
    omittedHubs, scope: { typeLimit: config.typeLimit, historyLimit: 0 },
    statistics: { durationMs: Math.round(performance.now() - started), ...esi.statistics },
    hubs: books.map(({ quotes, ...hub }) => ({ ...hub, rows: rowsFromQuotes(quotes, typeIds, metadata, new Map()) })) });
  try { return await attachHistory(snapshot, directory); }
  catch (error) { onMetrics({ historySummaryError: error.message }); return snapshot; }
}
