import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceItems, sourceQuotes, sourceHistory, summarize } from "../bench/common.mjs";

test("benchmark source replay preserves zero volume, deduplicates orders and uses completed-day coverage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "market-benchmark-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = "2026-11-07T15:00:00Z", asOf = Math.floor(Date.parse("2026-11-06T00:00:00Z") / 86_400_000);
  await writeFile(join(directory, "fixture.json"), JSON.stringify({ selectedTypeIds: [34], now, asOfDay: asOf }));
  await writeFile(join(directory, "catalog-input.json"), JSON.stringify({ types: { 34: { name: 'Unicode ∆ "item"', packagedVolumeM3: 0, volumeM3: 1 } } }));
  const order = { order_id: 1, type_id: 34, price: 7.5, is_buy_order: false, volume_remain: 10, volume_total: 20, issued: "2026-11-07T14:00:00Z" };
  await writeFile(join(directory, "orders-input.json"), JSON.stringify([[order, order], [], []]));
  const days = Array.from({ length: 24 }, (_, offset) => ({ date: new Date((asOf - offset) * 86_400_000).toISOString().slice(0, 10),
    volume: 10, average: 5, highest: 6, lowest: 4, order_count: 1 }));
  await writeFile(join(directory, "history-input.json"), JSON.stringify([{ region: 0, type_id: 34, history: days }]));
  const items = sourceItems(directory); assert.equal(items[0][2], 0);
  assert.deepEqual(sourceQuotes(directory, items, now)[0], [0, 0, null, 7.5, 0, 10, 1, 1, 10, 20, 0]);
  const history = sourceHistory(directory, items, now, false);
  assert.equal(history.length, 21);
  assert.deepEqual(summarize(history, 1, asOf)[0], [0, 0, 70, 140]);
  assert.deepEqual(summarize(history.slice(1), 1, asOf)[0], [0, 0, null, null]);
});
