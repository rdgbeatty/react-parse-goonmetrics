import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import App from "./App";
import { LoadDataPage } from "./pages/LoadData";
import { BrowseDataPage } from "./pages/BrowseData";
import { TableDataPage } from "./pages/TableData";
import "./index.css";

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      {
        index: true,
        element: <LoadDataPage />,
      },
      {
        path: "browse",
        element: <BrowseDataPage />,
      },
      {
        path: "table",
        element: <TableDataPage />,        
      }
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