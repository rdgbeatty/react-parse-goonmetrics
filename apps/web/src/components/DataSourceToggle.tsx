import { FC } from "react";
import "./DataSourceToggle.css";

export type DataSource = "top500" | "all";

interface DataSourceToggleProps {
  value: DataSource;
  onChange: (dataSource: DataSource) => void;
}

export const DataSourceToggle: FC<DataSourceToggleProps> = ({ value, onChange }) => {
  return (
    <div className="data-source-toggle">
      <span className="data-source-toggle-label">Data Source:</span>
      <div className="data-source-toggle-buttons">
        <button
          className={value === "top500" ? "active top500" : ""}
          onClick={() => value !== "top500" && onChange("top500")}
        >
          Top 500
        </button>
        <button
          className={value === "all" ? "active all" : ""}
          onClick={() => value !== "all" && onChange("all")}
        >
          All Items
        </button>
      </div>
    </div>
  );
};
