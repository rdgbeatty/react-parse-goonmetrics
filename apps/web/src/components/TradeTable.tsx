import { FC, useState } from "react";
import { OrderType } from "@sharedTypes/importRow.ts";
import { DataSourceToggle, type DataSource } from "./DataSourceToggle";
import { OrderTypeToggle } from "./OrderTypeToggle";
import { useScrapedRows } from "../hooks/useScrapedRows";
import { TRADE_ROUTE_CONFIG, type TradeRoute } from "../lib/tradeModes";
import { computeTradeRows, type DerivedTradeRow } from "../lib/tradeCalculations";
import { formatMarketPrice } from "../lib/marketPriceFormatting";
import "./TradeTable.css";

type SortKey = keyof Pick<
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

type TradeTableProps = {
  route: TradeRoute;
};

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

export const TradeTable: FC<TradeTableProps> = ({ route }) => {
  const routeConfig = TRADE_ROUTE_CONFIG[route];
  const [orderType, setOrderType] = useState(OrderType.SELL);
  const [dataSource, setDataSource] = useState<DataSource>("top500");
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [relistCount, setRelistCount] = useState(0);
  const { rows, loading, error } = useScrapedRows(orderType, dataSource);

  const displayRows = sortRows(computeTradeRows(rows, relistCount, route), sortBy, sortDir);

  const handleSort = (column: SortKey) => {
    if (sortBy === column) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }

    setSortBy(column);
    setSortDir(column === "itemName" ? "asc" : "desc");
  };

  const renderSortIcon = (column: SortKey) => {
    if (sortBy !== column) return null;
    return sortDir === "asc" ? "▲" : "▼";
  };

  return (
    <div>
      <h1 className="page-title">{routeConfig.pageTitle}</h1>
      <p className="muted page-subtitle">{routeConfig.pageDescription}</p>

      <div className="trade-controls">
        <OrderTypeToggle value={orderType} onChange={setOrderType} />
        <DataSourceToggle value={dataSource} onChange={setDataSource} />
      </div>

      <div className="relist-controls">
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

      {error ? (
        <div className="table-message error-message">{error}</div>
      ) : loading ? (
        <div className="loading-container">
          <div className="loading-spinner" />
          <span className="loading-text">
            Loading {routeConfig.loadingLabel} using Jita {orderType} orders...
          </span>
        </div>
      ) : (
        <table className="table-data">
          <thead>
            <tr>
              <th onClick={() => handleSort("id")}>ID {renderSortIcon("id")}</th>
              <th onClick={() => handleSort("itemName")}>Item {renderSortIcon("itemName")}</th>
              <th onClick={() => handleSort("weekVolume")}>Wk Volume {renderSortIcon("weekVolume")}</th>
              <th onClick={() => handleSort("acquisitionPrice")}>
                {routeConfig.acquisitionLabel} {renderSortIcon("acquisitionPrice")}
              </th>
              <th onClick={() => handleSort("landedCost")}>Import Cost {renderSortIcon("landedCost")}</th>
              <th onClick={() => handleSort("destinationPrice")}>
                {routeConfig.destinationLabel} {renderSortIcon("destinationPrice")}
              </th>
              <th onClick={() => handleSort("afterExpenseMarginPercent")}>
                After-Expense Margin % {renderSortIcon("afterExpenseMarginPercent")}
              </th>
              {dataSource === "top500" && (
                <th onClick={() => handleSort("weekMarkupISK")}>
                  Goonmetrics Wk Profit {renderSortIcon("weekMarkupISK")}
                </th>
              )}
              <th onClick={() => handleSort("weekProfit")}>
                After-Expense Wk Profit {renderSortIcon("weekProfit")}
              </th>
              <th onClick={() => handleSort("fillerScore")}>
                Filler Score {renderSortIcon("fillerScore")} <FillerScoreTooltip />
              </th>
              <th onClick={() => handleSort("acquisitionPricePerM3")}>
                Acquisition Price Per M3 {renderSortIcon("acquisitionPricePerM3")}
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td className="left-align">{row.itemName}</td>
                <td>{formatNumber(row.weekVolume)}</td>
                <td>{formatMarketPrice(row.acquisitionPrice)}</td>
                <td>{formatMarketPrice(row.landedCost)}</td>
                <td>{formatMarketPrice(row.destinationPrice)}</td>
                <td>{row.afterExpenseMarginPercent.toFixed(2)}%</td>
                {dataSource === "top500" && <td>{formatWholeNumber(row.weekMarkupISK)}</td>}
                <td>{formatWholeNumber(row.weekProfit)}</td>
                <td>{formatNumber(row.fillerScore)}</td>
                <td>{formatWholeNumber(row.acquisitionPricePerM3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

function sortRows(
  rows: DerivedTradeRow[],
  sortBy: SortKey | null,
  sortDir: "asc" | "desc",
): DerivedTradeRow[] {
  const sortedRows = [...rows];
  if (!sortBy) {
    return sortedRows;
  }

  sortedRows.sort((left, right) => {
    const leftValue = left[sortBy];
    const rightValue = right[sortBy];

    if (typeof leftValue === "string" && typeof rightValue === "string") {
      const comparison = leftValue.localeCompare(rightValue);
      return sortDir === "asc" ? comparison : -comparison;
    }

    const comparison = Number(leftValue) - Number(rightValue);
    return sortDir === "asc" ? comparison : -comparison;
  });

  return sortedRows;
}

function formatNumber(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatWholeNumber(value: number) {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
}
