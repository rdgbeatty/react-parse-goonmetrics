/// <reference lib="deno.ns" />
import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";

const app = new Hono();

app.use("/*", cors());

app.get("/health", (c) => c.json({ ok: true }));

// Route stubs (currently no logic)
import { register as registerIngest } from "./routes/ingest.ts";
import { register as registerItems } from "./routes/items.ts";
import { register as registerScrape } from "./routes/scrape.ts";
import { register as registerScrapeJson } from "./routes/scrape-json.ts";
import { register as registerScrapeMarketGroup } from "./routes/scrape-marketgroup.ts";
import { Top500ScraperService } from "./services/Top500ScraperService.ts";
import { MarketGroupScraperService } from "./services/MarketGroupScraperService.ts";
import { InMemoryItemRepository } from "./repositories/InMemoryItemRepository.ts";

// Construct shared dependencies once and pass them into route registration.
const top500Repo = new InMemoryItemRepository();
const top500ScraperService = new Top500ScraperService(top500Repo);

const marketGroupRepo = new InMemoryItemRepository();
const marketGroupScraperService = new MarketGroupScraperService(marketGroupRepo);

registerIngest(app);
registerItems(app);
registerScrape(app);
registerScrapeJson(app, top500ScraperService);
registerScrapeMarketGroup(app, marketGroupScraperService);

const PORT = Number(Deno.env.get("PORT") || 4000);

if (import.meta.main) {
  console.log(`Listening on http://localhost:${PORT}`);
  Deno.serve({ port: PORT }, (req) => {
    try {
      // app.fetch should be a function that handles Request
      return (app as any).fetch(req);
    } catch (err) {
      console.error('Error handling request', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  });
}
