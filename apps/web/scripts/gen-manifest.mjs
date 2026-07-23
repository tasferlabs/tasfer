// Generates the PWA web app manifests from the SAME i18next locale files the web
// app uses (public/app/locales/<lng>/translation.json).
//
// Why this exists: the manifest is fetched by the browser, not by the app, so
// nothing in it can come from i18next at runtime — it is what the install
// prompt, the home-screen label and the task-switcher entry are drawn from. The
// Web App Manifest format has no per-locale fields either, so the only way to
// localize it is one manifest per language, selected by the `<link rel=manifest>`
// href (see the inline script in index.html).
//
// Emits public/manifest.json for the source locale and public/manifest.<lng>.json
// for the rest, each carrying `lang`/`dir` so the browser renders the metadata
// with the right script direction.
//
// `name` and `short_name` are deliberately NOT translated: Android keeps
// `app_name` as non-translatable config in res/values/strings.xml, so the brand
// reads the same on every install surface.
//
// Screenshot images are shared across locales (the app UI in them is English);
// only their accessibility labels are localized.
//
// Run via `npm run gen:manifest` (wired into `prebuild`, so a build can never
// ship a stale manifest).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");

const LOCALES_DIR = join(webRoot, "public", "app", "locales");
const PUBLIC_DIR = join(webRoot, "public");

// Translation keys for the localized fields. Shortcut names reuse the page
// titles of the routes they open, so the wording can never drift from the app.
const DESCRIPTION_KEY = "manifest.description";
const SCREENSHOT_LABEL_KEYS = {
  desktopLight: "manifest.screenshots.desktopLight",
  desktopDark: "manifest.screenshots.desktopDark",
  mobileLight: "manifest.screenshots.mobileLight",
  mobileDark: "manifest.screenshots.mobileDark",
};
const SHORTCUT_KEYS = {
  newPage: "page.newPage",
  calendar: "calendar.title",
  archive: "archive.title",
};

// Locales to emit. The first is the source locale and owns manifest.json — the
// href index.html ships with, and the fallback for any locale without a file.
const LOCALES = [
  { lng: "en", dir: "ltr" },
  { lng: "ar", dir: "rtl" },
];
const SOURCE_LNG = LOCALES[0].lng;

// On Vercel the app is served under /app (microfrontend child); every URL in
// the manifest must carry that prefix. Native builds serve from the root.
const ROOT = process.env.VERCEL ? "/app" : "";
const p = (url) => `${ROOT}${url}`;

// Everything the manifest carries that isn't language-dependent.
const BASE = {
  name: "Tasfer",
  short_name: "Tasfer",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  // A canvas editor works in every posture; locking orientation would fight
  // tablets and foldables.
  orientation: "any",
  background_color: "#ffffff",
  theme_color: "#ffffff",
  categories: ["productivity", "utilities"],
  // Focus the already-running app instead of piling up windows; falls back to
  // default behavior where launch_handler is unsupported.
  launch_handler: { client_mode: ["navigate-existing", "auto"] },
  icons: [
    {
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-maskable-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: "/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: "/icon-mono-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "monochrome",
    },
  ],
};

// Screenshot images with their localized-label keys. `form_factor: "wide"`
// feeds desktop install UI, `"narrow"` feeds mobile.
const SCREENSHOTS = [
  {
    src: "/screenshots/desktop-light.png",
    sizes: "2560x1600",
    type: "image/png",
    form_factor: "wide",
    labelKey: SCREENSHOT_LABEL_KEYS.desktopLight,
  },
  {
    src: "/screenshots/desktop-dark.png",
    sizes: "2560x1600",
    type: "image/png",
    form_factor: "wide",
    labelKey: SCREENSHOT_LABEL_KEYS.desktopDark,
  },
  {
    src: "/screenshots/mobile-light.png",
    sizes: "780x1688",
    type: "image/png",
    form_factor: "narrow",
    labelKey: SCREENSHOT_LABEL_KEYS.mobileLight,
  },
  {
    src: "/screenshots/mobile-dark.png",
    sizes: "780x1688",
    type: "image/png",
    form_factor: "narrow",
    labelKey: SCREENSHOT_LABEL_KEYS.mobileDark,
  },
];

const SHORTCUTS = [
  { nameKey: SHORTCUT_KEYS.newPage, url: "/page?new" },
  { nameKey: SHORTCUT_KEYS.calendar, url: "/calendar" },
  { nameKey: SHORTCUT_KEYS.archive, url: "/archive" },
];

function loadLocale(lng) {
  return JSON.parse(
    readFileSync(join(LOCALES_DIR, lng, "translation.json"), "utf8"),
  );
}

function main() {
  const tables = Object.fromEntries(
    LOCALES.map(({ lng }) => [lng, loadLocale(lng)]),
  );
  const base = tables[SOURCE_LNG];

  const requiredKeys = [
    DESCRIPTION_KEY,
    ...Object.values(SCREENSHOT_LABEL_KEYS),
    ...Object.values(SHORTCUT_KEYS),
  ];
  for (const key of requiredKeys) {
    if (typeof base[key] !== "string") {
      throw new Error(
        `Translation key "${key}" missing from ` +
          `${SOURCE_LNG}/translation.json for gen-manifest.mjs.`,
      );
    }
  }

  for (const { lng, dir } of LOCALES) {
    const table = tables[lng];
    // Localized lookup with source-locale fallback (warned, never fatal).
    const t = (key) => {
      if (typeof table[key] === "string") return table[key];
      if (lng !== SOURCE_LNG) {
        console.warn(
          `gen-manifest: ${lng} missing "${key}", falling back to ${SOURCE_LNG}.`,
        );
      }
      return base[key];
    };

    // `name`/`short_name` first so the file reads like the old hand-authored
    // one; `lang`/`dir` next to the text they describe.
    const manifest = {
      name: BASE.name,
      short_name: BASE.short_name,
      description: t(DESCRIPTION_KEY),
      lang: lng,
      dir,
      id: p(BASE.id),
      start_url: p(BASE.start_url),
      scope: p(BASE.scope),
      display: BASE.display,
      orientation: BASE.orientation,
      background_color: BASE.background_color,
      theme_color: BASE.theme_color,
      categories: BASE.categories,
      launch_handler: BASE.launch_handler,
      icons: BASE.icons.map((icon) => ({ ...icon, src: p(icon.src) })),
      screenshots: SCREENSHOTS.map(({ labelKey, ...shot }) => ({
        ...shot,
        src: p(shot.src),
        label: t(labelKey),
      })),
      shortcuts: SHORTCUTS.map(({ nameKey, url }) => ({
        name: t(nameKey),
        url: p(url),
      })),
    };

    const file = lng === SOURCE_LNG ? "manifest.json" : `manifest.${lng}.json`;
    writeFileSync(
      join(PUBLIC_DIR, file),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    console.log(`gen-manifest: wrote public/${file} (${lng}).`);
  }
}

main();
