/**
 * The live-edit caret model: caret stops must land on real source offsets, and
 * hit-test ∘ caret-rect must round-trip (clicking a caret's x returns its
 * offset). This is the invariant that keeps an in-formula caret coherent.
 */
import { describe, expect, it } from "vitest";

import { caretRect, caretStops, hitTest, layoutMath, selectionRects } from "../index.ts";

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

  it("returns a selection rect spanning a range", () => {
    const layout = layoutMath("abc", { fontSize: 16 });
    const rects = selectionRects(layout, 0, 3);
    expect(rects.length).toBe(1);
    expect(rects[0].width).toBeGreaterThan(0);
    expect(rects[0].height).toBeGreaterThan(0);
  });
});
