import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ command }) => ({
  plugins: [react(), tsconfigPaths()],
  base: command === "serve" ? "/" : "/YOUR_REPO_NAME/",
}));
