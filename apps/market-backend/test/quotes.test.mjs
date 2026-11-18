import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateOrders, validateBookSummary } from "../../../packages/shared/src/marketQuotes.mjs";
import { createFixture } from "../lib/fixture.mjs";
import { compareHubs, validateSnapshot } from "../../../packages/shared/src/marketSnapshot.mjs";
import { EsiClient } from "../lib/esi.mjs";
import { removeLegacyOrderCaches } from "../lib/maintenance.mjs";

const NOW = Date.parse("2026-11-07T15:00:00Z");
const order = (id, ageHours, overrides = {}) => ({ order_id: id, type_id: 34, location_id: 123, price: 100,
  volume_remain: 10, volume_total: 20, is_buy_order: false, duration: 90, issued: new Date(NOW - ageHours * 3_600_000).toISOString(), ...overrides });
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "market-quotes-"));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test("competition uses issued time, counts only active asks and retains no raw order fields", () => {
  const quotes = aggregateOrders([order(1, 1), order(2, 24), order(3, 24.01),
    order(4, 1440, { duration: 90 }), order(5, 0, { is_buy_order: true, price: 90 }), order(6, 0, { volume_remain: 0 })], new Date(NOW).toISOString());
  assert.equal(quotes[34].ask, 100); assert.equal(quotes[34].bid, 90);
  assert.deepEqual(quotes[34].competition, { askOrders: 4, recentAskOrders24h: 2, recentAskUnits24h: 20, recentAskOriginalUnits24h: 40, unknownIssuedAskOrders: 0 });
  assert.equal(JSON.stringify(quotes).includes('"order_id"'), false);
  assert.equal(JSON.stringify(quotes).includes('"issued"'), false);
});

test("unknown or future issued times stay unknown; missing original quantity does not invent imports", () => {
  const quotes = aggregateOrders([order(1, -1), order(2, 0, { issued: undefined })], new Date(NOW).toISOString());
  assert.equal(quotes[34].competition.unknownIssuedAskOrders, 2);
  assert.equal(quotes[34].competition.recentAskOrders24h, null);
  const missing = aggregateOrders([order(1, 1, { volume_total: undefined })], new Date(NOW).toISOString());
  assert.equal(missing[34].competition.recentAskUnits24h, 10);
  assert.equal(missing[34].competition.recentAskOriginalUnits24h, null);
});

test("only aggregate books are cached and reused across jobs until ESI expiry", async (t) => {
  const directory = await temporary(t); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify([order(1, 1), order(2, 2, { location_id: 456 })]), { headers: { "Cache-Control": "max-age=60" } }); };
  const client = new EsiClient({ cacheDirectory: directory, now: () => NOW, fetchImpl });
  const summary = await client.bookSummary("/markets/1/orders?order_type=all", false, () => {}, "123");
  assert.equal(summary.quotes[34].competition.askOrders, 1);
  assert.deepEqual(await readdir(directory), ["books"]);
  const [name] = await readdir(join(directory, "books")), path = join(directory, "books", name);
  const stored = await readFile(path, "utf8");
  assert.equal(stored.includes('"order_id"'), false); assert.equal(stored.includes('"volume_total"'), false);
  validateBookSummary(JSON.parse(stored));
  const next = new EsiClient({ cacheDirectory: directory, now: () => NOW + 30_000, fetchImpl });
  const reused = await next.bookSummary("/markets/1/orders?order_type=all", false, () => {}, "123");
  assert.equal(calls, 1); assert.equal(reused.competitionAsOf, summary.competitionAsOf);
  const expired = new EsiClient({ cacheDirectory: directory, now: () => NOW + 61_000, fetchImpl });
  await expired.bookSummary("/markets/1/orders?order_type=all", false, () => {}, "123");
  assert.equal(calls, 2); assert.equal((await readdir(join(directory, "books"))).length, 1);
});

test("legacy cleanup removes only raw order pages, preserving history, aggregates and credentials", async (t) => {
  const directory = await temporary(t); await mkdir(join(directory, "cache/books"), { recursive: true }); await mkdir(join(directory, "private"));
  await writeFile(join(directory, "cache/orders.json"), JSON.stringify({ body: [order(1, 1)] }));
  await writeFile(join(directory, "cache/history.json"), JSON.stringify({ body: [{ date: "2026-11-06", volume: 10 }] }));
  await writeFile(join(directory, "cache/books/current.json"), "{}");
  await writeFile(join(directory, "private/grant.json"), "{}");
  assert.equal((await removeLegacyOrderCaches(directory)).deletedFiles, 1);
  assert.deepEqual((await readdir(join(directory, "cache"))).sort(), ["books", "history.json"]);
  assert.equal(await readFile(join(directory, "private/grant.json"), "utf8"), "{}");
});

test("direct raw market GETs cannot accidentally opt into persistent caching", async (t) => {
  const directory = await temporary(t);
  const client = new EsiClient({ cacheDirectory: directory, now: () => NOW, fetchImpl: async () =>
    new Response(JSON.stringify([order(1, 1)]), { headers: { "Cache-Control": "max-age=60" } }) });
  await client.get("/markets/1/orders/?page=1");
  await client.get("/markets/structures/123?page=1", { authenticated: true });
  assert.deepEqual(await readdir(directory), []);
});

test("arbitrage uses source ask, destination ask, costs and a labeled regional weekly opportunity estimate", () => {
  const snapshot = createFixture(1, new Date(NOW));
  snapshot.hubs[0].rows[0] = { ...snapshot.hubs[0].rows[0], buy: 1, sell: 100, volumeM3: 2 };
  snapshot.hubs[1].rows[0] = { ...snapshot.hubs[1].rows[0], buy: 2, sell: 200, regionalWeekVolume: 70,
    competition: { askOrders: 4, recentAskOrders24h: 2, recentAskUnits24h: 10, recentAskOriginalUnits24h: 20, unknownIssuedAskOrders: 0 } };
  validateSnapshot(snapshot);
  const row = compareHubs(snapshot, "jita", "tortuga", { haul: 10, tax: 5 })[0];
  assert.equal(row.acquisition, 100); assert.equal(row.destinationPrice, 200);
  assert.equal(row.profit, 70); assert.equal(row.estimatedWeekProfit, 4900);
  assert.equal(row.competition.recentAskOrders24h, 2);
  snapshot.hubs[1].rows[0].competition.order_id = 123;
  assert.throws(() => validateSnapshot(snapshot), /unexpected/);
});
