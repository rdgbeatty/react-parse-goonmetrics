import type { ScrapedRow } from "@gm/shared/index.ts";

export interface ImportRowRepository {
  clear(): Promise<void>;
  addMany(items: ScrapedRow[]): Promise<void>;
  list(limit?: number, offset?: number): Promise<ScrapedRow[]>;
  findById(id: number): Promise<ScrapedRow | undefined>;
}
