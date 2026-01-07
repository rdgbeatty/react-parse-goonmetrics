import type { ImportRow } from "@gm/shared/index.ts";
import type { ImportRowRepository } from "../repositories/ImportRowRepository.ts";
import {
  DOMParser,
  type Node as DomNode,
  type NodeList as DomNodeList,
} from "deno-dom-wasm";

export class ScraperService {

  private repo: ImportRowRepository;
  lastUpdateTime: number = 0;

  constructor(repo: ImportRowRepository) {
    this.repo = repo;
  }

  async GetAllImportRows(): Promise<ImportRow[]> {

    if (Date.now() - this.lastUpdateTime > 1000 * 5 * 60) { // 5 minute cache
      console.log("Cache expired, fetching new data...");
      await this.refetchData();
    }

    return await this.repo.list();
  }

  private async refetchData(): Promise<void> {
    const rows = await this.fetchAndParse();
    await this.repo.clear();
    await this.repo.addMany(rows);
    this.lastUpdateTime = Date.now();
  }

  private async fetchAndParse(): Promise<ImportRow[]> {
    const targetUrl = "https://goonmetrics.apps.goonswarm.org/importing/1049588174021/topmarkup/";

    const res = await fetch(targetUrl);
    if (!res.ok) {
      console.error("Failed to fetch data:", res.statusText);
      throw new Error(`Failed to fetch data: ${res.statusText}`);
    }

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) {
      console.error("Failed to parse doc");
      throw new Error(`Failed to parse html`);
    } 

    const table = doc.querySelector("table");
    const rows: ImportRow[] = [];
    if (table) {
      let id = 1;
      const tableRows = table.querySelectorAll("tr");
      for (let i = 1; i < tableRows.length; i++) { // skip header row 0
        const tableColumns = tableRows[i].querySelectorAll("td");
        if (tableColumns.length < 2) continue;
        rows.push(this.parseRow(tableColumns, id++));
      }
    }

    return rows;
  }

  private parseRow(tableColumns: DomNodeList, id: number): ImportRow {
    const itemName = (tableColumns.item(0)?.textContent ?? "").trim();

    const wkVolume = this.parseNumber(tableColumns.item(1));
    const jitaPrice = this.parseNumber(tableColumns.item(2));
    const importPrice = this.parseNumber(tableColumns.item(3));
    const CJPrice = this.parseNumber(tableColumns.item(4));
    const markupPct = this.parseNumber(tableColumns.item(5));
    const wkMarkup = this.parseNumber(tableColumns.item(6));

    return {
      id: id,
      itemName: itemName,
      weekVolume: wkVolume,
      jitaPrice: jitaPrice,
      importPrice: importPrice,
      cjPrice: CJPrice,
      markupPercent: markupPct,
      weekMarkupISK: wkMarkup,
    };
  }

  private parseNumber(cell: DomNode | null): number {
    let text = cell?.textContent ?? "";
    text = text.replace(/%/g, "");
    text = text.replace(/,/g, "").trim();
    return Number(text) || 0;
  }
}
