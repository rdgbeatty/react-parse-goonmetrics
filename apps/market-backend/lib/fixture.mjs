import { HUBS, validateSnapshot } from "../../../packages/shared/src/marketSnapshot.mjs";

const EXAMPLES = ["Tritanium", "Pyerite", "Mexallon", "Isogen", "Nocxium", "Zydrine", "Megacyte", "Morphite", "Damage Control II", "Nanite Repair Paste"];

export function createFixture(count = 20_000, now = new Date()) {
  const generatedAt = now.toISOString();
  return validateSnapshot({ schemaVersion: 1, mode: "fixture", generatedAt,
    scope: { typeLimit: count, historyLimit: count }, statistics: { durationMs: 0, requests: 0, cacheHits: 0 },
    hubs: HUBS.map((hub, index) => ({ ...hub, locationId: `fixture-${hub.id}`, regionId: `fixture-region-${index}`,
      observedAt: generatedAt, rows: Array.from({ length: count }, (_, i) => {
        const base = 50 + ((i * 7919) % 5_000_000) / 100;
        const sell = Math.round(base * (index ? 0.85 + ((i * (index + 3)) % 100) / 100 : 1) * 100) / 100;
        return { typeId: String(2_000_000 + i), itemName: EXAMPLES[i] ?? `Synthetic item ${String(i + 1).padStart(5, "0")}`,
          buy: i % 19 === 0 ? null : Math.round(sell * 0.87 * 100) / 100,
          sell: i % 37 === index + 1 ? null : sell, buyUnits: (i * 17 + 100) % 5000,
          sellUnits: (i * 31 + 500) % 10000, volumeM3: i % 113 === 0 ? null : [0.01, 0.1, 1, 5, 10, 50][i % 6],
          regionalWeekVolume: i % 29 === 0 ? null : (i * (index + 7) + 1) % 9000,
          regionalFortnightVolume: i % 29 === 0 ? null : ((i * (index + 7) + 1) % 9000) * 2 };
      }) })) });
}
