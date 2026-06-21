/**
 * The live-edit caret model: caret stops must land on real source offsets, and
 * hit-test ∘ caret-rect must round-trip (clicking a caret's x returns its
 * offset). This is the invariant that keeps an in-formula caret coherent.
 */
import { describe, expect, it } from "vitest";

import { caretRect, caretStops, hitTest, layoutMath, selectionRects } from "../index";

describe("caret model", () => {
  it("produces stops at source-offset boundaries", () => {
    const layout = layoutMath("x^2+y", { fontSize: 16 });
    const stops = caretStops(layout);
    expect(stops.length).toBeGreaterThan(0);
    // Every stop offset is within the source string.
    for (const s of stops) {
      expect(s.offset).toBeGreaterThanOrEqual(0);
      expect(s.offset).toBeLessThanOrEqual("x^2+y".length);
      expect(s.bottom).toBeGreaterThan(s.top);
    }
    // Stops are sorted by offset.
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].offset).toBeGreaterThanOrEqual(stops[i - 1].offset);
    }
  });

  it("hit-test ∘ caret-rect round-trips at each stop", () => {
    const layout = layoutMath("a+b-c", { fontSize: 20 });
    for (const s of caretStops(layout)) {
      const rect = caretRect(layout, s.offset)!;
      // Clicking the caret's own x (mid-height) returns its offset.
      const mid = (rect.top + rect.bottom) / 2;
      const hit = hitTest(layout, rect.x, mid);
      expect(hit).toBe(s.offset);
    }
  });

  it("descends the caret into a fraction", () => {
    const layout = layoutMath("\\frac{a}{b}", { fontSize: 16 });
    const stops = caretStops(layout);
    // The numerator 'a' and denominator 'b' sit at very different heights.
    const ys = stops.map((s) => (s.top + s.bottom) / 2);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
  });

  it("steps through an unknown command character by character", () => {
    // "\al" is unrecognized (mid-typing "\alpha"). It is NOT a construct yet, so
    // the caret must stop at every source offset (0..3) — like plain text — not
    // just the run's outer edges. This is what makes the caret follow the typing
    // instead of snapping back to the leading `\`.
    const layout = layoutMath("\\al", { fontSize: 16 });
    const offsets = caretStops(layout).map((s) => s.offset);
    for (const o of [0, 1, 2, 3]) expect(offsets).toContain(o);
    // The stop at the trailing edge sits to the RIGHT of the one at the `\`.
    const xAt = (o: number) => caretRect(layout, o)!.x;
    expect(xAt(3)).toBeGreaterThan(xAt(1));
    expect(xAt(1)).toBeGreaterThan(xAt(0));
  });

  it("offers caret stops at the edges of a bare big operator", () => {
    // A standalone `\oint` lays out as one glyph wrapped in a list; its glyph
    // must carry the source span so the caret can sit before AND after it (a
    // regression where the caret was invisible/un-landable just after `\oint`).
    const layout = layoutMath("\\oint", { fontSize: 16 });
    const offsets = caretStops(layout).map((s) => s.offset);
    expect(offsets).toContain(0);
    expect(offsets).toContain("\\oint".length);
    expect(caretRect(layout, 5)).not.toBeNull();
    expect(caretRect(layout, 5)!.x).toBeGreaterThan(caretRect(layout, 0)!.x);
  });

  it("returns a selection rect spanning a range", () => {
    const layout = layoutMath("abc", { fontSize: 16 });
    const rects = selectionRects(layout, 0, 3);
    expect(rects.length).toBe(1);
    expect(rects[0].width).toBeGreaterThan(0);
    expect(rects[0].height).toBeGreaterThan(0);
  });

  it("highlights a whole construct even when a slot is empty", () => {
    // "\frac{}{b}" selected whole: the only glyph in range is `b`, but the
    // selection must cover the entire fraction (empty numerator + rule), not a
    // sliver around `b`. The construct's own bounding box drives the rect.
    const latex = "\\frac{}{b}";
    const layout = layoutMath(latex, { fontSize: 16 });
    const rects = selectionRects(layout, 0, latex.length);
    expect(rects.length).toBe(1);
    // The rect must be as wide as the whole fraction box, not just the `b`.
    expect(rects[0].width).toBeCloseTo(layout.width, 5);
    expect(rects[0].height).toBeGreaterThan(0);
  });
});
