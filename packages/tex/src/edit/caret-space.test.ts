/**
 * Explicit spacing commands (`\ `, `\quad`, `\,`) draw no ink but are real
 * source atoms: the caret must be able to sit at their edges, a tap must
 * select them, and a selection must cover their width — otherwise a formula
 * holding only `\ ` has no caret stop at all and reads as unenterable/empty.
 */
import { describe, expect, it } from "vitest";

import {
  caretStops,
  layoutMath,
  selectionRects,
  spanAtPoint,
} from "../index";

const FS = 16;

describe("explicit spacing commands are caret-addressable", () => {
  it("a lone control space has stops at both edges", () => {
    const layout = layoutMath("\\ ", { fontSize: FS });
    const stops = caretStops(layout);
    expect(stops.map((s) => s.offset)).toEqual([0, 2]);
    expect(stops[0].x).toBe(0);
    expect(stops[1].x).toBeCloseTo(0.3333 * FS, 3);
    // Ink-less: the stops still get a visible caret extent on the baseline.
    for (const s of stops) {
      expect(s.bottom).toBeGreaterThan(s.top);
    }
  });

  it("a lone \\quad has stops at both edges", () => {
    const stops = caretStops(layoutMath("\\quad", { fontSize: FS }));
    expect(stops.map((s) => s.offset)).toEqual([0, 5]);
    expect(stops[1].x).toBeCloseTo(1 * FS, 3);
  });

  it("a space between glyphs adds no duplicate stops", () => {
    // The space's edges coincide with the neighbouring glyph edges and
    // de-duplicate; a\ b keeps exactly its four glyph-edge stops.
    const stops = caretStops(layoutMath("a\\ b", { fontSize: FS }));
    expect(stops.map((s) => s.offset)).toEqual([0, 1, 3, 4]);
  });

  it("adjacent spaces still give the caret a stop between them", () => {
    // The shared edge de-duplicates into one stop at the joint.
    const stops = caretStops(layoutMath("\\ \\ ", { fontSize: FS }));
    expect(stops.map((s) => s.offset)).toEqual([0, 2, 4]);
  });

  it("a negative kern stays caret-invisible", () => {
    expect(caretStops(layoutMath("\\!", { fontSize: FS }))).toEqual([]);
  });

  it("synthetic padding around \\iff claims no stops of its own", () => {
    // `\iff` expands to space+atom+space, all sharing the command's span; only
    // the glyph's two edges may produce stops.
    const stops = caretStops(layoutMath("\\iff", { fontSize: FS }));
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.offset)).toEqual([0, 4]);
  });

  it("selecting a lone control space highlights its width", () => {
    const layout = layoutMath("\\ ", { fontSize: FS });
    const rects = selectionRects(layout, 0, 2);
    expect(rects).toHaveLength(1);
    expect(rects[0].width).toBeCloseTo(0.3333 * FS, 3);
    expect(rects[0].height).toBeGreaterThan(0);
  });

  it("a tap on a lone control space selects the whole command", () => {
    const layout = layoutMath("\\ ", { fontSize: FS });
    const width = 0.3333 * FS;
    expect(spanAtPoint(layout, width / 2, -1)).toEqual({ start: 0, end: 2 });
  });
});
