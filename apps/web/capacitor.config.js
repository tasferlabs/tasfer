import { loadEnv } from "vite";

// Authored in JS, not TS: the Capacitor CLI parses a `.ts` config by
// hand-transpiling it through the classic `typescript` compiler API
// (ts.transpileModule / ts.ModuleKind), which TypeScript 7 no longer ships.
//
// It is also exported field-by-field rather than as `export default`: under
// this package's ESM ("type": "module"), Capacitor's JS config loader reads
// the required module's own keys and does NOT unwrap a `default` export, so a
// default export would be invisible to it. Named exports land as top-level
// config fields. JSDoc still gives us CapacitorConfig type-checking.
//
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

export const appId = "app.tasfer";
export const appName = "Tasfer";
export const webDir = "dist";

/** @type {import('@capacitor/cli').CapacitorConfig['server']} */
export const server = {
  ...(devServerUrl ? { url: devServerUrl } : {}),
  hostname: "tasfer.app",
  androidScheme: "https",
  allowNavigation: ["tasfer.app"],
};

/** @type {import('@capacitor/cli').CapacitorConfig['ios']} */
export const ios = {
  backgroundColor: "#101012",
  contentInset: "never",
  preferredContentMode: "mobile",
  scheme: "https",
  path: "../ios",
};

/** @type {import('@capacitor/cli').CapacitorConfig['android']} */
export const android = {
  backgroundColor: "#101012",
  path: "../android",
};

/** @type {import('@capacitor/cli').CapacitorConfig['plugins']} */
export const plugins = {
  CapacitorHttp: {
    enabled: false,
  },
  CapacitorUpdater: {
    // Over-the-air web bundle updates, driven by src/platform/mobileUpdate.ts.
    // The plugin only downloads, swaps and rolls back bundles; it never talks
    // to Capgo's servers. "off" stops its own update checks (we read a static
    // manifest from our GitHub release instead) and the empty statsUrl stops
    // its usage reporting.
    autoUpdate: "off",
    statsUrl: "",
    // How long a freshly applied bundle has to report that its code is running
    // (notifyAppReady) before the plugin puts the previous bundle back. Double
    // the 10 s default: putting back a good bundle on a slow phone is a worse
    // outcome than a few more seconds of blank screen on a dead one.
    appReadyTimeout: 20000,
    // Seconds, for the plugin's network requests. On iOS it also caps the
    // whole bundle download (this value plus 5 s), not just a stall: at the
    // 20 s default a 10 MB bundle needs about 3.3 Mbit/s or it is cut off,
    // which a weak mobile signal does not give. 120 s brings that down to
    // well under 1 Mbit/s. Android uses it as a stall timeout only.
    responseTimeout: 120,
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
};
