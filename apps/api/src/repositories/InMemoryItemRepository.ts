import type { ScrapedRow } from "@gm/shared/index.ts";
import type { ImportRowRepository } from "./ImportRowRepository.ts";

export class InMemoryItemRepository implements ImportRowRepository {
  private items: ScrapedRow[] = [];

  async clear(): Promise<void> {
    this.items = [];
  }

  async addMany(items: ScrapedRow[]): Promise<void> {
    this.items.push(...items);
  }

  async list(limit?: number, offset?: number): Promise<ScrapedRow[]> {
    return this.items.slice(offset || 0, limit ? (offset || 0) + limit : undefined);
  }

  async findById(id: number): Promise<ScrapedRow | undefined> {
    return this.items.find((i) => i.id === id);
  }
}
