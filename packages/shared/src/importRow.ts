export const OrderType = {
  BUY: "buy",
  SELL: "sell",
} as const;

export type OrderType = typeof OrderType[keyof typeof OrderType];

export type ImportRow = {
  id: number;
  itemName: string;
  weekVolume: number;
  jitaPrice: number;
  importPrice: number;
  cjPrice: number;
  markupPercent: number;   // e.g. 120.5 (for "120.5%")
  weekMarkupISK: number;   // ISK per week
  orderType: OrderType;
};
