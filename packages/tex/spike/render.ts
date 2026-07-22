/**
 * Generate a PNG of the @tasfer/tex capability gallery.
 *
 *   node --experimental-strip-types spike/render.ts [out.png]
 *
 * Uses a Skia-backed canvas (@napi-rs/canvas) so the exact same `paintMath`
 * code that runs in the browser draws into an off-screen surface, then writes
 * the result to disk. The KaTeX WOFF2 faces are registered under the same
 * family names the engine expects (`fontFamily(variant)`).
 */
import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

import { ALL_VARIANTS, fontFamily } from "../src/fonts/fonts.ts";
import { buildLayout, PAGE_W, paintGallery } from "./gallery.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, "..", "src", "fonts");
const SCALE = 2; // render at 2× for crisp output

function registerFonts(): void {
  const present = new Set(readdirSync(FONT_DIR));
  for (const variant of ALL_VARIANTS) {
    const file = `KaTeX_${variant}.woff2`;
    if (!present.has(file)) {
      console.warn(`! missing font ${file}`);
      continue;
    }
    GlobalFonts.registerFromPath(join(FONT_DIR, file), fontFamily(variant));
  }
}

async function main(): Promise<void> {
  registerFonts();

  const { placed, totalH } = buildLayout();
  const canvas = createCanvas(PAGE_W * SCALE, totalH * SCALE);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.scale(SCALE, SCALE);

  paintGallery(ctx, placed, totalH);

  const out = process.argv[2] ?? join(HERE, "gallery.png");
  const png = canvas.toBuffer("image/png");
  await writeFile(out, png);
  console.log(
    `wrote ${out} — ${PAGE_W}×${Math.round(totalH)} @${SCALE}x (${(png.length / 1024).toFixed(0)} KB)`,
  );
}

void main();
