export const OrderType = {
  BUY: "buy",
  SELL: "sell",
} as const;

export type OrderType = typeof OrderType[keyof typeof OrderType];

export type ScrapedRow = {
  id: number;
  itemName: string;
  weekVolume: number;
  jitaPrice: number;
  itemVolumeM3: number;
  cjPrice: number;
  markupPercent: number;   // e.g. 120.5 (for "120.5%")
  weekMarkupISK: number;   // ISK per week
  orderType: OrderType;
};
