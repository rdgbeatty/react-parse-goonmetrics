import type { ScrapedRow } from "@sharedTypes/importRow.ts";
import { TradeRoute, type TradeRoute as TradeRouteType } from "./tradeModes";

const BASE_TAX = 0.0537;
const RELIST_TAX_PER = 0.003;
const TRANSPORT_FEE_PER_M3 = 1200;

const FILLER_WEIGHT_VOL = 0.8;
const FILLER_WEIGHT_PROFIT = 0.1;
const FILLER_WEIGHT_CHEAP = 0.1;

export type DerivedTradeRow = ScrapedRow & {
  transportCost: number;
  acquisitionPrice: number;
  destinationPrice: number;
  landedCost: number;
  unitProfit: number;
  weekProfit: number;
  afterExpenseMarginPercent: number;
  acquisitionPricePerM3: number;
  weeklySizeMoved: number;
  volScore: number;
  profitScore: number;
  transportProfitabilityScore: number;
  fillerScore: number;
};

export function computeTradeRows(
  rows: ScrapedRow[],
  relistCount: number,
  route: TradeRouteType,
): DerivedTradeRow[] {
  const eligibleRows = rows.filter((row) => isTradableForRoute(row, route));
  const derivedRows = eligibleRows.map((row) => computeDerivedRow(row, relistCount, route));
  return computeFillerScores(derivedRows);
}

export function isTradableForRoute(row: ScrapedRow, route: TradeRouteType): boolean {
  if (route === TradeRoute.EXPORTS) {
    return row.cjPrice > 0;
  }

  return true;
}

function computeDerivedRow(
  row: ScrapedRow,
  relistCount: number,
  route: TradeRouteType,
): DerivedTradeRow {
  const transportCost = row.itemVolumeM3 * TRANSPORT_FEE_PER_M3;
  const acquisitionPrice = route === TradeRoute.IMPORTS ? row.jitaPrice : row.cjPrice;
  const destinationPrice = route === TradeRoute.IMPORTS ? row.cjPrice : row.jitaPrice;
  const taxRate = BASE_TAX + relistCount * RELIST_TAX_PER;
  // TODO: revisit export-specific tax assumptions if Jita sale handling diverges.
  const saleNet = destinationPrice * (1 - taxRate);
  const landedCost = acquisitionPrice + transportCost;
  const unitProfit = saleNet - landedCost;
  const weekProfit = unitProfit * row.weekVolume;
  const afterExpenseMarginPercent = landedCost > 0
    ? (unitProfit / landedCost) * 100
    : 0;
  const weeklySizeMoved = row.itemVolumeM3 * row.weekVolume;
  const acquisitionPricePerM3 = row.itemVolumeM3 > 0
    ? acquisitionPrice / row.itemVolumeM3
    : 0;

  return {
    ...row,
    transportCost,
    acquisitionPrice,
    destinationPrice,
    landedCost,
    unitProfit,
    weekProfit,
    afterExpenseMarginPercent,
    acquisitionPricePerM3,
    weeklySizeMoved,
    volScore: 0,
    profitScore: 0,
    transportProfitabilityScore: 0,
    fillerScore: 0,
  };
}

function computeTransportScore(acquisitionPricePerM3: number): number {
  if (!Number.isFinite(acquisitionPricePerM3) || acquisitionPricePerM3 <= 0) {
    return 100;
  }

  if (acquisitionPricePerM3 < 50000) return 100;
  if (acquisitionPricePerM3 < 100000) return 70;
  if (acquisitionPricePerM3 < 150000) return 40;
  if (acquisitionPricePerM3 < 170000) return 10;
  return -50;
}

function computeFillerScores(rows: DerivedTradeRow[]): DerivedTradeRow[] {
  if (rows.length === 0) return rows;
  if (rows.length === 1) {
    const row = rows[0];
    const transportScore = computeTransportScore(row.acquisitionPricePerM3);
    const volScore = 50;
    const profitScore = row.weekProfit >= 0 ? 50 : -50;
    const fillerScore =
      FILLER_WEIGHT_VOL * volScore +
      FILLER_WEIGHT_PROFIT * profitScore +
      FILLER_WEIGHT_CHEAP * transportScore;

    return [{
      ...row,
      volScore,
      profitScore,
      transportProfitabilityScore: transportScore,
      fillerScore,
    }];
  }

  const volumeIndices = rows
    .map((row, idx) => ({ idx, value: row.weeklySizeMoved }))
    .sort((a, b) => a.value - b.value);
  const volumeRanks = new Map<number, number>();
  volumeIndices.forEach((item, rank) => {
    volumeRanks.set(item.idx, rank);
  });

  const profitIndices = rows
    .map((row, idx) => ({ idx, value: row.weekProfit }))
    .sort((a, b) => a.value - b.value);
  const profitRanks = new Map<number, number>();
  profitIndices.forEach((item, rank) => {
    profitRanks.set(item.idx, rank);
  });

  const total = rows.length;
  return rows.map((row, idx) => {
    const volumeRank = volumeRanks.get(idx) ?? 0;
    const volScore = (volumeRank / (total - 1)) * 100;
    const profitRank = profitRanks.get(idx) ?? 0;
    const profitPercentile = (profitRank / (total - 1)) * 100;
    const profitScore = row.weekProfit >= 0 ? profitPercentile : profitPercentile - 100;
    const transportScore = computeTransportScore(row.acquisitionPricePerM3);
    const fillerScore =
      FILLER_WEIGHT_VOL * volScore +
      FILLER_WEIGHT_PROFIT * profitScore +
      FILLER_WEIGHT_CHEAP * transportScore;

    return {
      ...row,
      volScore,
      profitScore,
      transportProfitabilityScore: transportScore,
      fillerScore,
    };
  });
}
