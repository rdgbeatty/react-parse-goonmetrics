import { FC } from "react";
import { NavLink } from "react-router-dom";

export const Nav: FC = () => (
  <nav className="site-nav">
    <div className="nav-inner">
      <div className="nav-links">
        <NavLink to="/imports" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
          Imports
        </NavLink>
        <NavLink to="/exports" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
          Exports
        </NavLink>
        <NavLink to="/browse" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
          Browse Data
        </NavLink>
      </div>
    </div>
  </nav>
);
