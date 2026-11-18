import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const QUOTE_COLUMNS = ["hub", "type", "bid", "ask", "buyUnits", "sellUnits", "askOrders", "recentAskOrders", "recentAskUnits", "recentAskOriginalUnits", "unknownIssuedOrders"];
export const HISTORY_COLUMNS = ["region", "type", "day", "volume", "average", "highest", "lowest", "orderCount"];
export function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
export function durable(path, bytes) {
  const temp = `${path}.tmp`, fd = openSync(temp, "w");
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export function sourceItems(input) {
  const catalog = readJson(join(input, "catalog-input.json")), fixture = readJson(join(input, "fixture.json"));
  return fixture.selectedTypeIds.map((id) => { const item = catalog.types[id]; return [id, item.name, item.packagedVolumeM3 ?? item.volumeM3 ?? 1]; });
}
export function sourceQuotes(input, items, now) {
  const indexes = new Map(items.map((item, index) => [item[0], index]));
  const output = Array.from({ length: items.length * 3 }, (_, i) => [Math.floor(i / items.length), i % items.length, null, null, 0, 0, 0, 0, 0, 0, 0]);
  for (const [hub, orders] of readJson(join(input, "orders-input.json")).entries()) {
    const seen = new Set();
    for (const order of orders) {
      if (seen.has(order.order_id)) continue; seen.add(order.order_id);
      const index = indexes.get(order.type_id); if (index === undefined || !order.volume_remain) continue;
      const row = output[hub * items.length + index];
      if (order.is_buy_order) { row[2] = row[2] === null ? order.price : Math.max(row[2], order.price); row[4] += order.volume_remain; }
      else {
        row[3] = row[3] === null ? order.price : Math.min(row[3], order.price); row[5] += order.volume_remain; row[6]++;
        const issued = Date.parse(order.issued), age = Date.parse(now) - issued;
        if (!Number.isFinite(issued) || age < 0) row[10]++;
        else if (age <= 86_400_000) { row[7]++; row[8] += order.volume_remain; row[9] += order.volume_total; }
      }
    }
  }
  return output;
}
export function sourceHistory(input, items, now, updated) {
  const indexes = new Map(items.map((item, index) => [item[0], index]));
  const end = (Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) / 86_400_000 - 1 + (updated ? 1 : 0)) * 86_400_000;
  const output = [];
  for (const series of readJson(join(input, updated ? "history-update.json" : "history-input.json"))) {
    const index = indexes.get(series.type_id); if (index === undefined) continue;
    for (const day of series.history) {
      const offset = Math.round((end - Date.parse(day.date)) / 86_400_000);
      if (offset >= 0 && offset < 21) output.push([series.region, index, Math.round(Date.parse(day.date) / 86_400_000), day.volume, day.average, day.highest, day.lowest, day.order_count]);
    }
  }
  return output;
}
export function summarize(history, typeCount, asOfDay) {
  const rows = Array.from({ length: typeCount * 3 }, (_, i) => [Math.floor(i / typeCount), i % typeCount, 0, 0, 0, 0]);
  for (const [region, type, day, volume] of history) {
    const age = asOfDay - day;
    const row = rows[region * typeCount + type];
    if (age >= 0 && age < 7) { row[2] += volume; row[4]++; }
    if (age >= 0 && age < 14) { row[3] += volume; row[5]++; }
  }
  return rows.map(([region, type, seven, fourteen, n7, n14]) => [region, type, n7 === 7 ? seven : null, n14 === 14 ? fourteen : null]);
}
export function publish(items, quotes, summaries) { return { schemaVersion: 2, items, quotes, summaries }; }
export function stateBytes(directory, files) { return files.reduce((sum, file) => sum + statSync(join(directory, file)).size, 0); }
