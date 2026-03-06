import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, RouterProvider, createHashRouter } from "react-router-dom";
import App from "./App";
import { BrowseDataPage } from "./pages/BrowseData";
import { ImportsPage } from "./pages/ImportsPage";
import { ExportsPage } from "./pages/ExportsPage";
import "./index.css";

const queryClient = new QueryClient();

const router = createHashRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        index: true,
        element: <Navigate to="/imports" replace />,
      },
      {
        path: "imports",
        element: <ImportsPage />,
      },
      {
        path: "exports",
        element: <ExportsPage />,
      },
      {
        path: "browse",
        element: <BrowseDataPage />,
      },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
