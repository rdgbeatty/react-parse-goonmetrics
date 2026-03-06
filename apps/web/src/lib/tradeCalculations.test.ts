import { computeTradeRows } from "./tradeCalculations.ts";
import { TradeRoute } from "./tradeModes.ts";
import { OrderType, type ScrapedRow } from "@sharedTypes/importRow.ts";

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

function createSampleRow(overrides: Partial<ScrapedRow> = {}): ScrapedRow {
  return {
    id: 1,
    itemName: "Test Item",
    weekVolume: 10,
    jitaPrice: 1000,
    itemVolumeM3: 2,
    cjPrice: 4000,
    markupPercent: 0,
    weekMarkupISK: 0,
    orderType: OrderType.SELL,
    ...overrides,
  };
}

Deno.test("computeTradeRows uses Jita as acquisition market for imports", () => {
  const row = computeTradeRows([createSampleRow()], 0, TradeRoute.IMPORTS)[0];

  assertEqual(row.transportCost, 2400, "transportCost should use itemVolumeM3 * 1200");
  assertEqual(row.acquisitionPrice, 1000, "imports should acquire in Jita");
  assertEqual(row.landedCost, 3400, "imports should add transport to Jita acquisition");
  assertEqual(row.destinationPrice, 4000, "imports should sell in C-J6MT");
  assertClose(row.weekProfit, 3852, 0.0001, "imports should compute expected weekly profit");
  assertClose(
    row.afterExpenseMarginPercent,
    11.32941176470589,
    0.0001,
    "imports should compute expected after-expense margin",
  );
  assertEqual(row.fillerScore, 55, "single profitable import row should receive midpoint filler score");
});

Deno.test("computeTradeRows uses C-J6MT as acquisition market for exports", () => {
  const row = computeTradeRows([createSampleRow()], 0, TradeRoute.EXPORTS)[0];

  assertEqual(row.transportCost, 2400, "transportCost should stay route-independent");
  assertEqual(row.acquisitionPrice, 4000, "exports should acquire in C-J6MT");
  assertEqual(row.landedCost, 6400, "exports should add transport to C-J6MT acquisition");
  assertEqual(row.destinationPrice, 1000, "exports should sell in Jita");
  assertClose(row.weekProfit, -54537, 0.0001, "exports should compute expected weekly profit");
  assertClose(
    row.afterExpenseMarginPercent,
    -85.2140625,
    0.0001,
    "exports should compute expected after-expense margin",
  );
  assertEqual(row.fillerScore, 45, "single unprofitable export row should still score transport utility");
});

Deno.test("computeTradeRows keeps transport cost at zero for zero-volume rows", () => {
  const row = computeTradeRows([
    createSampleRow({
      itemVolumeM3: 0,
      jitaPrice: 2000,
      cjPrice: 3000,
    }),
  ], 0, TradeRoute.IMPORTS)[0];

  assertEqual(row.transportCost, 0, "zero-volume items should have no transport cost");
  assertEqual(row.landedCost, 2000, "zero-volume imports should keep landed cost at acquisition only");
  assertEqual(row.acquisitionPricePerM3, 0, "zero-volume items should avoid divide-by-zero transport pricing");
});

Deno.test("computeTradeRows filters zero-price C-J rows from exports", () => {
  const rows = computeTradeRows([
    createSampleRow({ id: 1, itemName: "Unavailable in C-J", cjPrice: 0 }),
    createSampleRow({ id: 2, itemName: "Available in C-J", cjPrice: 5000 }),
  ], 0, TradeRoute.EXPORTS);

  assertEqual(rows.length, 1, "exports should hide rows that are unavailable in C-J");
  assertEqual(rows[0].id, 2, "exports should keep only rows with a real C-J acquisition price");
});
