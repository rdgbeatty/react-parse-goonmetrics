import { z } from "zod";
import { Item } from "./item.ts";

export const IngestRequest = z.object({
  sourceUrl: z.string().url(),
});

export type IngestRequest = z.infer<typeof IngestRequest>;

export const ItemsQuery = z.object({
  limit: z.number().optional(),
  offset: z.number().optional(),
});

export const ItemsResponse = z.object({
  items: z.array(Item),
  total: z.number(),
});

export type ItemsResponse = z.infer<typeof ItemsResponse>;
