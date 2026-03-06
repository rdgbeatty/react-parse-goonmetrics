import { computeTradeRows, type DerivedTradeRow } from "./tradeCalculations.ts";
import { sortTradeRows, type SortDirection, type SortKey } from "./tradeSorting.ts";
import { TradeRoute } from "./tradeModes.ts";
import { OrderType, type ScrapedRow } from "@sharedTypes/importRow.ts";

type BenchmarkScenario = {
  name: string;
  size: number;
  sortBy: SortKey;
  sortDir: SortDirection;
};

const scenarios: BenchmarkScenario[] = [
  { name: "500 numeric", size: 500, sortBy: "weekProfit", sortDir: "desc" },
  { name: "500 string", size: 500, sortBy: "itemName", sortDir: "asc" },
  { name: "18000 numeric", size: 18000, sortBy: "weekProfit", sortDir: "desc" },
  { name: "18000 string", size: 18000, sortBy: "itemName", sortDir: "asc" },
];

for (const scenario of scenarios) {
  const rows = createBenchmarkRows(scenario.size);
  const relistCount = 2;
  const route = TradeRoute.IMPORTS;
  const derivedRows = computeTradeRows(rows, relistCount, route);

  Deno.bench(`legacy click path | ${scenario.name}`, () => {
    legacyPrepareDisplayRows(rows, relistCount, route, scenario.sortBy, scenario.sortDir);
  });

  Deno.bench(`optimized click path | ${scenario.name}`, () => {
    sortTradeRows(derivedRows, scenario.sortBy, scenario.sortDir);
  });
}

function legacyPrepareDisplayRows(
  rows: ScrapedRow[],
  relistCount: number,
  route: TradeRoute,
  sortBy: SortKey,
  sortDir: SortDirection,
): DerivedTradeRow[] {
  return sortTradeRows(computeTradeRows(rows, relistCount, route), sortBy, sortDir);
}

function createBenchmarkRows(size: number): ScrapedRow[] {
  return Array.from({ length: size }, (_, index) => {
    const id = index + 1;
    const jitaPrice = 1000 + (id % 7000) * 17;
    const itemVolumeM3 = 0.5 + (id % 30) * 0.25;
    const cjPrice = jitaPrice + 1500 + (id % 400) * 13;

    return {
      id,
      itemName: `Item ${String(size - id).padStart(5, "0")}`,
      weekVolume: 10 + (id % 900),
      jitaPrice,
      itemVolumeM3,
      cjPrice,
      markupPercent: 5 + (id % 40),
      weekMarkupISK: 1000 + id * 23,
      orderType: id % 2 === 0 ? OrderType.SELL : OrderType.BUY,
    };
  });
}
