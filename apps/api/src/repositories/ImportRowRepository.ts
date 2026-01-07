import type { ImportRow } from "@gm/shared/index.ts";

export interface ImportRowRepository {
  clear(): Promise<void>;
  addMany(items: ImportRow[]): Promise<void>;
  list(limit?: number, offset?: number): Promise<ImportRow[]>;
  findById(id: number): Promise<ImportRow | undefined>;
}
