import type { OrderType, ScrapedRow } from "@sharedTypes/importRow.ts";
import { OrderType as OrderTypeEnum } from "@sharedTypes/importRow.ts";
import type { ImportRowRepository } from "../repositories/ImportRowRepository.ts";
import { BaseScraperService, DOMParser, type DomNodeList } from "./BaseScraperService.ts";

const BASE_URL = "https://goonmetrics.apps.goonswarm.org";
const INDEX_PATH = "/importing/1049588174021/marketgroup";

export class MarketGroupScraperService extends BaseScraperService {
  protected readonly CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

  constructor(repo: ImportRowRepository) {
    super(repo);
  }

  protected async fetchAndParse(orderType: OrderType): Promise<ScrapedRow[]> {
    const subPagePaths = await this.fetchMarketGroupLinks();
    console.log(`Found ${subPagePaths.length} market group pages to scrape`);

    const allRows: ScrapedRow[] = [];
    const seenItems = new Set<string>();

    for (const path of subPagePaths) {
      try {
        const rows = await this.fetchAndParseSinglePage(path, orderType);
        for (const row of rows) {
          if (!seenItems.has(row.itemName)) {
            seenItems.add(row.itemName);
            allRows.push(row);
          }
        }
        console.log(`Scraped ${rows.length} rows from ${path}, total unique items so far: ${allRows.length}`);
      } catch (err) {
        console.error(`Failed to scrape market group page ${path}:`, err);
        // Continue with remaining pages
      }
    }

    console.log(`Scraped ${allRows.length} unique items from market groups`);
    return allRows;
  }

  private async fetchMarketGroupLinks(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}${INDEX_PATH}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch market group index: ${res.statusText}`);
    }

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) {
      throw new Error("Failed to parse market group index html");
    }

    const links: string[] = [];
    const anchors = doc.querySelectorAll("a");
    const pattern = /\/importing\/1049588174021\/marketgroup\/\d+\/?$/;

    for (let i = 0; i < anchors.length; i++) {
      const href = anchors[i].getAttribute("href");
      if (href && pattern.test(href)) {
        links.push(href);
      }
    }

    return links;
  }

  private async fetchAndParseSinglePage(path: string, orderType: OrderType): Promise<ScrapedRow[]> {
    let url = `${BASE_URL}${path}`;
    if (orderType === OrderTypeEnum.BUY) {
      url += url.endsWith("/") ? "?from=buy" : "/?from=buy";
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.statusText}`);
    }

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) {
      throw new Error(`Failed to parse html from ${url}`);
    }

    return this.parseTable(doc, orderType);
  }

  // Market group tables have 9 columns:
  // 0: Item Name, 1: Wk Volume, 2: CJ Stock (skip), 3: CJ Stock % (skip),
  // 4: Jita Price, 5: Import Price, 6: CJ Price, 7: Markup %, 8: Wk Total
  protected parseRow(tableColumns: DomNodeList, orderType: OrderType): ScrapedRow {
    const itemName = (tableColumns.item(0)?.textContent ?? "").trim();

    const wkVolume = this.parseNumber(tableColumns.item(1));
    // columns 2-3 are CJ Stock count and % — skip
    const jitaPrice = this.parseNumber(tableColumns.item(4));
    const importPrice = this.parseNumber(tableColumns.item(5));
    const itemVolumeM3 = this.parseItemVolumeM3(jitaPrice, importPrice);
    const cjPrice = this.parseNumber(tableColumns.item(6));
    const markupPct = this.parseNumber(tableColumns.item(7));
    // column 8 (Wk Total) is ignored — buggy in the third-party data source

    return {
      id: this.nextId++,
      itemName,
      weekVolume: wkVolume,
      jitaPrice,
      itemVolumeM3,
      cjPrice,
      markupPercent: markupPct,
      weekMarkupISK: 0,
      orderType,
    };
  }
}
