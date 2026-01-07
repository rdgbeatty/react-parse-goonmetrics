// routes.ts (where your register(app) lives)
import type { ImportRow } from "@sharedTypes/importRow.ts";
import type { ScraperService } from "../services/ScraperService.ts";

export function register(app: any, scraperService: ScraperService) {
  const service = scraperService;

  app.get("/api/scrape-json", async (c: any) => {
    c.header("Access-Control-Allow-Origin", "*");

    try {
      const rows: ImportRow[] = await service.GetAllImportRows();
      return c.json({ ok: true, rows });
    } catch (err) {
      console.error("Error fetching/parsing:", err);
      return c.json({ ok: false, error: "Failed to fetch/parse data" }, 500);
    }
  });
}
