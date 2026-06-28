import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { DateTime } from "luxon";
import { join, resolve } from "path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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
        // Headroom above Workbox's 2 MiB default for the largest single asset.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
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
  // The device-node SharedWorker bundles the Engine, whose lazy `import()`s
  // require code-splitting — unsupported by the default `iife` worker format.
  // Use ES module workers: they support splitting AND let wa-sqlite's WASM
  // dynamic import (wa-sqlite-async.mjs) work normally (forcing it inline
  // breaks it).
  worker: { format: "es" },
  resolve: {
    alias: {
      "@cypherkit/editor": resolve(__dirname, "../../packages/editor/src"),
      "@cypherkit/tex": resolve(__dirname, "../../packages/tex/src"),
      "@cypherkit/react": resolve(__dirname, "../../packages/react/src"),
      "@cypherkit/provider-core": resolve(
        __dirname,
        "../../packages/provider-core/src",
      ),
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
