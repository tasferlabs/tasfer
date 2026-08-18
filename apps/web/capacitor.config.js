import { readFileSync } from "node:fs";
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

// The bundle version the built-in bundle reports to the update server.
//
// Inferred from this package's version rather than tracked separately: it is
// already the value vite.config.ts injects as __APP_VERSION__ and the one
// set-native-version.mjs stamps onto MARKETING_VERSION / tasferVersionName, so
// the app has exactly one version line and nothing to remember to bump.
const bundleVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

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
  // Live (OTA) web-bundle updates. The server is apps/updates.
  CapacitorUpdater: {
    // Check on every foreground and download in the background, but never swap
    // the running bundle on our own — src/liveUpdates.ts applies a downloaded
    // bundle only when the user accepts the update prompt. A document editor
    // must not reload itself mid-edit, and Apple's review guidelines caution
    // against forcing an update to reach functionality.
    autoUpdate: "onlyDownload",
    // All three MUST be set. Their defaults point at plugin.capgo.app, so
    // leaving any unset would send our app id and a per-install device id to
    // Capgo's cloud on every launch. See apps/updates.
    updateUrl: "https://updates.tasfer.app/check",
    channelUrl: "https://updates.tasfer.app/channel",
    statsUrl: "https://updates.tasfer.app/stats",
    // The built-in bundle's version, baked into the native project by
    // `cap copy` — a shipped store build reports this forever, so it has to
    // sit on the same ordered line as the bundles the server will serve.
    // Plain X.Y.Z only: semver ranks `-prerelease` BELOW the release and
    // ignores `+build` entirely, so either suffix would read as a downgrade.
    version: bundleVersion,
    // Default is 10s. A cold start here boots a SharedWorker, SQLite on an
    // IndexedDB VFS, and OPFS; on a low-end Android that can overrun and roll
    // back a perfectly good bundle. Only applies to downloaded bundles, but
    // there is no reason to wait until there are some.
    appReadyTimeout: 30000,
  },
};
