import { FC } from "react";
import { Outlet } from "react-router-dom";
import { Nav } from "./components/Nav";

const App: FC = () => {
  return (
    <div className="app-root">
      <Nav />
      <main className="main-container">
        <Outlet />
      </main>
    </div>
  );
};

export default App;