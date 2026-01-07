import type { ImportRow } from "@gm/shared/index.ts";
import type { ImportRowRepository } from "./ImportRowRepository.ts";

export class InMemoryItemRepository implements ImportRowRepository {
  private items: ImportRow[] = [];

  async clear(): Promise<void> {
    this.items = [];
  }

  async addMany(items: ImportRow[]): Promise<void> {
    this.items.push(...items);
  }

  async list(limit?: number, offset?: number): Promise<ImportRow[]> {
    return this.items.slice(offset || 0, limit ? (offset || 0) + limit : undefined);
  }

  async findById(id: number): Promise<ImportRow | undefined> {
    return this.items.find((i) => i.id === id);
  }
}
