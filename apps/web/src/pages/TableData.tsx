/// <reference types="vite/client" />

import "./TableDataPage.css";
import { FC, useState, useEffect } from "react";
import { ImportRow, OrderType } from "@sharedTypes/importRow.ts";
import { OrderTypeToggle } from "../components/OrderTypeToggle";
import { DataSourceToggle, type DataSource } from "../components/DataSourceToggle";

// Tooltip component for displaying filler score formula
const FillerScoreTooltip: FC = () => {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <span
      className="filler-score-tooltip-wrapper"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span className="filler-score-tooltip-icon">ⓘ</span>
      {showTooltip && (
        <div className="filler-score-tooltip-content">
          {`Filler Score Formula

Score = (80% × Volume) + (10% × Profit) + (10% × Transport)

Components:
• Volume: 0-100 (percentile of m³ moved weekly)
• Profit: -100 to 100 (percentile of weekly profit)
• Transport: 100 to -50 (cost efficiency per m³)

Transport Tiers (Diminishing Returns):
  Excellent (100): < 50k ISK/m³
  Good (70): 50k-100k ISK/m³
  Fair (40): 100k-150k ISK/m³
  Poor (10): 150k-170k ISK/m³
  ─── Breakeven at 170k ISK/m³ ───
  Worthless (-50): > 170k ISK/m³

Score Range: -15 to 100
Higher scores = better filler candidates`}
        </div>
      )}
    </span>
  );
};

const BASE_TAX = 0.0537;
const RELIST_TAX_PER = 0.003;
const IMPORT_FEE_MULTIPLIER = 1.2; // Represents the import cost increase from 1000/m3 to 1200/m3

type DerivedRow = ImportRow & {
  adjustedImportPrice: number;
  unitProfit: number;
  weekProfit: number;
  afterExpenseMarkupPercent: number;
  pricePerM3: number;

  // percentile-based scores:
  weeklySizeMoved: number,
  volScore: number;         // 0-100 percentile, more weeklySizeMoved = higher score
  profitScore: number;      // -100 to 100 percentile, positive profit = positive score
  transportProfitabilityScore: number; // 100 to -50 tier-based, <170k ISK/m³ breakeven
  fillerScore: number;      // -15 to 100, weighted additive formula (80% vol, 10% profit, 10% transport)
};

function computeDerivedRow(row: ImportRow, relistCount: number): DerivedRow {
  const feeOld = row.importPrice - row.jitaPrice;

  // When feeOld <= 0 (no meaningful shipping fee), fall back to raw importPrice
  const adjustedImportPrice = feeOld > 0
    ? row.jitaPrice + feeOld * IMPORT_FEE_MULTIPLIER
    : row.importPrice;

  const taxRate = BASE_TAX + relistCount * RELIST_TAX_PER;
  const saleNet = row.cjPrice * (1 - taxRate);

  const unitProfit = saleNet - adjustedImportPrice;
  const weekProfit = unitProfit * row.weekVolume;
  const afterExpenseMarkupPercent = adjustedImportPrice > 0
    ? (unitProfit / adjustedImportPrice) * 100
    : 0;

  const size = feeOld > 0 ? feeOld / 1000 : 0; // m³ per unit
  const weeklySizeMoved = size * row.weekVolume; // weekly m³ moved

  const pricePerM3 = size > 0 ? row.jitaPrice / size : 0;

  return {
    ...row,
    adjustedImportPrice,
    unitProfit,
    weekProfit,
    afterExpenseMarkupPercent,
    pricePerM3,
    weeklySizeMoved,
    volScore: 0,
    profitScore: 0,
    transportProfitabilityScore: 0,
    fillerScore: 0,
  };
}

const FILLER_WEIGHT_VOL = 0.8;
const FILLER_WEIGHT_PROFIT = 0.1;
const FILLER_WEIGHT_CHEAP = 0.1;

// Transport score: 100 to -50 based on price per m³ tiers
// Breakeven at 170k ISK/m³, negative above (worthless filler)
// Diminishing returns curve below breakeven
function computeTransportScore(pricePerM3: number): number {
  if (!Number.isFinite(pricePerM3) || pricePerM3 <= 0) {
    return 100; // treat invalid values as excellent filler
  }

  if (pricePerM3 < 50000) return 100;      // Excellent: < 50k ISK/m³
  if (pricePerM3 < 100000) return 70;      // Good: 50k-100k ISK/m³
  if (pricePerM3 < 150000) return 40;      // Fair: 100k-150k ISK/m³
  if (pricePerM3 < 170000) return 10;      // Poor: 150k-170k ISK/m³ (approaching breakeven)
  return -50;                              // Worthless: > 170k ISK/m³ (strong penalty)
}


function computeFillerScores(rows: DerivedRow[]): DerivedRow[] {
  if (rows.length === 0) return rows;
  if (rows.length === 1) {
    // Single item gets middle percentile scores
    const r = rows[0];
    const transportScore = computeTransportScore(r.pricePerM3);
    const volScore = 50;
    const profitScore = r.weekProfit >= 0 ? 50 : -50;
    const fillerScore =
      FILLER_WEIGHT_VOL * volScore +
      FILLER_WEIGHT_PROFIT * profitScore +
      FILLER_WEIGHT_CHEAP * transportScore;

    return [{
      ...r,
      volScore,
      profitScore,
      transportProfitabilityScore: transportScore,
      fillerScore,
    }];
  }

  // 1) Create sorted indices for volume (ascending - lowest volume = rank 0)
  const volumeIndices = rows
    .map((r, idx) => ({ idx, value: r.weeklySizeMoved }))
    .sort((a, b) => a.value - b.value);

  const volumeRanks = new Map<number, number>();
  volumeIndices.forEach((item, rank) => {
    volumeRanks.set(item.idx, rank);
  });

  // 2) Create sorted indices for profit (ascending - most negative = rank 0)
  const profitIndices = rows
    .map((r, idx) => ({ idx, value: r.weekProfit }))
    .sort((a, b) => a.value - b.value);

  const profitRanks = new Map<number, number>();
  profitIndices.forEach((item, rank) => {
    profitRanks.set(item.idx, rank);
  });

  // 3) Compute percentile scores and filler score for each row
  const total = rows.length;
  return rows.map((r, idx) => {
    // Volume percentile: 0-100 (higher volume = higher score)
    const volumeRank = volumeRanks.get(idx)!;
    const volScore = (volumeRank / (total - 1)) * 100;

    // Profit percentile: -100 to 100
    const profitRank = profitRanks.get(idx)!;
    let profitScore: number;
    if (r.weekProfit >= 0) {
      // Positive profit: map to 0-100
      const profitPercentile = (profitRank / (total - 1)) * 100;
      profitScore = profitPercentile;
    } else {
      // Negative profit: map to -100 to 0
      const profitPercentile = (profitRank / (total - 1)) * 100;
      profitScore = profitPercentile - 100; // shifts from 0-100 to -100 to 0
    }

    // Transport score: 0-100 based on tiers
    const transportScore = computeTransportScore(r.pricePerM3);

    // Final additive formula: -30 to 100 range
    const fillerScore =
      FILLER_WEIGHT_VOL * volScore +
      FILLER_WEIGHT_PROFIT * profitScore +
      FILLER_WEIGHT_CHEAP * transportScore;

    return {
      ...r,
      volScore,
      profitScore,
      transportProfitabilityScore: transportScore,
      fillerScore,
    };
  });
}


export const TableDataPage: FC = () => {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [orderType, setOrderType] = useState<OrderType>(OrderType.SELL);
  const [dataSource, setDataSource] = useState<DataSource>("top500");
  const [loading, setLoading] = useState(true);

  const [sortBy, setSortBy] = useState<keyof DerivedRow | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [relistCount, setRelistCount] = useState(0);

  const computeDisplayRows = (): DerivedRow[] =>  {
    const derivedRows: DerivedRow[] = rows.map((r) =>
      computeDerivedRow(r, relistCount)
    );

//    const scoredRows = computeFillerScores(derivedRows);
    const scoredRows: DerivedRow[] = computeFillerScores(derivedRows);

    const sortedRows = [...scoredRows];
    if(sortBy) {
      if(sortDir === "asc") {
        sortedRows.sort((a,b) => (a[sortBy] as number) - (b[sortBy] as number));
      } else {
        sortedRows.sort((a,b) => (b[sortBy] as number) - (a[sortBy] as number));
      }
    }
    return sortedRows
  };

  const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
  const loadFromBackendJson = async (type: OrderType, source: DataSource) => {
    setLoading(true);
    try {
      const endpoint = source === "top500" ? "/api/scrape-json" : "/api/scrape-marketgroup";
      const res = await fetch(`${API_BASE_URL}${endpoint}?orderType=${type}`);
      const data: { ok: boolean; rows?: ImportRow[]; error?: string } = await res.json();
      if (!data.ok || !data.rows) {
        console.error("Backend error:", data.error);
        return;
      }

      setRows(data.rows);
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setLoading(false);
    }
  };

  // Load data on mount
  useEffect(() => {
    loadFromBackendJson(orderType, dataSource);
  }, []);

  const handleSort = (column: keyof DerivedRow) => {
    if (sortBy === column) {
      // toggle direction
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir("desc"); // default when changing column
    }
  };

  const formatNumber = (value: number) =>
    value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
  });

  const renderSortIcon = (column: keyof DerivedRow) => {
    if (sortBy !== column) return null; // no icon if not current sort col
    return sortDir === "asc" ? "▲" : "▼";
  };

  return (
    <div>
      <h1 className="page-title">Load Data</h1>

      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
        <OrderTypeToggle
          value={orderType}
          onChange={(newType) => {
            setOrderType(newType);
            loadFromBackendJson(newType, dataSource);
          }}
        />
        <DataSourceToggle
          value={dataSource}
          onChange={(newSource) => {
            setDataSource(newSource);
            loadFromBackendJson(orderType, newSource);
          }}
        />
      </div>

      {/* Relist count slider */ }
      <div style={{ marginBottom: "1rem" }}>
        <label>
          Relists: {relistCount}
          <input
            type="range"
            min={0}
            max={5}
            value={relistCount}
            onChange={(e) => setRelistCount(Number(e.target.value))}
            style={{ marginLeft: "0.5rem" }}
          />
        </label>
      </div>

      {loading ? (
        <div className="loading-container">
          <div className="loading-spinner" />
          <span className="loading-text">Loading {orderType} orders...</span>
        </div>
      ) : (
        <table className="table-data">
          <thead>
            <tr>
              <th>ID</th>
              <th onClick={() => handleSort("itemName")}>Item {renderSortIcon("itemName")}</th>
              <th onClick={() => handleSort("weekVolume")}>Wk Volume {renderSortIcon("weekVolume")}</th>
              <th onClick={() => handleSort("jitaPrice")}>Jita Price {renderSortIcon("jitaPrice")}</th>
              <th onClick={() => handleSort("adjustedImportPrice")}>Import {renderSortIcon("adjustedImportPrice")}</th>
              <th onClick={() => handleSort("cjPrice")}>C-J6MT Price {renderSortIcon("cjPrice")}</th>
              <th onClick={() => handleSort("afterExpenseMarkupPercent")}>After-Expense Markup % {renderSortIcon("afterExpenseMarkupPercent")}</th>
              {dataSource === "top500" && <th onClick={() => handleSort("weekMarkupISK")}>Goonmetrics Wk Profit {renderSortIcon("weekMarkupISK")}</th>}
              <th onClick={() => handleSort("weekProfit")}>After-Expense Week Profit {renderSortIcon("weekProfit")}</th>
              <th onClick={() => handleSort("fillerScore")}>Filler Score {renderSortIcon("fillerScore")} <FillerScoreTooltip /></th>
              <th onClick={() => handleSort("pricePerM3")}>Jita Price Per M3 {renderSortIcon("pricePerM3")}</th>
            </tr>
          </thead>
          <tbody>
            {computeDisplayRows().map(r => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td className="left-align">{r.itemName}</td>
                <td>{formatNumber(r.weekVolume)}</td>
                <td>{formatNumber(r.jitaPrice)}</td>
                <td>{formatNumber(r.adjustedImportPrice)}</td>
                <td>{formatNumber(r.cjPrice)}</td>
                <td>{r.afterExpenseMarkupPercent.toFixed(2)}%</td>
                {dataSource === "top500" && <td>{formatNumber(r.weekMarkupISK)}</td>}
                <td>{formatNumber(r.weekProfit)}</td>
                <td>{formatNumber(r.fillerScore)}</td>
                <td>{formatNumber(r.pricePerM3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
