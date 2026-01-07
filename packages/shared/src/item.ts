import { z } from "zod";

export const Item = z.object({
  id: z.string(),
  name: z.string(),
  volume: z.number(),
});

export type Item = z.infer<typeof Item>;
