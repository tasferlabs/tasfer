// Generates the iOS asset-catalog imagesets for the native mobile toolbar from
// a single curated SVG folder.
//
// Why this exists: the iOS accessory bar (apps/ios/.../NoAccessoryWebView.swift)
// is drawn with UIKit, not the WebView, so it cannot reuse the web toolbar's
// Lucide React icons. UIKit resolves icons with `UIImage(named:)`, which only
// reads the compiled Assets.car that Xcode's actool builds from
// Assets.xcassets at build time — it never reads loose .svg files at runtime.
// So every native icon must exist as an <name>.imageset in the catalog.
//
// Rather than hand-maintain those imagesets, this script treats them as a
// derived artifact: the curated SVGs in apps/ios/icons/ are the source art, and
// the MobileToolbarIcon union in src/app/mobileToolbar.ts is the source of truth
// for *which* icons the native toolbar needs. For each icon name it writes
// Assets.xcassets/<name>.imageset/ with the SVG plus a templated Contents.json
// (template-rendering-intent, so the tint colors in Swift apply).
//
// Run via `npm run gen:toolbar-icons` (also wired into the cap:sync scripts so
// the catalog is regenerated before every native sync).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..", "..");

const TOOLBAR_SOURCE = join(webRoot, "src", "app", "mobileToolbar.ts");
const CURATED_DIR = join(repoRoot, "apps", "ios", "icons");
const CATALOG_DIR = join(
  repoRoot,
  "apps",
  "ios",
  "App",
  "App",
  "Assets.xcassets",
);

// Imagesets in the catalog that this generator does NOT own (non-toolbar art).
// Anything else ending in .imageset is fair game to be reported as an orphan.
const NON_TOOLBAR_IMAGESETS = new Set(["Splash"]);

/** Parse the `MobileToolbarIcon` string-union to get the required icon names. */
function readRequiredIconNames() {
  // Strip comments first: the union is delimited by the `;` after its last
  // member, but a `;` inside a `//` explanation for one of the icons would
  // otherwise truncate the `[^;]*` capture and silently drop every member after
  // it (and the icons they name would never be generated).
  const src = readFileSync(TOOLBAR_SOURCE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const match = src.match(/export type MobileToolbarIcon =([^;]*);/);
  if (!match) {
    throw new Error(
      `Could not find the MobileToolbarIcon union in ${TOOLBAR_SOURCE}. ` +
        `If it was renamed, update gen-mobile-toolbar-icons.mjs.`,
    );
  }
  const names = [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error("MobileToolbarIcon union parsed to zero icon names.");
  }
  return names;
}

// Xcode writes asset-catalog JSON with a space before every colon
// (`"key" : value`). We match that byte-for-byte so regenerating the catalog
// produces no diff against files Xcode last touched.
function contentsJson(svgFile) {
  const json = JSON.stringify(
    {
      images: [{ filename: svgFile, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
      properties: {
        "preserves-vector-representation": true,
        "template-rendering-intent": "template",
      },
    },
    null,
    2,
  );
  // Insert a space before structural colons. Keys and values here never contain
  // a `":` sequence, so this only matches the separators JSON.stringify emitted.
  return json.replace(/":/g, '" :') + "\n";
}

function main() {
  const required = readRequiredIconNames();

  const missing = required.filter(
    (name) => !existsSync(join(CURATED_DIR, `${name}.svg`)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing curated SVG(s) in ${CURATED_DIR}:\n` +
        missing.map((n) => `  - ${n}.svg`).join("\n") +
        `\nAdd the artwork there (one <name>.svg per MobileToolbarIcon).`,
    );
  }

  for (const name of required) {
    const svg = readFileSync(join(CURATED_DIR, `${name}.svg`), "utf8");
    const imageset = join(CATALOG_DIR, `${name}.imageset`);
    mkdirSync(imageset, { recursive: true });

    // Clear stale .svg files (e.g. a renamed source) so the imageset only ever
    // contains the one image its Contents.json references.
    for (const file of readdirSync(imageset)) {
      if (file.endsWith(".svg") && file !== `${name}.svg`) {
        rmSync(join(imageset, file));
      }
    }

    writeFileSync(join(imageset, `${name}.svg`), svg);
    writeFileSync(join(imageset, "Contents.json"), contentsJson(`${name}.svg`));
  }

  console.log(
    `gen-mobile-toolbar-icons: wrote ${required.length} imageset(s) to ` +
      `Assets.xcassets from apps/ios/icons.`,
  );

  // Report imagesets in the catalog that no MobileToolbarIcon references, so a
  // removed toolbar icon doesn't silently leave dead art behind. Non-fatal:
  // deletion is left to a human, since the catalog can hold unrelated assets.
  const requiredSet = new Set(required);
  const orphans = readdirSync(CATALOG_DIR)
    .filter((entry) => entry.endsWith(".imageset"))
    .map((entry) => entry.slice(0, -".imageset".length))
    .filter(
      (name) =>
        !requiredSet.has(name) &&
        !NON_TOOLBAR_IMAGESETS.has(name) &&
        // `math_*` imagesets are owned by gen-math-chip-icons.mjs, not this one.
        !name.startsWith("math_"),
    );
  if (orphans.length > 0) {
    console.warn(
      `gen-mobile-toolbar-icons: ${orphans.length} imageset(s) not referenced ` +
        `by MobileToolbarIcon (remove if unused): ${orphans.join(", ")}`,
    );
  }
}

main();
