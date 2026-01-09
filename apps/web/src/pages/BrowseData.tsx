import { FC } from "react";
import { Link } from "react-router-dom";

export const BrowseDataPage: FC = () => {
  return (
    <div>
      <h1 className="page-title">Browse Data</h1>
      <p> Also TODO </p>
      <p className="muted">No items yet. Load some data first.</p>
      <Link to="/load" className="link-primary">
        Go to Load Data
      </Link>
    </div>
  );
};