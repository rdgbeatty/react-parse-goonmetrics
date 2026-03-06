export const TradeRoute = {
  IMPORTS: "imports",
  EXPORTS: "exports",
} as const;

export type TradeRoute = typeof TradeRoute[keyof typeof TradeRoute];

export type TradeRouteConfig = {
  pageTitle: string;
  pageDescription: string;
  loadingLabel: string;
  acquisitionLabel: string;
  destinationLabel: string;
};

export const TRADE_ROUTE_CONFIG: Record<TradeRoute, TradeRouteConfig> = {
  [TradeRoute.IMPORTS]: {
    pageTitle: "Imports",
    pageDescription: "Estimate profit for buying in Jita, paying transport, and selling in C-J6MT.",
    loadingLabel: "import opportunities",
    acquisitionLabel: "Jita Price",
    destinationLabel: "C-J6MT Price",
  },
  [TradeRoute.EXPORTS]: {
    pageTitle: "Exports",
    pageDescription: "Estimate profit for buying in C-J6MT, paying transport, and selling in Jita.",
    loadingLabel: "export opportunities",
    acquisitionLabel: "C-J6MT Price",
    destinationLabel: "Jita Price",
  },
};
