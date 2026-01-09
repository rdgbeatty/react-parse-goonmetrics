import { FC } from "react";
import { Link } from "react-router-dom";

export const Nav: FC = () => (
  <nav className="site-nav">
    <div className="nav-inner">
      <div className="nav-links">
        <Link to="/" className="nav-link">
          Table View
        </Link>
        <Link to="/load" className="nav-link">
          Load Data
        </Link>
        <Link to="/browse" className="nav-link">
          Browse Data
        </Link>
      </div>
    </div>
  </nav>
);