import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { DateTime } from "luxon";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const buildTimestamp = DateTime.utc().toFormat("yyyyMMddHHmm");

// Read version config from monorepo root
const versionConfig = JSON.parse(
  readFileSync(join(__dirname, "../../version.json"), "utf-8")
);

export default defineConfig({
  plugins: [
    // basicSsl(),
    tailwindcss(),
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      manifest: false,
      injectManifest: {
        // The main bundle (~3.5 MB, includes the prebuilt MathJax bundle)
        // exceeds Workbox's 2 MiB default precache limit.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
        type: "module",
      },
    }),
  ],
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
    __CLIENT_VERSION__: versionConfig.version,
  },
  base: "./",
  build: { sourcemap: true },
  resolve: {
    alias: {
      "@cypherkit/editor": resolve(__dirname, "../../packages/editor/src"),
      "@cypherkit/react": resolve(__dirname, "../../packages/react/src"),
      "@": "/src",
      "@shared": resolve(__dirname, "../../shared"),
    },
  },
  server: {
    port: 4000,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
