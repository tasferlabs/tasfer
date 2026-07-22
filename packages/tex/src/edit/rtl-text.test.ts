/**
 * Caret and selection INSIDE a `\text{…}` run of characters the math fonts can't
 * render (Arabic, CJK, …). Such a run is painted as one browser-shaped box, but
 * the caret must still land between its characters, and — for an RTL run — the
 * logical-first character sits at the box's RIGHT edge, so screen order is
 * reversed from source order. See `fallbackCarets` / the `textCarets` box field.
 */
import {
  caretRect,
  caretStops,
  hitTest,
  layoutMath,
  selectionRects,
} from "../index";
import { describe, expect, it } from "vitest";

// Each code point ~0.5em wide (prefix widths are exact multiples), so boundary
// x's are predictable. Mirrors the host `measureText`-derived em metrics.
const measure = (text: string) => ({
  width: [...text].length * 0.5,
  ascent: 0.7,
  depth: 0.2,
});
const tf = { fontFamily: "sans", measure };
const fontSize = 16;

describe("caret inside a fallback text run", () => {
  it("Arabic: interior stops, reversed screen order, click round-trips", () => {
    // "\text{" is 6 chars, then ع ر ب ي at source offsets 6..9, then "}".
    const src = "\\text{عربي}";
    const layout = layoutMath(src, { fontSize, textFallback: tf });
    const stops = caretStops(layout);

    // Five boundaries (before each of 4 letters + after the last), at real source
    // offsets between "\text{" (6) and "}" (10).
    const offsets = stops.map((s) => s.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([6, 7, 8, 9, 10]);

    // RTL: the logical-first boundary (offset 6) is at the RIGHT (max x); the
    // final boundary (offset 10) is at the left (min x). So x decreases as the
    // source offset grows.
    const byOffset = new Map(stops.map((s) => [s.offset, s.x]));
    for (let o = 6; o < 10; o++) {
      expect(byOffset.get(o + 1)!).toBeLessThan(byOffset.get(o)!);
    }

    // hitTest ∘ caretRect round-trips for every interior boundary.
    for (const s of stops) {
      const r = caretRect(layout, s.offset)!;
      expect(hitTest(layout, r.x, r.top + 1)).toBe(s.offset);
    }
  });

  it("Arabic: partial selection highlights a sub-range, not the whole run", () => {
    const src = "\\text{عربي}"; // letters at 6,7,8,9
    const layout = layoutMath(src, { fontSize, textFallback: tf });
    const whole = selectionRects(layout, 6, 10);
    const part = selectionRects(layout, 8, 10); // last two letters only
    expect(whole).toHaveLength(1);
    expect(part).toHaveLength(1);
    // A two-letter sub-range is narrower than the whole four-letter run.
    expect(part[0].width).toBeLessThan(whole[0].width);
    expect(part[0].width).toBeGreaterThan(0);
  });

  it("CJK stays left-to-right (offset grows with x)", () => {
    const src = "\\text{中文}"; // 中 文 at offsets 6,7
    const layout = layoutMath(src, { fontSize, textFallback: tf });
    const stops = caretStops(layout);
    const offsets = stops.map((s) => s.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([6, 7, 8]);
    const byOffset = new Map(stops.map((s) => [s.offset, s.x]));
    expect(byOffset.get(7)!).toBeGreaterThan(byOffset.get(6)!);
    expect(byOffset.get(8)!).toBeGreaterThan(byOffset.get(7)!);
  });
});
