import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  // Eigener fester Port, damit der Dev-Server nicht mit anderen Projekten auf 5173 kollidiert.
  server: { port: 7173, strictPort: true },
  preview: { port: 7174, strictPort: true },
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
