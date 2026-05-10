import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite serves the SPA on :5173 and proxies /api/* to the Express
// server on :3000. In prod, Express serves the built dist/ directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 1200, // reactflow + dagre push past the default 500kb
  },
});
