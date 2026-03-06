import { sortTradeRows } from "./tradeSorting.ts";
import type { DerivedTradeRow } from "./tradeCalculations.ts";

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

function createDerivedRow(overrides: Partial<DerivedTradeRow> = {}): DerivedTradeRow {
  return {
    id: 1,
    itemName: "Item B",
    weekVolume: 10,
    jitaPrice: 1000,
    itemVolumeM3: 2,
    cjPrice: 4000,
    markupPercent: 0,
    weekMarkupISK: 5000,
    orderType: "sell",
    transportCost: 2400,
    acquisitionPrice: 1000,
    destinationPrice: 4000,
    landedCost: 3400,
    unitProfit: 385.2,
    weekProfit: 3852,
    afterExpenseMarginPercent: 11.3294,
    acquisitionPricePerM3: 500,
    weeklySizeMoved: 20,
    volScore: 50,
    profitScore: 50,
    transportProfitabilityScore: 100,
    fillerScore: 55,
    ...overrides,
  };
}

Deno.test("sortTradeRows sorts numeric fields descending by default", () => {
  const rows = [
    createDerivedRow({ id: 1, weekProfit: 100 }),
    createDerivedRow({ id: 2, weekProfit: 500 }),
    createDerivedRow({ id: 3, weekProfit: 300 }),
  ];

  const sorted = sortTradeRows(rows, "weekProfit", "desc");
  assertEqual(sorted[0].id, 2, "highest weekly profit should come first in descending order");
  assertEqual(sorted[2].id, 1, "lowest weekly profit should come last in descending order");
});

Deno.test("sortTradeRows sorts strings ascending", () => {
  const rows = [
    createDerivedRow({ id: 1, itemName: "Zeta" }),
    createDerivedRow({ id: 2, itemName: "Alpha" }),
    createDerivedRow({ id: 3, itemName: "Gamma" }),
  ];

  const sorted = sortTradeRows(rows, "itemName", "asc");
  assertEqual(sorted[0].id, 2, "alphabetically first item should come first");
  assertEqual(sorted[2].id, 1, "alphabetically last item should come last");
});

Deno.test("sortTradeRows returns the original array when no sort key is active", () => {
  const rows = [
    createDerivedRow({ id: 1 }),
    createDerivedRow({ id: 2 }),
  ];

  const sorted = sortTradeRows(rows, null, "desc");
  assertEqual(sorted, rows, "unsorted rows should preserve identity for memoized callers");
});
