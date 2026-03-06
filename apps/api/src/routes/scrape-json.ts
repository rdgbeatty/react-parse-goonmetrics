// routes.ts (where your register(app) lives)
import type { ScrapedRow } from "@sharedTypes/importRow.ts";
import { OrderType } from "@sharedTypes/importRow.ts";
import type { Top500ScraperService } from "../services/Top500ScraperService.ts";

export function register(app: any, scraperService: Top500ScraperService) {
  const service = scraperService;

  app.get("/api/scrape-json", async (c: any) => {
    c.header("Access-Control-Allow-Origin", "*");

    try {
      const orderTypeParam = c.req.query("orderType");

      // Validate and convert to OrderType
      let orderType = OrderType.SELL; // default
      if (orderTypeParam) {
        if (orderTypeParam !== OrderType.BUY && orderTypeParam !== OrderType.SELL) {
          return c.json({
            ok: false,
            error: `Invalid orderType. Must be '${OrderType.BUY}' or '${OrderType.SELL}'.`
          }, 400);
        }
        orderType = orderTypeParam;
      }

      const rows: ScrapedRow[] = await service.GetAllImportRows(orderType);
      return c.json({ ok: true, rows });
    } catch (err) {
      console.error("Error fetching/parsing:", err);
      return c.json({ ok: false, error: "Failed to fetch/parse data" }, 500);
    }
  });
}
