/// <reference types="vite/client" />

import "./TableDataPage.css";
import { FC, useState } from "react";
import { ImportRow } from "@sharedTypes/importRow.ts";

const BASE_TAX = 0.0537;
const RELIST_TAX_PER = 0.003;
const IMPORT_FEE_MULTIPLIER = 1.2; // Represents the import cost increase from 1000/m3 to 1200/m3

type DerivedRow = ImportRow & {
  adjustedImportPrice: number;
  unitProfit: number;
  weekProfit: number;
  pricePerM3: number;

  // new normalized scores:
  weeklySizeMoved: number,
  volScore: number;         // 0–1, more weeklySizeMoved = better
  profitScore: number;      // 0–1, more weekProfit = better
  transportProfitabilityScore: number; // -1..1, higher = better filler (low ISK/m³)
  fillerScore: number;      // weighted combo of the three
};

function computeDerivedRow(row: ImportRow, relistCount: number): DerivedRow {
  const feeOld = row.importPrice - row.jitaPrice;
  const feeNew = feeOld * IMPORT_FEE_MULTIPLIER;
  const adjustedImportPrice = row.jitaPrice + feeNew;

  const taxRate = BASE_TAX + relistCount * RELIST_TAX_PER;
  const saleNet = row.cjPrice * (1 - taxRate);

  const unitProfit = saleNet - adjustedImportPrice;
  const weekProfit = unitProfit * row.weekVolume;

  const size = feeOld > 0 ? feeOld / 1000 : 0; // m³ per unit
  const weeklySizeMoved = size * row.weekVolume; // weekly m³ moved
//  const fillerScore = weeklySizeMoved + PROFIT_WEIGHT * weekProfit;

  const pricePerM3 = row.jitaPrice / size;

  return {
    ...row,
    adjustedImportPrice,
    unitProfit,
    weekProfit,
    pricePerM3,
    weeklySizeMoved,
    volScore: 0,
    profitScore: 0,
    transportProfitabilityScore: 0,
    fillerScore: 0,
  };
}

const FILLER_WEIGHT_VOL = 0.4;
const FILLER_WEIGHT_PROFIT = 0.3;
const FILLER_WEIGHT_CHEAP = 0.3;

const T = 50_000;
const THIGH = 170_000; // tweakable

// Compute a transport-based profitability score from price per m³.
// Returns roughly -1..1: 1 = ideal filler (very cheap per m³), 0 = breakpoint, negative = too valuable
function computeTransportProfitabilityScore(pricePerM3: number): number {
  if (!Number.isFinite(pricePerM3) || pricePerM3 <= 0) {
    return 1; // treat invalid values as safe filler
  }

  if (pricePerM3 <= T) {
    return 1; // cheap, ideal filler
  }

  if (pricePerM3 <= THIGH) {
    // simple linear drop from 1 at T to 0 at THIGH
    return 1 - (pricePerM3 - T) / (THIGH - T);
  }

  // Above THIGH: make it negative, capped in [-1, 0)
  const ratio = pricePerM3 / THIGH;
  const penalty = Math.log10(ratio); // grows slowly even for crazy values
  return -Math.min(1, penalty);
}


function computeFillerScores(rows: DerivedRow[]): DerivedRow[] {
  if (rows.length === 0) return rows;


  // 1) Find min/max for each metric
  let minVol = Infinity, maxVol = -Infinity;
  let maxPositiveProfit = 0;
  let maxLossMagnitude = 0;

  for (const r of rows) {
    // weeklySizeMoved
    if (r.weeklySizeMoved < minVol) minVol = r.weeklySizeMoved;
    if (r.weeklySizeMoved > maxVol) maxVol = r.weeklySizeMoved;

    if (r.weekProfit > 0) {
      maxPositiveProfit = Math.max(maxPositiveProfit, r.weekProfit);
    } else if (r.weekProfit < 0) {
      maxLossMagnitude = Math.max(maxLossMagnitude, Math.abs(r.weekProfit));
    }
  }

  const volRange = maxVol - minVol || 1;

  // 2) Produce a new array with normalized scores + fillerScore
  return rows.map((r) => {
    // normalize volume: more is better
    const volScore =
      volRange === 0
        ? 0.5
        : (r.weeklySizeMoved - minVol) / volRange;

    let profitScore = 0;
    if (r.weekProfit >= 0) {
      profitScore =
        maxPositiveProfit === 0 ? 0 : r.weekProfit / maxPositiveProfit;
    } else {
      const lossMagnitude = Math.abs(r.weekProfit);
      profitScore =
        maxLossMagnitude === 0 ? 0 : -(lossMagnitude / maxLossMagnitude);
    }

    const transportProfitabilityScore = computeTransportProfitabilityScore(r.pricePerM3); // -1..1

    const baseScore =
      FILLER_WEIGHT_VOL * volScore +
      FILLER_WEIGHT_PROFIT * profitScore;

    let fillerScore = baseScore * transportProfitabilityScore;

    // If both baseScore and transportProfitabilityScore are negative, make fillerScore negative
    if (baseScore < 0 && transportProfitabilityScore < 0) {
      fillerScore = -fillerScore;
    }

    return {
      ...r,
      volScore,
      profitScore,
      transportProfitabilityScore,
      fillerScore,
    };
  });
}


export const TableDataPage: FC = () => {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [nextId, setNextId] = useState(1);

  const [sortBy, setSortBy] = useState<keyof DerivedRow | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [relistCount, setRelistCount] = useState(0);

  const clearRows = () => setRows([]);

  const sortByValueDesc = () =>
    setRows(prev => [...prev].sort((a, b) => b.weekMarkupISK - a.weekMarkupISK));

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
  const loadFromBackendJson = async () => {
    const res = await fetch(`${API_BASE_URL}/api/scrape-json`);
    const data: { ok: boolean; rows?: ImportRow[]; error?: string } = await res.json();
    if (!data.ok || !data.rows) {
      console.error("Backend error:", data.error);
      return;
    }

    setRows(data.rows);
    setNextId(data.rows.length + 1);
  };

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

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={sortByValueDesc} className="btn">Sort by Value ↓</button>
        <button onClick={clearRows} className="btn">Clear</button>
        <button onClick={loadFromBackendJson} className="btn">Load from Backend JSON</button>
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

      <table className="table-data">
        <thead>
          <tr>
            <th>ID</th>
            <th onClick={() => handleSort("itemName")}>Item {renderSortIcon("itemName")}</th>
            <th onClick={() => handleSort("weekVolume")}>Wk Volume {renderSortIcon("weekVolume")}</th>
            <th onClick={() => handleSort("jitaPrice")}>Jita Price {renderSortIcon("jitaPrice")}</th>
            <th onClick={() => handleSort("cjPrice")}>C-J6MT Price {renderSortIcon("cjPrice")}</th>
            <th onClick={() => handleSort("markupPercent")}>Goonmetrics Markup % {renderSortIcon("markupPercent")}</th>
            <th onClick={() => handleSort("weekMarkupISK")}>Goonmetrics Wk Profit {renderSortIcon("weekMarkupISK")}</th>
            <th onClick={() => handleSort("adjustedImportPrice")}>Adj Import {renderSortIcon("adjustedImportPrice")}</th>
            <th onClick={() => handleSort("weekProfit")}>After-Expense Week Profit {renderSortIcon("weekProfit")}</th>
            <th onClick={() => handleSort("fillerScore")}>Filler Score {renderSortIcon("fillerScore")}</th>
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
              <td>{formatNumber(r.cjPrice)}</td>
              <td>{r.markupPercent.toFixed(2)}%</td>
              <td>{formatNumber(r.weekMarkupISK)}</td>
              <td>{formatNumber(r.adjustedImportPrice)}</td>
              <td>{formatNumber(r.weekProfit)}</td>
              <td>{formatNumber(r.fillerScore)}</td>
              <td>{formatNumber(r.pricePerM3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
