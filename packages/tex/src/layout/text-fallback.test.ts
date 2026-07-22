/**
 * `\text{…}` fallback for characters the KaTeX fonts have no metric for (CJK,
 * emoji, …). Without a `textFallback`, such a char lays out as the invisible
 * zero-width glyph (unchanged legacy behavior). WITH one, `layoutMath` measures
 * it from the host font and emits a real, painted glyph tagged with that font —
 * so `\text{中}` occupies its true width and draws, instead of vanishing.
 *
 * The measurer here is a deterministic stub (no canvas), so the test is pure.
 */
import { describe, expect, it } from "vitest";

import type { Box, GlyphBox } from "./box";
import { layoutMath, type TextFallback } from "../index";

/** Depth-first walk yielding every glyph box in a layout. */
function* glyphs(box: Box): Generator<GlyphBox> {
  if (box.type === "glyph") yield box;
  else if (box.type === "list") {
    for (const c of box.children) yield* glyphs(c.box);
  }
}

// A stub host font: 1em per code point, ascent 0.8, depth 0.2. A run is now
// measured as a whole substring (so cursive scripts shape), so the width scales
// with the run's length — a fixed per-call width would misreport multi-char runs.
const STUB: TextFallback = {
  fontFamily: "TestCJK",
  measure: (text) => ({ width: [...text].length, ascent: 0.8, depth: 0.2 }),
};

describe("\\text fallback for non-metric characters", () => {
  it("without a fallback, a CJK char lays out zero-width (legacy)", () => {
    const box = layoutMath("\\text{中}", { fontSize: 1 }).box;
    const g = [...glyphs(box)].find((b) => b.char === "中");
    expect(g).toBeDefined();
    expect(g!.width).toBe(0);
    expect(g!.textFont).toBeUndefined();
  });

  it("with a fallback, the CJK char is measured and tagged with the font", () => {
    const box = layoutMath("\\text{中}", {
      fontSize: 1,
      textFallback: STUB,
    }).box;
    const g = [...glyphs(box)].find((b) => b.char === "中");
    expect(g).toBeDefined();
    expect(g!.width).toBe(1); // measured width (em) × size multiplier (1)
    expect(g!.height).toBeCloseTo(0.8, 6);
    expect(g!.depth).toBeCloseTo(0.2, 6);
    expect(g!.textFont).toBe("TestCJK");
  });

  it("gives the whole \\text run a non-zero advance (formula grows)", () => {
    const bare = layoutMath("\\text{中文}", { fontSize: 10 }).width;
    const withFb = layoutMath("\\text{中文}", {
      fontSize: 10,
      textFallback: STUB,
    }).width;
    expect(bare).toBe(0);
    expect(withFb).toBeCloseTo(20, 6); // two 1em chars at fontSize 10
  });

  it("leaves Latin text on the math fonts (no fallback tag)", () => {
    const box = layoutMath("\\text{ab}", {
      fontSize: 1,
      textFallback: STUB,
    }).box;
    for (const g of glyphs(box)) {
      if (g.char === "a" || g.char === "b") {
        expect(g.textFont).toBeUndefined();
        expect(g.width).toBeGreaterThan(0);
      }
    }
  });

  it("shapes an Arabic word as ONE box (so it joins + bidi-orders, not per letter)", () => {
    // Arabic is cursive and RTL: laying each letter out as its own glyph in
    // source order renders disconnected, reversed isolated forms. The whole run
    // must be a single box carrying the substring, so the browser shapes it.
    const box = layoutMath("\\text{مرحبا}", {
      fontSize: 10,
      textFallback: STUB,
    }).box;
    const gs = [...glyphs(box)].filter((g) => g.textFont === "TestCJK");
    expect(gs).toHaveLength(1);
    expect(gs[0].char).toBe("مرحبا");
    expect(gs[0].width).toBeCloseTo(5, 6); // 5 code points × 1em (× size mult 1)
  });

  it("keeps a space BETWEEN fallback words inside one shaped run", () => {
    // A multi-word RTL phrase must stay one run so its words bidi-order; the
    // interior space rides along with the run (not split into a separate kern).
    const box = layoutMath("\\text{مرحبا بك}", {
      fontSize: 10,
      textFallback: STUB,
    }).box;
    const gs = [...glyphs(box)].filter((g) => g.textFont === "TestCJK");
    expect(gs).toHaveLength(1);
    expect(gs[0].char).toBe("مرحبا بك");
  });

  it("splits a fallback run at a native (Latin) char, not across it", () => {
    // "中a中" → two separate host-font runs with the Latin 'a' between them.
    const box = layoutMath("\\text{中a中}", {
      fontSize: 10,
      textFallback: STUB,
    }).box;
    const gs = [...glyphs(box)].filter((g) => g.textFont === "TestCJK");
    expect(gs.map((g) => g.char)).toEqual(["中", "中"]);
  });

  it("measures a CJK char nested inside a fraction numerator", () => {
    const box = layoutMath("\\frac{\\text{中}}{x}", {
      fontSize: 1,
      textFallback: STUB,
    }).box;
    const g = [...glyphs(box)].find((b) => b.char === "中");
    expect(g).toBeDefined();
    expect(g!.textFont).toBe("TestCJK");
    expect(g!.width).toBeGreaterThan(0);
  });
});
