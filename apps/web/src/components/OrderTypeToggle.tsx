import { FC } from "react";
import { OrderType } from "@sharedTypes/importRow.ts";
import "./OrderTypeToggle.css";

interface OrderTypeToggleProps {
  value: OrderType;
  onChange: (orderType: OrderType) => void;
}

export const OrderTypeToggle: FC<OrderTypeToggleProps> = ({ value, onChange }) => {
  return (
    <div className="order-type-toggle">
      <span className="order-type-toggle-label">Jita Price:</span>
      <div className="order-type-toggle-buttons">
        <button
          className={value === OrderType.SELL ? "active sell" : ""}
          onClick={() => value !== OrderType.SELL && onChange(OrderType.SELL)}
        >
          Sell
        </button>
        <button
          className={value === OrderType.BUY ? "active buy" : ""}
          onClick={() => value !== OrderType.BUY && onChange(OrderType.BUY)}
        >
          Buy
        </button>
      </div>
    </div>
  );
};
