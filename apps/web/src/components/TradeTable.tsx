import { FC, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { OrderType } from "@sharedTypes/importRow.ts";
import { DataSourceToggle, type DataSource } from "./DataSourceToggle";
import { OrderTypeToggle } from "./OrderTypeToggle";
import { useScrapedRows } from "../hooks/useScrapedRows";
import { useWindowVirtualWindow } from "../hooks/useWindowVirtualWindow";
import { TRADE_ROUTE_CONFIG, type TradeRoute } from "../lib/tradeModes";
import { computeTradeRows, type DerivedTradeRow } from "../lib/tradeCalculations";
import { formatMarketPrice } from "../lib/marketPriceFormatting";
import { sortTradeRows, type SortKey } from "../lib/tradeSorting";
import "./TradeTable.css";

type TradeTableProps = {
  route: TradeRoute;
};

type TradeTableColumn = {
  id: string;
  key: SortKey;
  label: ReactNode;
  preferredWidth: string;
  headerClassName?: string;
  cellClassName?: string;
  renderCell: (row: DerivedTradeRow) => string;
};

const TABLE_VIEWPORT_HEIGHT_PX = 720;
const TRADE_ROW_HEIGHT_PX = 38;
const OVERSCAN_ROWS = 12;

const FillerScoreTooltip: FC = () => {
  return (
    <HeaderInfoTooltip
      content={`Filler Score Formula

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
    />
  );
};

const HeaderInfoTooltip: FC<{ content: string }> = ({ content }) => {
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
          {content}
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
  const [tableBodyTop, setTableBodyTop] = useState(0);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const tableHeadRef = useRef<HTMLTableSectionElement | null>(null);
  const { rows, loading, error } = useScrapedRows(orderType, dataSource);

  const derivedRows = useMemo(
    () => computeTradeRows(rows, relistCount, route),
    [relistCount, route, rows],
  );
  const displayRows = useMemo(
    () => sortTradeRows(derivedRows, sortBy, sortDir),
    [derivedRows, sortBy, sortDir],
  );

  const renderSortIcon = (column: SortKey) => {
    if (sortBy !== column) return null;
    return sortDir === "asc" ? "▲" : "▼";
  };

  const columns = useMemo(
    () => buildColumns(dataSource, routeConfig, renderSortIcon),
    [dataSource, routeConfig, sortBy, sortDir],
  );

  const virtualWindow = useWindowVirtualWindow(
    displayRows.length,
    tableBodyTop,
    TABLE_VIEWPORT_HEIGHT_PX,
    TRADE_ROW_HEIGHT_PX,
    OVERSCAN_ROWS,
  );
  const visibleRows = useMemo(
    () => displayRows.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [displayRows, virtualWindow.endIndex, virtualWindow.startIndex],
  );

  useEffect(() => {
    const updateTableBodyTop = () => {
      const tableTop = tableRef.current?.getBoundingClientRect().top ?? 0;
      const tableHeadHeight = tableHeadRef.current?.getBoundingClientRect().height ?? 0;
      setTableBodyTop(window.scrollY + tableTop + tableHeadHeight);
    };

    updateTableBodyTop();
    window.addEventListener("resize", updateTableBodyTop);

    return () => {
      window.removeEventListener("resize", updateTableBodyTop);
    };
  }, [columns.length, dataSource, error, loading, orderType, route]);

  const handleSort = (column: SortKey) => {
    if (sortBy === column) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }

    setSortBy(column);
    setSortDir(column === "itemName" ? "asc" : "desc");
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
        <table className="table-data" ref={tableRef}>
          <colgroup>
            {columns.map((column) => (
              <col key={column.id} style={{ width: column.preferredWidth }} />
            ))}
          </colgroup>
          <thead ref={tableHeadRef}>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  className={column.headerClassName}
                  onClick={() => handleSort(column.key)}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {virtualWindow.topSpacerHeight > 0 && (
              <tr className="spacer-row">
                <td colSpan={columns.length} style={{ height: `${virtualWindow.topSpacerHeight}px` }} />
              </tr>
            )}
            {visibleRows.map((row, visibleIndex) => (
              <TradeTableRow
                key={row.id}
                row={row}
                columns={columns}
                isEvenRow={(virtualWindow.startIndex + visibleIndex) % 2 === 1}
              />
            ))}
            {virtualWindow.bottomSpacerHeight > 0 && (
              <tr className="spacer-row">
                <td colSpan={columns.length} style={{ height: `${virtualWindow.bottomSpacerHeight}px` }} />
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
};

type TradeTableRowProps = {
  row: DerivedTradeRow;
  columns: TradeTableColumn[];
  isEvenRow: boolean;
};

const TradeTableRow: FC<TradeTableRowProps> = ({ row, columns, isEvenRow }) => {
  return (
    <tr className={isEvenRow ? "table-row-even" : undefined}>
      {columns.map((column) => (
        <td key={column.id} className={column.cellClassName}>
          {column.renderCell(row)}
        </td>
      ))}
    </tr>
  );
};

function buildColumns(
  dataSource: DataSource,
  routeConfig: { acquisitionLabel: string; destinationLabel: string },
  renderSortIcon: (column: SortKey) => string | null,
): TradeTableColumn[] {
  const columns: TradeTableColumn[] = [
    {
      id: "id",
      key: "id",
      label: <>ID {renderSortIcon("id")}</>,
      preferredWidth: "6ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => String(row.id),
    },
    {
      id: "itemName",
      key: "itemName",
      label: <>Item {renderSortIcon("itemName")}</>,
      preferredWidth: "42ch",
      headerClassName: "nowrap-header",
      cellClassName: "left-align",
      renderCell: (row) => row.itemName,
    },
    {
      id: "weekVolume",
      key: "weekVolume",
      label: <>Wk Volume {renderSortIcon("weekVolume")}</>,
      preferredWidth: "12ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => formatNumber(row.weekVolume),
    },
    {
      id: "acquisitionPrice",
      key: "acquisitionPrice",
      label: <>{routeConfig.acquisitionLabel} {renderSortIcon("acquisitionPrice")}</>,
      preferredWidth: "14ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => formatMarketPrice(row.acquisitionPrice),
    },
    {
      id: "landedCost",
      key: "landedCost",
      label: <>Import Cost {renderSortIcon("landedCost")}</>,
      preferredWidth: "14ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => formatMarketPrice(row.landedCost),
    },
    {
      id: "destinationPrice",
      key: "destinationPrice",
      label: <>{routeConfig.destinationLabel} {renderSortIcon("destinationPrice")}</>,
      preferredWidth: "14ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => formatMarketPrice(row.destinationPrice),
    },
    {
      id: "afterExpenseMarginPercent",
      key: "afterExpenseMarginPercent",
      label: <>Margin % {renderSortIcon("afterExpenseMarginPercent")} <HeaderInfoTooltip content="Net profit per unit as a percentage of import cost after taxes and relists." /></>,
      preferredWidth: "12ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => `${row.afterExpenseMarginPercent.toFixed(2)}%`,
    },
  ];

  if (dataSource === "top500") {
    columns.push({
      id: "weekMarkupISK",
      key: "weekMarkupISK",
      label: <>GM Wk Profit {renderSortIcon("weekMarkupISK")} <HeaderInfoTooltip content="Weekly profit reported by Goonmetrics before this app's extra expense adjustments." /></>,
      preferredWidth: "13ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => formatWholeNumber(row.weekMarkupISK),
    });
  }

  columns.push(
    {
      id: "weekProfit",
      key: "weekProfit",
      label: <>Net Wk Profit {renderSortIcon("weekProfit")} <HeaderInfoTooltip content="Estimated weekly profit after taxes, relists, and transport are applied." /></>,
      preferredWidth: "13ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => formatWholeNumber(row.weekProfit),
    },
    {
      id: "fillerScore",
      key: "fillerScore",
      label: <>Fill {renderSortIcon("fillerScore")} <FillerScoreTooltip /></>,
      preferredWidth: "9ch",
      headerClassName: "nowrap-header",
      description: "Heuristic score for filler suitability using weekly volume, profit, and transport efficiency.",
      renderCell: (row) => formatNumber(row.fillerScore),
    },
    {
      id: "acquisitionPricePerM3",
      key: "acquisitionPricePerM3",
      label: <>Price/M3 {renderSortIcon("acquisitionPricePerM3")} <HeaderInfoTooltip content="Acquisition price divided by item volume, used to judge hauling efficiency." /></>,
      preferredWidth: "10ch",
      headerClassName: "nowrap-header",
      renderCell: (row) => formatWholeNumber(row.acquisitionPricePerM3),
    },
  );

  return columns;
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
