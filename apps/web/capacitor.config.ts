import type { CapacitorConfig } from "@capacitor/cli";
import { loadEnv } from "vite";

// Point the WebView at a live dev server by setting CAP_SERVER_URL, e.g.
//   CAP_SERVER_URL=https://192.168.xx.yy:4000 npm run cap:sync
// or add it to a (gitignored) .env / .env.local file in this directory.
// It must be HTTPS (served by `npm run dev:host` with an mkcert cert): the
// WebView only exposes crypto.subtle / OPFS in a secure context. See
// vite.config.ts. When CAP_SERVER_URL is unset, `url` is omitted and the app
// loads the bundled static export from `webDir` (dist).
//
// `cap sync` runs this config in Node, which does not auto-load .env files, so
// resolve them the same way the web build does (loadEnv with an empty prefix
// reads all keys, not just VITE_*). A real process.env value still wins.
const mode = process.env.NODE_ENV ?? "development";
const env = loadEnv(mode, process.cwd(), "");
const devServerUrl = process.env.CAP_SERVER_URL ?? env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: "app.tasfer",
  appName: "Tasfer",
  webDir: "dist",
  server: {
    ...(devServerUrl ? { url: devServerUrl } : {}),
    hostname: "tasfer.app",
    androidScheme: "https",
    allowNavigation: ["tasfer.app"],
  },
  ios: {
    backgroundColor: "#101012",
    contentInset: "never",
    preferredContentMode: "mobile",
    scheme: "https",
    path: "../ios",
  },
  android: {
    backgroundColor: "#101012",
    path: "../android",
  },
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
    Keyboard: {
      // "none": the WKWebView keeps its full height when the soft keyboard opens
      // — the keyboard just overlays the bottom of the page. We deliberately do
      // NOT use "native" (which shrinks the WebView frame): that shrink resizes
      // the ENTIRE document on every keyboard open/close, reflowing the whole app
      // layout and repainting every viewport-sized canvas (the calendar grid, the
      // editor) on the main thread — visible as jank/flicker and a sheet that
      // dropped back down as the frame shrank behind it. With "none" the layout
      // holds still and keyboard-avoidance is done per-surface from the
      // visualViewport inset instead (useKeyboardInset; the editor's viewport
      // height formula in MountedEditor). window.innerHeight stays constant.
      resize: "none",
    },
  },
};

export default config;
