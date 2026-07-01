import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "fs";
import { DateTime } from "luxon";
import { join, resolve } from "path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const buildTimestamp = DateTime.utc().toFormat("yyyyMMddHHmm");

// `npm run dev:host` (`vite --host`) serves on the LAN, i.e. a non-localhost
// origin. Browsers (and the iOS/Android WebView) treat plain-HTTP non-localhost
// origins as *insecure contexts*, where `navigator.locks`, `crypto.subtle`, and
// OPFS are all undefined — so the SQLite IndexedDB VFS's Web Locks call throws
// and surfaces as a bogus "disk I/O error", and identity/crypto/sync fail next.
// HTTPS makes the LAN origin a secure context so those APIs exist. localhost is
// already a secure context, so we only enable TLS when actually hosting.
//
// The cert must be trusted by the connecting device (an iOS/Android WebView
// rejects an untrusted cert outright), so generate it with mkcert, whose local
// CA you install once on the device:
//   brew install mkcert && mkcert -install
//   mkcert -cert-file certs/lan-cert.pem -key-file certs/lan-key.pem \
//     <your-LAN-IP> localhost cypher.md
// `certs/` is gitignored. If host mode is requested without the cert present we
// fall back to HTTP and warn, rather than failing to start.
const isHostMode = process.argv.some(
  (arg) => arg === "--host" || arg.startsWith("--host="),
);

const certDir = resolve(__dirname, "certs");
const certPath = join(certDir, "lan-cert.pem");
const keyPath = join(certDir, "lan-key.pem");
const lanHttps =
  isHostMode && existsSync(certPath) && existsSync(keyPath)
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined;

if (isHostMode && !lanHttps) {
  console.warn(
    "\n[vite] --host requested but no mkcert cert found in apps/web/certs/.\n" +
      "       Serving over plain HTTP: the LAN origin will be an INSECURE\n" +
      "       context and crypto.subtle / OPFS / Web Locks will be undefined.\n" +
      "       Generate a trusted cert:\n" +
      "         brew install mkcert && mkcert -install\n" +
      "         mkcert -cert-file certs/lan-cert.pem -key-file certs/lan-key.pem <LAN-IP> localhost cypher.md\n",
  );
}

// Read version config from monorepo root
const versionConfig = JSON.parse(
  readFileSync(join(__dirname, "../../version.json"), "utf-8")
);

export default defineConfig({
  plugins: [
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
    https: lanHttps,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
