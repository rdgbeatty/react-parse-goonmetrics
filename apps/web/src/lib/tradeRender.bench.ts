import React from "npm:react";
import { renderToStaticMarkup } from "npm:react-dom/server";
import type { DerivedTradeRow } from "./tradeCalculations.ts";
import { getVirtualWindow } from "./tradeVirtualization.ts";

const ROW_HEIGHT_PX = 38;
const VIEWPORT_HEIGHT_PX = 720;
const OVERSCAN_ROWS = 12;
const COLUMN_COUNT = 11;

const rows = createDerivedRows(18000);

Deno.bench("full DOM render path | 18000 rows", () => {
  renderToStaticMarkup(renderTableBody(rows));
});

Deno.bench("virtualized DOM render path | 18000 rows, 31 visible", () => {
  const window = getVirtualWindow(rows.length, 0, VIEWPORT_HEIGHT_PX, ROW_HEIGHT_PX, OVERSCAN_ROWS);
  renderToStaticMarkup(renderVirtualizedTableBody(rows, window.startIndex, window.endIndex));
});

function renderTableBody(displayRows: DerivedTradeRow[]) {
  return React.createElement(
    "table",
    null,
    React.createElement(
      "tbody",
      null,
      ...displayRows.map((row) => renderRow(row)),
    ),
  );
}

function renderVirtualizedTableBody(
  displayRows: DerivedTradeRow[],
  startIndex: number,
  endIndex: number,
) {
  const visibleRows = displayRows.slice(startIndex, endIndex);
  const topSpacerHeight = startIndex * ROW_HEIGHT_PX;
  const bottomSpacerHeight = Math.max(0, (displayRows.length - endIndex) * ROW_HEIGHT_PX);

  return React.createElement(
    "table",
    null,
    React.createElement(
      "tbody",
      null,
      topSpacerHeight > 0 ? renderSpacerRow("top", topSpacerHeight) : null,
      ...visibleRows.map((row) => renderRow(row)),
      bottomSpacerHeight > 0 ? renderSpacerRow("bottom", bottomSpacerHeight) : null,
    ),
  );
}

function renderRow(row: DerivedTradeRow) {
  return React.createElement(
    "tr",
    { key: row.id },
    ...Array.from({ length: COLUMN_COUNT }, (_, index) =>
      React.createElement("td", { key: `${row.id}-${index}` }, `${row.id}-${index}`)),
  );
}

function renderSpacerRow(key: string, height: number) {
  return React.createElement(
    "tr",
    { key },
    React.createElement("td", {
      colSpan: COLUMN_COUNT,
      style: { height: `${height}px`, padding: 0, border: 0 },
    }),
  );
}

function createDerivedRows(size: number): DerivedTradeRow[] {
  return Array.from({ length: size }, (_, index) => ({
    id: index + 1,
    itemName: `Item ${index + 1}`,
    weekVolume: 10 + (index % 900),
    jitaPrice: 1000 + index,
    itemVolumeM3: 2 + (index % 10) * 0.25,
    cjPrice: 3000 + index,
    markupPercent: 5 + (index % 20),
    weekMarkupISK: 5000 + index * 10,
    orderType: "sell",
    transportCost: 2400,
    acquisitionPrice: 1000 + index,
    destinationPrice: 3000 + index,
    landedCost: 3400 + index,
    unitProfit: 400 + (index % 100),
    weekProfit: 20000 + index * 25,
    afterExpenseMarginPercent: 10 + (index % 7),
    acquisitionPricePerM3: 500 + (index % 50),
    weeklySizeMoved: 20 + (index % 100),
    volScore: index % 100,
    profitScore: index % 100,
    transportProfitabilityScore: 100,
    fillerScore: 55 + (index % 10),
  }));
}
