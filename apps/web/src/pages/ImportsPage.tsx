import { FC } from "react";
import { TradeTable } from "../components/TradeTable";
import { TradeRoute } from "../lib/tradeModes";

export const ImportsPage: FC = () => {
  return <TradeTable route={TradeRoute.IMPORTS} />;
};
