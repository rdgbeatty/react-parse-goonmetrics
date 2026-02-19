import type { ImportRow, OrderType } from "@sharedTypes/importRow.ts";
import { OrderType as OrderTypeEnum } from "@sharedTypes/importRow.ts";
import type { ImportRowRepository } from "../repositories/ImportRowRepository.ts";
import {
  DOMParser,
  type Node as DomNode,
  type NodeList as DomNodeList,
} from "deno-dom-wasm";

export class ScraperService {

  private repo: ImportRowRepository;
  private lastBuyOrderUpdate: number = 0;
  private lastSellOrderUpdate: number = 0;
  private nextId: number = 1;
  private readonly CACHE_TTL_MS = 1000 * 60 * 5; // 5 minutes

  private readonly URL_CONFIG = {
    [OrderTypeEnum.SELL]: "https://goonmetrics.apps.goonswarm.org/importing/1049588174021/topmarkup/",
    [OrderTypeEnum.BUY]: "https://goonmetrics.apps.goonswarm.org/importing/1049588174021/topmarkup/?from=buy",
  };

  constructor(repo: ImportRowRepository) {
    this.repo = repo;
  }

  private isBuyOrderCacheExpired(): boolean {
    return Date.now() - this.lastBuyOrderUpdate > this.CACHE_TTL_MS;
  }

  private isSellOrderCacheExpired(): boolean {
    return Date.now() - this.lastSellOrderUpdate > this.CACHE_TTL_MS;
  }

  private isCacheExpired(orderType: OrderType): boolean {
    return orderType === OrderTypeEnum.BUY
      ? this.isBuyOrderCacheExpired()
      : this.isSellOrderCacheExpired();
  }

  private updateCacheTimestamp(orderType: OrderType): void {
    const timestamp = Date.now();
    if (orderType === OrderTypeEnum.BUY) {
      this.lastBuyOrderUpdate = timestamp;
    } else {
      this.lastSellOrderUpdate = timestamp;
    }
  }

  async GetAllImportRows(orderType: OrderType = OrderTypeEnum.SELL): Promise<ImportRow[]> {
    if (this.isCacheExpired(orderType)) {
      console.log(`Cache expired for ${orderType} orders, fetching new data...`);
      await this.refetchData(orderType);
    }

    return await this.getOrdersFromRepo(orderType);
  }

  private async getOrdersFromRepo(orderType: OrderType): Promise<ImportRow[]> {
    const allRows = await this.repo.list();
    return allRows.filter(row => row.orderType === orderType);
  }

  private async refetchData(orderType: OrderType): Promise<void> {
    const newRows = await this.fetchAndParse(orderType);
    await this.removeOrderTypeFromRepo(orderType);
    await this.repo.addMany(newRows);
    this.updateCacheTimestamp(orderType);
  }

  private async removeOrderTypeFromRepo(orderType: OrderType): Promise<void> {
    const allRows = await this.repo.list();
    const rowsToKeep = allRows.filter(row => row.orderType !== orderType);
    await this.repo.clear();
    await this.repo.addMany(rowsToKeep);
  }

  private async fetchAndParse(orderType: OrderType): Promise<ImportRow[]> {
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

  private parseTable(doc: ReturnType<DOMParser["parseFromString"]>, orderType: OrderType): ImportRow[] {
    const table = doc.querySelector("table");
    const rows: ImportRow[] = [];

    if (table) {
      const tableRows = table.querySelectorAll("tr");
      for (let i = 1; i < tableRows.length; i++) { // skip header row 0
        const tableColumns = tableRows[i].querySelectorAll("td");
        if (tableColumns.length < 2) continue;
        rows.push(this.parseRow(tableColumns, orderType));
      }
    }

    return rows;
  }

  private parseRow(tableColumns: DomNodeList, orderType: OrderType): ImportRow {
    const itemName = (tableColumns.item(0)?.textContent ?? "").trim();

    const wkVolume = this.parseNumber(tableColumns.item(1));
    const jitaPrice = this.parseNumber(tableColumns.item(2));
    const importPrice = this.parseNumber(tableColumns.item(3));
    const CJPrice = this.parseNumber(tableColumns.item(4));
    const markupPct = this.parseNumber(tableColumns.item(5));
    const wkMarkup = this.parseNumber(tableColumns.item(6));

    return {
      id: this.nextId++,
      itemName: itemName,
      weekVolume: wkVolume,
      jitaPrice: jitaPrice,
      importPrice: importPrice,
      cjPrice: CJPrice,
      markupPercent: markupPct,
      weekMarkupISK: wkMarkup,
      orderType: orderType,
    };
  }

  private parseNumber(cell: DomNode | null): number {
    let text = cell?.textContent ?? "";
    text = text.replace(/%/g, "");
    text = text.replace(/,/g, "").trim();
    return Number(text) || 0;
  }
}
