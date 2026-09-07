import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

import { readCrystalSketchVersion } from "./projectMetadata";

const apiTarget = process.env.CRYSTALSKETCH_API_URL ?? "http://127.0.0.1:8766";
const crystalSketchVersion = readCrystalSketchVersion();
const apiProxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: true,
  },
};

function devFaviconPlugin(): Plugin {
  return {
    name: "crystalsketch-dev-favicon",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace('href="/favicon.svg?v=crystalsketch"', 'href="/favicon.dev.svg?v=crystalsketch"');
    },
  };
}

export default defineConfig({
  base: process.env.CRYSTALSKETCH_BASE_PATH ?? "/",
  define: {
    "import.meta.env.VITE_CRYSTALSKETCH_VERSION": JSON.stringify(crystalSketchVersion),
  },
  plugins: [devFaviconPlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
});
