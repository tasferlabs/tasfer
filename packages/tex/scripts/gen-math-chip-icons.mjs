// Pre-renders the `\`-command catalog into iOS asset-catalog imagesets so the
// native keyboard accessory can show the same live math chip row the web/Android
// in-webview toolbar shows.
//
// Why this exists: the web/Android chip row renders each construct with
// `renderToSVG`, whose glyphs are `<text>` in the KaTeX faces — that only paints
// where those `@font-face`s are loaded (a browser). The iOS accessory is native
// UIKit; actool can't resolve the TeX fonts when it rasterizes a catalog SVG, so
// a font-based SVG would render blank. Instead we rasterize each construct here,
// with the genuine WOFF2 faces registered, into template-rendering PNGs that the
// native bar tints to the toolbar foreground (so dark/light mode both work).
//
// The construct set is read straight from the engine catalog SOURCE
// (packages/editor/src/nodes/math-commands.ts) by text-parsing it — the same
// approach gen-mobile-toolbar-icons.mjs uses — so this script needs no
// cross-package import (the catalog lives in @cypherkit/editor, which does not
// resolve from packages/tex).
//
// Asset name per construct: `mathChipAssetName(id)`. Keep it byte-identical to
// the copy in apps/web/src/app/mobileToolbar.ts — the runtime model names the
// chip image with that function and the native bar looks it up by name.
//
// Run via `npm run gen:math-icons` (wired into apps/web's cap:sync / cap:build:ios).
//
// The PNGs this writes are committed to git: they are an iOS asset catalog that
// actool reads at Xcode build time, and not every build path runs this generator
// first (opening the project directly in Xcode, CI that skips gen:mobile-icons),
// so the catalog must be present in the tree. They are a checked-in derived
// artifact, the same as the toolbar SVG imagesets.
//
// Because the output is *raster*, byte-stability matters: anti-aliasing and font
// hinting can differ across @napi-rs/canvas versions, which would turn every
// regenerate into a noisy binary diff. For that reason @napi-rs/canvas is pinned
// to an exact version in package.json (not a caret range). Regenerate from the
// canonical build (apps/web `cap:build:ios`) rather than ad-hoc per machine, so
// the committed PNGs only change when the math catalog actually changes.

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
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

import {
  ALL_VARIANTS,
  fontFamily,
  layoutMath,
  paintMath,
} from "@cypherkit/tex";

const here = dirname(fileURLToPath(import.meta.url));
const texRoot = resolve(here, "..");
const repoRoot = resolve(texRoot, "..", "..");

const FONT_DIR = join(texRoot, "src", "fonts");
const CATALOG_SOURCE = join(
  repoRoot,
  "packages",
  "editor",
  "src",
  "nodes",
  "math-commands.ts",
);
const CATALOG_DIR = join(
  repoRoot,
  "apps",
  "ios",
  "App",
  "App",
  "Assets.xcassets",
);

// Render size (1x point size, px) and which @-scales to emit. All current iOS
// devices are @2x/@3x, so we skip the legacy 1x slot.
const BASE_FONT = 24;
const SCALES = [2, 3];

/**
 * Asset-catalog name for a construct id. Lowercase letters/digits pass through;
 * everything else (uppercase letters, `^`, `_`) is escaped as `-<hex>`. That is
 * injective and safe on a case-insensitive filesystem (`Pi` vs `pi`).
 *
 * MUST stay byte-identical to `mathChipAssetName` in
 * apps/web/src/app/mobileToolbar.ts.
 */
function mathChipAssetName(id) {
  let out = "math_";
  for (const ch of id) {
    out += /[a-z0-9]/.test(ch) ? ch : "-" + ch.codePointAt(0).toString(16);
  }
  return out;
}

/** Parse `{ id: "...", ..., latex: "..." }` pairs out of the catalog source. */
function readCatalog() {
  const src = readFileSync(CATALOG_SOURCE, "utf8");
  const re = /id:\s*"((?:\\.|[^"\\])*)"[\s\S]*?latex:\s*"((?:\\.|[^"\\])*)"/g;
  const out = [];
  for (const m of src.matchAll(re)) {
    out.push({ id: JSON.parse(`"${m[1]}"`), latex: JSON.parse(`"${m[2]}"`) });
  }
  if (out.length === 0) {
    throw new Error(`Parsed zero constructs from ${CATALOG_SOURCE}.`);
  }
  return out;
}

function registerFonts() {
  let registered = 0;
  for (const v of ALL_VARIANTS) {
    const path = join(FONT_DIR, `KaTeX_${v}.woff2`);
    if (existsSync(path) && GlobalFonts.registerFromPath(path, fontFamily(v))) {
      registered++;
    }
  }
  if (registered === 0) {
    throw new Error(`Registered no fonts from ${FONT_DIR}.`);
  }
}

/** Inked alpha bounds (alpha > 8), or null if nothing was drawn. */
function inkBounds(data, w, h) {
  let left = w,
    right = -1,
    top = h,
    bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0 ? null : { left, right, top, bottom };
}

/** Render one construct at one scale to a tight, transparent PNG buffer. */
function renderPng(latex, scale) {
  const fs = BASE_FONT * scale;
  const m = layoutMath(latex, { fontSize: fs, displayMode: false });
  // Generous margin so glyph overshoot (italics, big operators) is never
  // clipped; we trim back to the inked bounds afterward.
  const margin = Math.ceil(fs * 0.3);
  const w = Math.ceil(m.width) + margin * 2;
  const h = Math.ceil(m.height + m.depth) + margin * 2;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // Opaque glyphs on transparent — template rendering on iOS tints by alpha.
  paintMath(ctx, m, margin, margin + m.height, { color: "#000" });

  const { data } = ctx.getImageData(0, 0, w, h);
  const b = inkBounds(data, w, h);
  if (!b) return null;

  const pad = 2 * scale;
  const cw = b.right - b.left + 1 + pad * 2;
  const ch = b.bottom - b.top + 1 + pad * 2;
  const out = createCanvas(cw, ch);
  out.getContext("2d").drawImage(canvas, pad - b.left, pad - b.top);
  return out.toBuffer("image/png");
}

// Xcode writes asset-catalog JSON with a space before every colon; match that
// byte-for-byte so regenerating produces no diff against actool's output.
function contentsJson(assetName) {
  const json = JSON.stringify(
    {
      images: SCALES.map((s) => ({
        filename: `${assetName}@${s}x.png`,
        idiom: "universal",
        scale: `${s}x`,
      })),
      info: { author: "xcode", version: 1 },
      properties: {
        "template-rendering-intent": "template",
      },
    },
    null,
    2,
  );
  return json.replace(/":/g, '" :') + "\n";
}

function main() {
  registerFonts();
  const catalog = readCatalog();
  const wanted = new Set();

  let blank = 0;
  for (const { id, latex } of catalog) {
    const assetName = mathChipAssetName(id);
    wanted.add(`${assetName}.imageset`);
    const imageset = join(CATALOG_DIR, `${assetName}.imageset`);
    mkdirSync(imageset, { recursive: true });

    // Drop stale files so the imageset only holds the images its Contents.json
    // references.
    for (const file of readdirSync(imageset)) rmSync(join(imageset, file));

    for (const scale of SCALES) {
      const png = renderPng(latex, scale);
      if (!png) {
        blank++;
        continue;
      }
      writeFileSync(join(imageset, `${assetName}@${scale}x.png`), png);
    }
    writeFileSync(join(imageset, "Contents.json"), contentsJson(assetName));
  }

  console.log(
    `gen-math-chip-icons: wrote ${catalog.length} math imageset(s) to ` +
      `Assets.xcassets.${blank ? ` (${blank} blank render(s) skipped)` : ""}`,
  );

  // Remove math imagesets no longer backed by a catalog construct — they are
  // fully derived, so stale ones are safe to delete.
  const stale = readdirSync(CATALOG_DIR).filter(
    (entry) =>
      entry.startsWith("math_") &&
      entry.endsWith(".imageset") &&
      !wanted.has(entry),
  );
  for (const entry of stale)
    rmSync(join(CATALOG_DIR, entry), { recursive: true });
  if (stale.length > 0) {
    console.log(
      `gen-math-chip-icons: removed ${stale.length} stale imageset(s).`,
    );
  }
}

main();
