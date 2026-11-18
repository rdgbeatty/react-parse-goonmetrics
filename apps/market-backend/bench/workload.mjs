import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_STATE } from "../lib/paths.mjs";
import { loadCatalog } from "../lib/catalog.mjs";

// Fixtures are local, temporary and deterministic. No network or character grant is read.
export async function generateWorkload(directory, typeCount = 20_000, sourceDays = 24) {
  await mkdir(directory, { recursive: true });
  let catalog, catalogSource = "synthetic", snapshot;
  try { catalog = (await loadCatalog(DEFAULT_STATE)).catalog; catalogSource = "installed CCP SDE"; } catch { /* Portable synthetic fallback. */ }
  try { snapshot = JSON.parse(await readFile(join(DEFAULT_STATE, "public/data/market.json"), "utf8")); } catch { /* Portable fixture. */ }
  const definitions = snapshot?.hubs?.map((hub) => ({ id: hub.id, locationId: hub.locationId, regionId: hub.regionId })) ??
    [{ id: "jita", locationId: "60003760", regionId: "10000002" }, { id: "tortuga", locationId: "1056332656965", regionId: "10000030" }, { id: "cj6mt", locationId: "1049588174021", regionId: "10000009" }];
  const now = snapshot?.generatedAt ?? "2026-11-07T15:00:00.000Z";
  const date = new Date(now), asOfDay = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000) - 1;
  const ids = Object.keys(catalog?.types ?? {}).filter((id) => catalog.types[id].published && catalog.types[id].marketGroupId !== null).map(Number).sort((a, b) => a - b).slice(0, typeCount);
  while (ids.length < typeCount) ids.push(2_000_000 + ids.length);
  const selected = new Set(ids);
  const items = ids.map((id) => { const item = catalog?.types[id]; return { type_id: id, name: item?.name ?? `Benchmark item ${id}`,
    packaged_volume: item?.packagedVolumeM3 ?? item?.volumeM3 ?? 1 }; });
  const books = definitions.map(() => []), seen = new Set();
  let capturedOrders = 0;
  try {
    for (const name of await readdir(join(DEFAULT_STATE, "cache"))) {
      if (!name.endsWith(".json")) continue;
      const entry = JSON.parse(await readFile(join(DEFAULT_STATE, "cache", name), "utf8"));
      if (!Array.isArray(entry.body) || !entry.body[0]?.order_id) continue;
      for (const order of entry.body) {
        const hub = definitions.findIndex((definition) => definition.locationId === String(order.location_id));
        if (hub < 0 || !selected.has(order.type_id) || seen.has(order.order_id)) continue;
        seen.add(order.order_id); books[hub].push(order); capturedOrders++;
      }
    }
  } catch { /* Cache is optional and may have been purged to enforce aggregate-only retention. */ }
  let orderId = 8_000_000_000;
  for (let hub = 0; hub < 3; hub++) {
    const present = new Set(books[hub].map((order) => order.type_id));
    for (let index = 0; index < ids.length; index++) {
      if (present.has(ids[index])) continue;
      // Fill absent type/hub pairs to exercise the 60k-row upper bound, not claim real coverage.
      for (let side = 0; side < 2; side++) books[hub].push({ order_id: ++orderId, type_id: ids[index], location_id: Number(definitions[hub].locationId),
        is_buy_order: side === 0, price: Math.round((100 + index * 1.17) * (1 + hub * 0.12) * (side ? 1 : 0.9) * 100) / 100,
        volume_remain: 100 + index % 900, volume_total: 1000 + index % 900, min_volume: 1, range: "station", duration: 90,
        issued: new Date(Date.parse(now) - (index % 96) * 3_600_000).toISOString() });
    }
  }
  const catalogInput = catalog ?? { schemaVersion: 1, types: Object.fromEntries(items.map((item) => [item.type_id,
    { name: item.name, volumeM3: item.packaged_volume, packagedVolumeM3: item.packaged_volume, groupId: 18, marketGroupId: 1857, published: true }])) };
  let syntheticTypes = 0;
  for (const item of items) if (!catalogInput.types[item.type_id]) {
    catalogInput.types[item.type_id] = { name: item.name, volumeM3: item.packaged_volume, packagedVolumeM3: item.packaged_volume,
      groupId: 18, marketGroupId: 1857, published: true }; syntheticTypes++;
  }
  await writeFile(join(directory, "catalog-input.json"), JSON.stringify(catalogInput));
  await writeFile(join(directory, "orders-input.json"), JSON.stringify(books));
  // API-shaped daily rows. Keep the source-window length explicit; do not pretend this is a full-year feed.
  for (const [filename, corrected] of [["history-input.json", false], ["history-update.json", true]]) {
    const handle = await import("node:fs/promises").then((fs) => fs.open(join(directory, filename), "w"));
    await handle.write("["); let first = true;
    for (let region = 0; region < 3; region++) for (let index = 0; index < ids.length; index++) {
      const rows = [];
      for (let offset = 0; offset < sourceDays; offset++) {
        const day = asOfDay + (corrected ? 1 : 0) - offset;
        if (index % 97 === 0 && day === asOfDay - 3) continue; // Stable unknown day across refreshes.
        const date = new Date(day * 86_400_000).toISOString().slice(0, 10);
        rows.push({ date, volume: 10 + index % 200 + region * 5 + (corrected && offset < 3 ? 7 : 0),
          average: 1000 + index * 2.25, highest: 1100 + index * 2.25, lowest: 900 + index * 2.25, order_count: 1 + index % 50 });
      }
      await handle.write(`${first ? "" : ","}${JSON.stringify({ region, type_id: ids[index], history: rows })}`); first = false;
    }
    await handle.write("]"); await handle.close();
  }
  const manifest = { typeCount, selectedTypeIds: ids, syntheticTypes, sourceDays, retainedDays: 21, now, asOfDay, definitions, catalogSource, capturedOrders,
    syntheticOrders: books.reduce((sum, book) => sum + book.length, 0) - capturedOrders,
    orderCount: books.reduce((sum, book) => sum + book.length, 0), historySeries: typeCount * 3,
    retainedHistoryRows: typeCount * 3 * 21 - Math.ceil(typeCount / 97) * 3 };
  await writeFile(join(directory, "fixture.json"), JSON.stringify(manifest));
  return manifest;
}

if (process.argv[1]?.endsWith("workload.mjs")) console.log(JSON.stringify(await generateWorkload(process.argv[2], Number(process.argv[3] ?? 20_000), Number(process.argv[4] ?? 24))));
