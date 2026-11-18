import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ command }) => ({
  plugins: [react(), tsconfigPaths()],
  base: process.env.VITE_PUBLIC_BASE ?? (command === "serve" ? "/" : "/react-parse-goonmetrics/"),
}));
