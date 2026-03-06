import { FC } from "react";
import { Link } from "react-router-dom";

export const BrowseDataPage: FC = () => {
  return (
    <div>
      <h1 className="page-title">Browse Data</h1>
      <p>Also TODO.</p>
      <p className="muted">Browse tools will live here. Use the imports or exports table for now.</p>
      <Link to="/imports" className="link-primary">
        Go to Imports
      </Link>
    </div>
  );
};
