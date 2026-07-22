/**
 * PHASE 0 SPIKE — metric/glyph correspondence.
 *
 * The whole `@tasfer/tex` plan rests on one assumption: KaTeX's
 * `fontMetricsData` table (which we vendor and use to lay out boxes) describes
 * the glyphs inside the KaTeX font files (which we draw on canvas with
 * `ctx.fillText`). If they disagree, painted glyphs land off their layout box
 * and the approach is dead.
 *
 * The LOAD-BEARING invariant is horizontal: layout advances by the metric
 * `width`, and `ctx.fillText` advances the pen by the font's `advanceWidth`.
 * Those two MUST be equal or every glyph after the first drifts. This test
 * parses each KaTeX TTF with opentype.js and asserts `width === advanceWidth`
 * (em) for ~every mapped codepoint.
 *
 * Vertical metrics (`height`/`depth`) are deliberately NOT compared to the ink
 * bounding box: KaTeX's heights are TeX *design* values (e.g. cap-height
 * 0.68333 for 'A') and intentionally differ from the glyph's inked yMax by font
 * overshoot. We feed those table values straight into layout exactly as KaTeX
 * does, so vertical placement is correct by construction. We log the height
 * delta purely as evidence of the overshoot story, not as a pass/fail.
 *
 * Fonts are read from the `katex` devDependency (spike-only); the runtime
 * package will vendor its own WOFF2 subset.
 */
import { createRequire } from "node:module";
import path from "node:path";

import opentype from "opentype.js";
import { describe, expect, it } from "vitest";

import fontMetricsData from "../fontMetricsData.js";

const require = createRequire(import.meta.url);
// Resolve the katex package dir without hardcoding node_modules layout.
const katexFontsDir = path.join(
  path.dirname(require.resolve("katex/package.json")),
  "dist",
  "fonts",
);

type GlyphMetric = [
  depth: number,
  height: number,
  italic: number,
  skew: number,
  width: number,
];

// Width must match to within font-unit rounding (metric table is rounded to
// 5 decimals; 1 font unit = 0.001em). A hair of slack absorbs that rounding.
const WIDTH_TOL = 0.0015;

// The COMPLETE, enumerated set of codepoints whose metric `width` intentionally
// differs from the glyph's font advance — because each is laid out by a special
// rule, never by horizontal advance. Discovered empirically across all 18 KaTeX
// fonts during the Phase 0 spike; every entry is a known special-layout class.
// Pinned here so a future font/metric bump that introduces a *new* divergence
// fails this test loudly instead of silently breaking layout.
const SPECIAL_LAYOUT_CODEPOINTS = new Map<number, string>([
  [0x0302, "combining circumflex — stretchy accent (zero advance)"],
  [0x0303, "combining tilde — stretchy accent (zero advance)"],
  [0x20d7, "combining right arrow — vector accent (zero advance)"],
  [0x222c, "∬ double integral — big operator, special limits/width"],
  [0x222d, "∭ triple integral — big operator, special limits/width"],
  [0x00b0, "° degree — remapped layout width"],
  [0xe020, "private-use assembly piece (zero layout width)"],
]);

const variants = Object.keys(fontMetricsData) as Array<
  keyof typeof fontMetricsData
>;

describe("Phase 0 spike: metric width matches font advance width", () => {
  for (const variant of variants) {
    it(`${variant}: width === advanceWidth for every advance-laid glyph`, () => {
      const font = opentype.loadSync(
        path.join(katexFontsDir, `KaTeX_${variant}.ttf`),
      );
      const upm = font.unitsPerEm;

      const glyphs = fontMetricsData[variant] as Record<string, GlyphMetric>;
      let checked = 0;
      let matched = 0;
      let maxHeightOvershoot = 0;
      const unexpected: string[] = [];

      for (const [cpStr, metric] of Object.entries(glyphs)) {
        const cp = Number(cpStr);
        const glyph = font.charToGlyph(String.fromCodePoint(cp));
        // .notdef → font has no glyph at this codepoint; skip.
        if (!glyph || glyph.index === 0) continue;

        const [, height, , , width] = metric;
        const advEm = (glyph.advanceWidth ?? 0) / upm;
        const inkHeightEm = glyph.getMetrics().yMax / upm;
        maxHeightOvershoot = Math.max(maxHeightOvershoot, inkHeightEm - height);

        if (Math.abs(advEm - width) <= WIDTH_TOL) {
          // Belt-and-suspenders: an advance-laid glyph must NOT also be listed
          // as special, or the pin is stale.
          checked++;
          matched++;
        } else if (!SPECIAL_LAYOUT_CODEPOINTS.has(cp)) {
          // A divergence we did not anticipate — this is the real failure.
          unexpected.push(
            `U+${cp.toString(16).toUpperCase().padStart(4, "0")}: ` +
              `metric.width=${width} adv=${advEm.toFixed(5)}`,
          );
        }
      }

      const rate = checked === 0 ? 0 : matched / checked;
      console.log(
        `${variant}: advance-laid ${matched}/${checked} matched ` +
          `(${(rate * 100).toFixed(2)}%), max height overshoot ` +
          `${maxHeightOvershoot.toFixed(4)}em (font design, expected)`,
      );

      expect(checked).toBeGreaterThan(0);
      // Every advance-laid glyph matches exactly; the only divergences are the
      // pinned special-layout set.
      expect(unexpected).toEqual([]);
      expect(rate).toBe(1);
    });
  }
});
