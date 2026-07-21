// Generates the iOS Info.plist permission strings from the SAME i18next locale
// files the web app uses (public/app/locales/<lng>/translation.json).
//
// Why this exists: iOS shows the NS*UsageDescription strings verbatim in its
// system permission dialogs — native text the WebView never draws, so it cannot
// come from i18next at runtime. To keep those in the one translation store
// (instead of hand-maintaining English-only text in Info.plist), this script
// treats them as a DERIVED artifact: it writes an InfoPlist.xcstrings String
// Catalog with every locale, and rewrites the base Info.plist values from the
// source locale so the plist can't drift from translation.json.
//
// A String Catalog is a single file (like Assets.xcassets), so once it is
// registered in project.pbxproj — file ref + Resources build phase, with `ar`
// added to knownRegions — adding a language needs no further Xcode-project edits.
//
// Source of truth for *which* Info.plist keys are localized is the IOS_INFOPLIST
// map below; each maps an Info.plist key to a translation key that must exist in
// the source locale, or this script throws. Localized values fall back to the
// source locale per key, matching i18next's `fallbackLng: "en"`.
//
// Run via `npm run gen:ios-strings` (also wired into the cap:sync scripts so the
// catalog is regenerated before every native sync).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..", "..");

const LOCALES_DIR = join(webRoot, "public", "app", "locales");
const IOS_APP_DIR = join(repoRoot, "apps", "ios", "App", "App");
const CATALOG = join(IOS_APP_DIR, "InfoPlist.xcstrings");
const INFO_PLIST = join(IOS_APP_DIR, "Info.plist");

// Info.plist key -> translation key. Adding a localized Info.plist string means
// adding an entry here and the key to translation.json.
const IOS_INFOPLIST = {
  NSCameraUsageDescription: "native.cameraUsageDescription",
  NSPhotoLibraryUsageDescription: "native.photoLibraryUsageDescription",
};

// Locales to emit. The first is the catalog's source language and the per-key
// fallback for every other locale.
const LOCALES = ["en", "ar"];
const SOURCE_LNG = LOCALES[0];

function loadLocale(lng) {
  return JSON.parse(
    readFileSync(join(LOCALES_DIR, lng, "translation.json"), "utf8"),
  );
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Build the String Catalog object with keys sorted for a stable diff.
function buildCatalog(tables) {
  const base = tables[SOURCE_LNG];
  const strings = {};
  for (const plistKey of Object.keys(IOS_INFOPLIST).sort()) {
    const key = IOS_INFOPLIST[plistKey];
    const localizations = {};
    for (const lng of LOCALES) {
      const table = tables[lng];
      const value = typeof table[key] === "string" ? table[key] : base[key];
      if (lng !== SOURCE_LNG && typeof table[key] !== "string") {
        console.warn(
          `gen-ios-strings: ${lng} missing "${key}", ` +
            `falling back to ${SOURCE_LNG} for ${plistKey}.`,
        );
      }
      localizations[lng] = {
        stringUnit: { state: "translated", value },
      };
    }
    strings[plistKey] = { extractionState: "manual", localizations };
  }
  return { sourceLanguage: SOURCE_LNG, strings, version: "1.0" };
}

// Rewrite the base Info.plist value for each localized key from the source
// locale, so the plist fallback can never drift from translation.json.
function syncInfoPlist(base) {
  let plist = readFileSync(INFO_PLIST, "utf8");
  for (const plistKey of Object.keys(IOS_INFOPLIST)) {
    const value = escapeXml(base[IOS_INFOPLIST[plistKey]]);
    const re = new RegExp(
      `(<key>${plistKey}</key>\\s*<string>)([^<]*)(</string>)`,
    );
    if (!re.test(plist)) {
      throw new Error(
        `Info.plist has no <string> for <key>${plistKey}</key>. ` +
          `Add the key to Info.plist, or remove it from IOS_INFOPLIST.`,
      );
    }
    plist = plist.replace(re, `$1${value}$3`);
  }
  writeFileSync(INFO_PLIST, plist);
}

function main() {
  const tables = Object.fromEntries(LOCALES.map((lng) => [lng, loadLocale(lng)]));
  const base = tables[SOURCE_LNG];

  const missing = Object.entries(IOS_INFOPLIST).filter(
    ([, key]) => typeof base[key] !== "string",
  );
  if (missing.length > 0) {
    throw new Error(
      `Translation key(s) missing from ${SOURCE_LNG}/translation.json for ` +
        `gen-ios-strings.mjs:\n` +
        missing.map(([plistKey, key]) => `  - ${plistKey} -> ${key}`).join("\n"),
    );
  }

  writeFileSync(CATALOG, JSON.stringify(buildCatalog(tables), null, 2) + "\n");
  syncInfoPlist(base);

  console.log(
    `gen-ios-strings: wrote ${Object.keys(IOS_INFOPLIST).length} key(s) x ` +
      `${LOCALES.length} locale(s) to InfoPlist.xcstrings and synced Info.plist.`,
  );
}

main();
