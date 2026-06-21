/**
 * Headless render harness — the canvas-paint counterpart to the numeric
 * `oracle.test.ts`. The oracle pins layout *dimensions*; this pins that the
 * *paint* actually lands where the layout says. It renders each expression
 * through the real `paintMath` onto an off-screen `@napi-rs/canvas`, with the
 * genuine KaTeX WOFF2 faces registered, then reads the pixels back and checks
 * the inked bounding box against the computed box.
 *
 * Deliberately NOT a golden-image diff: glyph rasterization varies by OS /
 * FreeType version, so committed reference PNGs would be flaky. Instead we
 * assert the *contract between layout and paint* — something is drawn, and it
 * sits within the reported `{width, height, depth}` (plus font overshoot) — a
 * stable, meaningful regression net that catches blank renders, NaN
 * coordinates, paint exceptions, and gross mispositioning.
 */
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { ALL_VARIANTS, fontFamily } from "../fonts/fonts";
import { layoutMath, paintMath } from "../index";

const FONT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fonts");
const FS = 40; // render font size (px)
const MARGIN = 30; // px of padding around the formula

beforeAll(() => {
  for (const v of ALL_VARIANTS) {
    const path = resolve(FONT_DIR, `KaTeX_${v}.woff2`);
    if (existsSync(path)) GlobalFonts.registerFromPath(path, fontFamily(v));
  }
});

/** Inked bounding box (alpha > threshold), in canvas pixels, or null if blank. */
function inkBounds(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { left: number; right: number; top: number; bottom: number; count: number } | null {
  let left = w, right = -1, top = h, bottom = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        count++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0 ? null : { left, right, top, bottom, count };
}

function render(expr: string, displayMode: boolean) {
  const m = layoutMath(expr, { fontSize: FS, displayMode });
  const cw = Math.ceil(m.width) + MARGIN * 2;
  const ch = Math.ceil(m.height + m.depth) + MARGIN * 2;
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  const baselineY = MARGIN + m.height; // baseline = top margin + height
  // The napi context is API-compatible with the 2D context paintMath expects.
  paintMath(ctx as unknown as CanvasRenderingContext2D, m, MARGIN, baselineY);
  const { data } = ctx.getImageData(0, 0, cw, ch);
  return { m, cw, ch, baselineY, ink: inkBounds(data, cw, ch) };
}

// A cross-section exercising every paint primitive: glyphs, rules (fraction
// bar, vinculum), and vector paths (surd, brace, vec arrow, stretchy hat).
const RENDER_CORPUS: [string, boolean][] = [
  ["x^2 + y^2", false],
  ["\\frac{a+b}{c}", false],
  ["\\sqrt{x^2+1}", false],
  ["\\left(\\frac{1}{2}\\right)", false],
  ["\\sum_{i=1}^{n} i", true],
  ["\\int_0^1 x\\,dx", false],
  ["\\overline{AB}", false],
  ["\\overbrace{x+y}", false],
  ["\\vec{v}", false],
  ["\\widehat{abc}", false],
  ["\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", true],
  ["\\begin{cases}a&x>0\\\\b&x<0\\end{cases}", true],
  ["\\alpha\\beta\\gamma\\delta", false],
];

/** Whether the inked pixels skew red (mean R clearly above mean G/B). */
function inkIsReddish(data: Uint8ClampedArray, w: number, h: number): boolean {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a > 16) {
      r += data[i * 4];
      g += data[i * 4 + 1];
      b += data[i * 4 + 2];
      n++;
    }
  }
  if (n === 0) return false;
  return r / n > g / n + 40 && r / n > b / n + 40;
}

function renderUnknownIsRed(pendingRange?: { start: number; end: number }) {
  // `\al` is an unrecognized command (lays out as a red placeholder); its source
  // is [0,3), so a pending range of {0,3} means "still being typed".
  const m = layoutMath("\\al", { fontSize: FS, displayMode: false });
  const cw = Math.ceil(m.width) + MARGIN * 2;
  const ch = Math.ceil(m.height + m.depth) + MARGIN * 2;
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  paintMath(ctx as unknown as CanvasRenderingContext2D, m, MARGIN, MARGIN + m.height, {
    color: "#000000",
    pendingRange,
  });
  return inkIsReddish(ctx.getImageData(0, 0, cw, ch).data, cw, ch);
}

describe("unknown-command error color is suppressed while typing", () => {
  it("renders red when not in a pending range", () => {
    expect(renderUnknownIsRed(undefined)).toBe(true);
  });
  it("suppresses red across the whole in-progress command", () => {
    expect(renderUnknownIsRed({ start: 0, end: 3 })).toBe(false);
  });
  it("keeps red when the pending range doesn't cover it", () => {
    expect(renderUnknownIsRed({ start: 5, end: 8 })).toBe(true);
  });
});

describe("paint lands within the layout box", () => {
  for (const [expr, dm] of RENDER_CORPUS) {
    it(`${dm ? "[display] " : ""}${expr}`, () => {
      const { m, baselineY, ink } = render(expr, dm);
      // Something was drawn.
      expect(ink, "expected non-blank render").not.toBeNull();
      expect(ink!.count).toBeGreaterThan(20);

      // Ink sits within the reported box, allowing for font overshoot — glyph
      // ink legitimately spills a little past the TeX metric box (esp. tall
      // delimiters and integrals), so the tolerance is generous but bounded.
      const vtol = 0.55 * FS;
      const htol = 0.35 * FS;
      expect(ink!.left).toBeGreaterThanOrEqual(MARGIN - htol);
      expect(ink!.right).toBeLessThanOrEqual(MARGIN + m.width + htol);
      expect(ink!.top).toBeGreaterThanOrEqual(baselineY - m.height - vtol);
      expect(ink!.bottom).toBeLessThanOrEqual(baselineY + m.depth + vtol);

      // The ink should fill a meaningful fraction of the advance width — guards
      // against everything collapsing into a corner.
      const inkW = ink!.right - ink!.left;
      expect(inkW).toBeGreaterThan(Math.min(0.3 * m.width, 0.5 * FS));
    });
  }
});
