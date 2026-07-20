import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { DateTime } from "luxon";
import { join, resolve } from "path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const buildTimestamp = DateTime.utc().toFormat("yyyyMMddHHmm");

// Short commit the build was cut from, with a `-dirty` suffix when the working
// tree had uncommitted changes. Falls back to a CI-provided SHA when `.git` is
// absent (e.g. a shallow tarball build), and to "unknown" when neither exists.
function resolveBuildCommit(): string {
  try {
    const git = (cmd: string) =>
      execSync(cmd, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    const short = git("git rev-parse --short HEAD");
    const dirty = git("git status --porcelain").length > 0;
    return dirty ? `${short}-dirty` : short;
  } catch {
    const ciSha =
      process.env.GITHUB_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.CF_PAGES_COMMIT_SHA;
    return ciSha ? ciSha.slice(0, 7) : "unknown";
  }
}

const buildCommit = resolveBuildCommit();

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
//   mkdir -p certs
//   mkcert -cert-file certs/lan-cert.pem -key-file certs/lan-key.pem \
//     <your-LAN-IP> localhost tasfer.app
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
      "         mkdir -p certs\n" +
      "         mkcert -cert-file certs/lan-cert.pem -key-file certs/lan-key.pem <LAN-IP> localhost tasfer.app\n",
  );
}

// Read version config from monorepo root
const versionConfig = JSON.parse(
  readFileSync(join(__dirname, "../../version.json"), "utf-8")
);

export default defineConfig({
  plugins: [
    tailwindcss(),
    react({
      // @tasfer/tex is aliased to source, which includes the generated ESM data
      // blob fontMetricsData.js. Vite 8's Oxc transform (which plugin-react
      // widens to `.js`) tries to load a tsconfig for it and fails — the tex
      // tsconfig doesn't cover `.js`. It needs no transform; exclude it while
      // keeping the default node_modules skip.
      exclude: [/\/node_modules\//, /fontMetricsData\.js$/],
    }),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      manifest: false,
      injectManifest: {
        // Headroom above Workbox's 2 MiB default for the largest single asset.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
        type: "module",
      },
    }),
  ],
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
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
    // The @tasfer/* packages are aliased to their `src/` (see below) and declare
    // react as a peer, so their bare `react`/`react-dom` imports must resolve to
    // this app's single copy. Vite 7/Rollup did this implicitly; Vite 8/Rolldown
    // needs it explicit. Also prevents a duplicate React ("invalid hook call").
    dedupe: ["react", "react-dom"],
    alias: {
      "@tasfer/editor": resolve(__dirname, "../../packages/editor/src"),
      "@tasfer/tex": resolve(__dirname, "../../packages/tex/src"),
      "@tasfer/react": resolve(__dirname, "../../packages/react/src"),
      "@tasfer/provider-core": resolve(
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
    // Replaced by our own devtools-styled overlay (see src/dev/viteErrorOverlay).
    hmr: { overlay: false },
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
