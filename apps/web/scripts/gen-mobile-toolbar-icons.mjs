// Generates the iOS asset-catalog imagesets for the native mobile toolbar from
// the SAME icon set the web toolbar uses.
//
// Why this exists: the iOS accessory bar (apps/ios/.../NoAccessoryWebView.swift)
// is drawn with UIKit, not the WebView, so it cannot reuse the web toolbar's
// Lucide React components at runtime. UIKit resolves icons with
// `UIImage(named:)`, which only reads the compiled Assets.car that Xcode's
// actool builds from Assets.xcassets at build time — it never reads loose .svg
// files at runtime. So every native icon must exist as an <name>.imageset in the
// catalog.
//
// Rather than hand-maintain a parallel folder of SVGs (which drifts from the web
// glyphs), this script treats the imagesets as a DERIVED artifact of Lucide —
// the exact source the web bar imports (`lucide-react`). It reads the matching
// SVGs from `lucide-static` (a dev dep pinned to the same version) and, for the
// one glyph Lucide lacks (`mathcommand`, a backslash), an inline copy kept
// byte-identical to the web bar's inline SVG (MobileKeyboardToolbar.tsx).
//
// Source of truth for *which* icons the native toolbar needs is the
// MobileToolbarIcon union in src/app/mobileToolbar.ts; the LUCIDE/CUSTOM maps
// below say *where each one's art comes from*. Every union member must be
// covered by exactly one map, or this script throws — so adding a toolbar icon
// forces a matching entry here (the web bar's `ICONS` table is the reference for
// the Lucide name to use).
//
// Run via `npm run gen:toolbar-icons` (also wired into the cap:sync scripts so
// the catalog is regenerated before every native sync).

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..", "..");

const TOOLBAR_SOURCE = join(webRoot, "src", "app", "mobileToolbar.ts");
const CATALOG_DIR = join(
  repoRoot,
  "apps",
  "ios",
  "App",
  "App",
  "Assets.xcassets",
);

// Resolve the lucide-static icons directory (dev dep, hoisted or local).
const require = createRequire(import.meta.url);
const LUCIDE_ICONS_DIR = join(
  dirname(require.resolve("lucide-static/package.json")),
  "icons",
);

// MobileToolbarIcon -> lucide-static icon filename (without `.svg`). These MUST
// match the Lucide components the web bar renders in `ICONS`
// (MobileKeyboardToolbar.tsx) so both shells draw the identical glyph. Where a
// Lucide component is an alias, the file is the canonical icon: MoreHorizontal ->
// ellipsis, Link2 -> link-2, Undo2 -> undo-2, etc.
const LUCIDE = {
  undo: "undo-2",
  redo: "redo-2",
  bold: "bold",
  italic: "italic",
  code: "code",
  math: "sigma",
  strikethrough: "strikethrough",
  text: "type",
  paragraph: "pilcrow",
  heading1: "heading-1",
  heading2: "heading-2",
  heading3: "heading-3",
  quote: "quote",
  list: "list",
  list_ordered: "list-ordered",
  list_todo: "list-checks",
  image: "image",
  link: "link-2",
  line: "minus",
  keyboard_dismiss: "x",
  indent: "indent-increase",
  outdent: "indent-decrease",
  todo_check: "check",
  more: "ellipsis",
  matrix: "grid-3x3",
  caret_left: "arrow-left",
  caret_right: "arrow-right",
  code_language: "languages",
};

// Icons Lucide has no glyph for. The body is spliced into the same canonical
// <svg> wrapper as the Lucide icons. Keep byte-identical to the web bar's inline
// copy so both shells match.
const CUSTOM_BODY = {
  // A backslash `\` — the character the button types to open math commands.
  mathcommand: `<path d="m5 5 14 14" />`,
};

// Canonical Lucide open tag (width/stroke/etc. shared by every Lucide icon). We
// normalize onto this so the committed art is a stable, class-free, one-line
// header regardless of how lucide-static formats its source.
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">';

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

/** Normalize a lucide-static SVG onto the canonical wrapper: drop the license
 *  comment and the web-only `class`, and re-emit the body under {@link SVG_OPEN}. */
function normalizeLucideSvg(raw, name) {
  const withoutComment = raw.replace(/<!--[\s\S]*?-->/g, "");
  const openEnd = withoutComment.indexOf(">");
  const closeStart = withoutComment.lastIndexOf("</svg>");
  if (openEnd < 0 || closeStart < 0) {
    throw new Error(`Unexpected lucide-static SVG shape for "${name}".`);
  }
  const body = withoutComment.slice(openEnd + 1, closeStart).trim();
  return `${SVG_OPEN}\n  ${body}\n</svg>\n`;
}

/** The final SVG text for one MobileToolbarIcon, from Lucide or the custom map. */
function renderIcon(name) {
  if (name in CUSTOM_BODY) {
    return `${SVG_OPEN}\n  ${CUSTOM_BODY[name]}\n</svg>\n`;
  }
  const file = LUCIDE[name];
  const raw = readFileSync(join(LUCIDE_ICONS_DIR, `${file}.svg`), "utf8");
  return normalizeLucideSvg(raw, name);
}

// Imagesets in the catalog that this generator does NOT own (non-toolbar art).
// Anything else ending in .imageset is fair game to be reported as an orphan.
const NON_TOOLBAR_IMAGESETS = new Set(["Splash"]);

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

  // Every union member must have exactly one art source; a new toolbar icon with
  // no mapping fails loudly here rather than silently missing from the catalog.
  const unmapped = required.filter(
    (name) => !(name in LUCIDE) && !(name in CUSTOM_BODY),
  );
  if (unmapped.length > 0) {
    throw new Error(
      `MobileToolbarIcon(s) with no art source in gen-mobile-toolbar-icons.mjs:\n` +
        unmapped.map((n) => `  - ${n}`).join("\n") +
        `\nAdd each to the LUCIDE map (matching the Lucide icon the web bar uses ` +
        `in MobileKeyboardToolbar.tsx) or, if Lucide has no glyph, to CUSTOM_BODY.`,
    );
  }

  for (const name of required) {
    const svg = renderIcon(name);
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
      `Assets.xcassets from Lucide (lucide-static).`,
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
