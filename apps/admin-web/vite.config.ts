import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 管理端 API（apps/admin :8787）
      "/healthz": "http://localhost:8787",
      "/v1/admin": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
  },
});
