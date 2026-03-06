import type { OrderType, ScrapedRow } from "@sharedTypes/importRow.ts";
import { OrderType as OrderTypeEnum } from "@sharedTypes/importRow.ts";
import type { ImportRowRepository } from "../repositories/ImportRowRepository.ts";
import { BaseScraperService, DOMParser, type DomNodeList } from "./BaseScraperService.ts";

export class Top500ScraperService extends BaseScraperService {
  protected readonly CACHE_TTL_MS = 1000 * 60 * 5; // 5 minutes

  private readonly URL_CONFIG = {
    [OrderTypeEnum.SELL]: "https://goonmetrics.apps.goonswarm.org/importing/1049588174021/topmarkup/",
    [OrderTypeEnum.BUY]: "https://goonmetrics.apps.goonswarm.org/importing/1049588174021/topmarkup/?from=buy",
  };

  constructor(repo: ImportRowRepository) {
    super(repo);
  }

  protected async fetchAndParse(orderType: OrderType): Promise<ScrapedRow[]> {
    const targetUrl = this.URL_CONFIG[orderType];

    const res = await fetch(targetUrl);
    if (!res.ok) {
      console.error(`Failed to fetch ${orderType} orders:`, res.statusText);
      throw new Error(`Failed to fetch ${orderType} orders: ${res.statusText}`);
    }

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) {
      console.error(`Failed to parse ${orderType} doc`);
      throw new Error(`Failed to parse ${orderType} html`);
    }

    return this.parseTable(doc, orderType);
  }

  protected parseRow(tableColumns: DomNodeList, orderType: OrderType): ScrapedRow {
    const itemName = (tableColumns.item(0)?.textContent ?? "").trim();

    const wkVolume = this.parseNumber(tableColumns.item(1));
    const jitaPrice = this.parseNumber(tableColumns.item(2));
    const importPrice = this.parseNumber(tableColumns.item(3));
    const itemVolumeM3 = this.parseItemVolumeM3(jitaPrice, importPrice);
    const cjPrice = this.parseNumber(tableColumns.item(4));
    const markupPct = this.parseNumber(tableColumns.item(5));
    const wkMarkup = this.parseNumber(tableColumns.item(6));

    return {
      id: this.nextId++,
      itemName,
      weekVolume: wkVolume,
      jitaPrice,
      itemVolumeM3,
      cjPrice,
      markupPercent: markupPct,
      weekMarkupISK: wkMarkup,
      orderType,
    };
  }
}
