import type { DerivedTradeRow } from "./tradeCalculations";

export type SortDirection = "asc" | "desc";

export type SortKey = keyof Pick<
  DerivedTradeRow,
  | "id"
  | "itemName"
  | "weekVolume"
  | "acquisitionPrice"
  | "landedCost"
  | "destinationPrice"
  | "afterExpenseMarginPercent"
  | "weekMarkupISK"
  | "weekProfit"
  | "fillerScore"
  | "acquisitionPricePerM3"
>;

export function sortTradeRows(
  rows: DerivedTradeRow[],
  sortBy: SortKey | null,
  sortDir: SortDirection,
): DerivedTradeRow[] {
  if (!sortBy) {
    return rows;
  }

  const sortedRows = [...rows];
  sortedRows.sort((left, right) => compareRows(left, right, sortBy, sortDir));
  return sortedRows;
}

function compareRows(
  left: DerivedTradeRow,
  right: DerivedTradeRow,
  sortBy: SortKey,
  sortDir: SortDirection,
): number {
  const leftValue = left[sortBy];
  const rightValue = right[sortBy];

  if (typeof leftValue === "string" && typeof rightValue === "string") {
    const comparison = leftValue.localeCompare(rightValue);
    return sortDir === "asc" ? comparison : -comparison;
  }

  const comparison = Number(leftValue) - Number(rightValue);
  return sortDir === "asc" ? comparison : -comparison;
}
