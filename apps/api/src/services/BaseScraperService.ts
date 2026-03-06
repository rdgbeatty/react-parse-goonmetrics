import type { OrderType, ScrapedRow } from "@sharedTypes/importRow.ts";
import { OrderType as OrderTypeEnum } from "@sharedTypes/importRow.ts";
import type { ImportRowRepository } from "../repositories/ImportRowRepository.ts";
import {
  DOMParser,
  type Node as DomNode,
  type NodeList as DomNodeList,
} from "deno-dom-wasm";

export { DOMParser, type DomNode, type DomNodeList };

export abstract class BaseScraperService {
  protected repo: ImportRowRepository;
  private lastBuyOrderUpdate: number = 0;
  private lastSellOrderUpdate: number = 0;
  protected nextId: number = 1;

  protected abstract readonly CACHE_TTL_MS: number;

  constructor(repo: ImportRowRepository) {
    this.repo = repo;
  }

  private isCacheExpired(orderType: OrderType): boolean {
    const last = orderType === OrderTypeEnum.BUY
      ? this.lastBuyOrderUpdate
      : this.lastSellOrderUpdate;
    return Date.now() - last > this.CACHE_TTL_MS;
  }

  protected updateCacheTimestamp(orderType: OrderType): void {
    const timestamp = Date.now();
    if (orderType === OrderTypeEnum.BUY) {
      this.lastBuyOrderUpdate = timestamp;
    } else {
      this.lastSellOrderUpdate = timestamp;
    }
  }

  async GetAllImportRows(orderType: OrderType = OrderTypeEnum.SELL): Promise<ScrapedRow[]> {
    if (this.isCacheExpired(orderType)) {
      console.log(`Cache expired for ${orderType} orders, fetching new data...`);
      await this.refetchData(orderType);
    }
    return await this.getOrdersFromRepo(orderType);
  }

  protected async getOrdersFromRepo(orderType: OrderType): Promise<ScrapedRow[]> {
    const allRows = await this.repo.list();
    return allRows.filter(row => row.orderType === orderType);
  }

  protected async refetchData(orderType: OrderType): Promise<void> {
    const newRows = await this.fetchAndParse(orderType);
    await this.removeOrderTypeFromRepo(orderType);
    await this.repo.addMany(newRows);
    this.updateCacheTimestamp(orderType);
  }

  protected async removeOrderTypeFromRepo(orderType: OrderType): Promise<void> {
    const allRows = await this.repo.list();
    const rowsToKeep = allRows.filter(row => row.orderType !== orderType);
    await this.repo.clear();
    await this.repo.addMany(rowsToKeep);
  }

  protected abstract fetchAndParse(orderType: OrderType): Promise<ScrapedRow[]>;

  protected abstract parseRow(tableColumns: DomNodeList, orderType: OrderType): ScrapedRow;

  protected parseTable(doc: ReturnType<DOMParser["parseFromString"]>, orderType: OrderType): ScrapedRow[] {
    const table = doc.querySelector("table");
    const rows: ScrapedRow[] = [];

    if (table) {
      const tableRows = table.querySelectorAll("tr");
      for (let i = 1; i < tableRows.length; i++) {
        const tableColumns = tableRows[i].querySelectorAll("td");
        if (tableColumns.length < 2) continue;
        rows.push(this.parseRow(tableColumns, orderType));
      }
    }

    return rows;
  }

  protected parseNumber(cell: DomNode | null): number {
    let text = cell?.textContent ?? "";
    text = text.replace(/%/g, "");
    text = text.replace(/,/g, "").trim();
    return Number(text) || 0;
  }

  protected parseItemVolumeM3(jitaPrice: number, importPrice: number): number {
    const legacyTransportCost = importPrice - jitaPrice;
    return legacyTransportCost > 0 ? legacyTransportCost / 1000 : 0;
  }
}
