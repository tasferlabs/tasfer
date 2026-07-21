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
// Run via `npm run gen:manifest` (wired into `prebuild`, so a build can never
// ship a stale manifest).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");

const LOCALES_DIR = join(webRoot, "public", "app", "locales");
const PUBLIC_DIR = join(webRoot, "public");

// Translation key for the localized fields.
const DESCRIPTION_KEY = "manifest.description";

// Locales to emit. The first is the source locale and owns manifest.json — the
// href index.html ships with, and the fallback for any locale without a file.
const LOCALES = [
  { lng: "en", dir: "ltr" },
];
const SOURCE_LNG = LOCALES[0].lng;

// Everything the manifest carries that isn't language-dependent.
const BASE = {
  name: "Tasfer",
  short_name: "Tasfer",
  start_url: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#43a047",
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
  ],
};

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

  if (typeof base[DESCRIPTION_KEY] !== "string") {
    throw new Error(
      `Translation key "${DESCRIPTION_KEY}" missing from ` +
        `${SOURCE_LNG}/translation.json for gen-manifest.mjs.`,
    );
  }

  for (const { lng, dir } of LOCALES) {
    const table = tables[lng];
    const description =
      typeof table[DESCRIPTION_KEY] === "string"
        ? table[DESCRIPTION_KEY]
        : base[DESCRIPTION_KEY];
    if (lng !== SOURCE_LNG && typeof table[DESCRIPTION_KEY] !== "string") {
      console.warn(
        `gen-manifest: ${lng} missing "${DESCRIPTION_KEY}", ` +
          `falling back to ${SOURCE_LNG}.`,
      );
    }

    // `name`/`short_name` first so the file reads like the old hand-authored
    // one; `lang`/`dir` next to the text they describe.
    const manifest = {
      name: BASE.name,
      short_name: BASE.short_name,
      description,
      lang: lng,
      dir,
      start_url: BASE.start_url,
      display: BASE.display,
      background_color: BASE.background_color,
      theme_color: BASE.theme_color,
      icons: BASE.icons,
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
