import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    assetsDir: "_app",
    manifest: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          id.includes("node_modules/react") ? "react" : undefined,
      },
    },
  },
});
