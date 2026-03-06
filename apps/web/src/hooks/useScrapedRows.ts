import { useEffect, useState } from "react";
import type { OrderType, ScrapedRow } from "@sharedTypes/importRow.ts";
import type { DataSource } from "../components/DataSourceToggle";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

type ScrapedRowsResponse = {
  ok: boolean;
  rows?: ScrapedRow[];
  error?: string;
};

export function useScrapedRows(orderType: OrderType, dataSource: DataSource) {
  const [rows, setRows] = useState<ScrapedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadRows() {
      setLoading(true);
      setError(null);

      try {
        const endpoint = dataSource === "top500" ? "/api/scrape-json" : "/api/scrape-marketgroup";
        const res = await fetch(`${API_BASE_URL}${endpoint}?orderType=${orderType}`);
        const data: ScrapedRowsResponse = await res.json();

        if (!res.ok || !data.ok || !data.rows) {
          throw new Error(data.error ?? `Failed to load ${dataSource} rows`);
        }

        if (!cancelled) {
          setRows(data.rows);
        }
      } catch (err) {
        if (!cancelled) {
          setRows([]);
          setError(err instanceof Error ? err.message : "Failed to load data");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadRows();
    return () => {
      cancelled = true;
    };
  }, [dataSource, orderType]);

  return { rows, loading, error };
}
