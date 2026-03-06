import type { ScrapedRow } from "@sharedTypes/importRow.ts";
import { OrderType } from "@sharedTypes/importRow.ts";
import type { MarketGroupScraperService } from "../services/MarketGroupScraperService.ts";

export function register(app: any, scraperService: MarketGroupScraperService) {
  const service = scraperService;

  app.get("/api/scrape-marketgroup", async (c: any) => {
    c.header("Access-Control-Allow-Origin", "*");

    try {
      const orderTypeParam = c.req.query("orderType");

      let orderType = OrderType.SELL;
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
      console.error("Error fetching/parsing market groups:", err);
      return c.json({ ok: false, error: "Failed to fetch/parse market group data" }, 500);
    }
  });
}
