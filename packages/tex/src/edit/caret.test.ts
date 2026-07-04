/**
 * The live-edit caret model: caret stops must land on real source offsets, and
 * hit-test ∘ caret-rect must round-trip (clicking a caret's x returns its
 * offset). This is the invariant that keeps an in-formula caret coherent.
 */
import { describe, expect, it } from "vitest";

import {
  caretRect,
  caretStops,
  hitTest,
  layoutMath,
  selectionRects,
  spanAtPoint,
} from "../index";

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

  it("clicks in the trailing empty space land at the formula's end", () => {
    // A tall construct (the fraction) sits to the LEFT of a short trailing term
    // (`a`). Clicking in the empty space to the right — even at the fraction's
    // numerator/denominator height — must place the caret AFTER `a` (the true
    // rightmost position), not snap back up into the fraction just because the
    // click's `y` happens to fall in the fraction's vertical band.
    const latex = "\\frac{b}{c}+a";
    const layout = layoutMath(latex, { fontSize: 16 });
    const stops = caretStops(layout);
    const farRight = layout.width + 50;
    // Sample the vertical band of every stop, including the fraction's rows.
    for (const s of stops) {
      const y = (s.top + s.bottom) / 2;
      expect(hitTest(layout, farRight, y)).toBe(latex.length);
    }
  });

  it("clicks on a radical sign enter the root, not rest before it", () => {
    // The √ sign is a wide, source-less ornament: its only flanking stops are the
    // construct's leading boundary (x=0, OUTSIDE the root) and the radicand start
    // (far right, under the vinculum). A click anywhere on the sign must enter the
    // root (land at the radicand start), not snap back to the position before it.
    const layout = layoutMath("\\sqrt{x}", { fontSize: 16 });
    const stops = caretStops(layout);
    const radicandStart = stops.find((s) => s.offset === 6)!; // `x`'s left edge
    // Sample across the radical sign's width (from just inside the left edge up to
    // the radicand), at the baseline.
    for (let x = 1; x < radicandStart.x; x += 1) {
      expect(hitTest(layout, x, 0)).toBe(6);
    }
    // Genuinely to the LEFT of the construct still lands before it.
    expect(hitTest(layout, 0, 0)).toBe(0);
    expect(hitTest(layout, -4, 0)).toBe(0);
  });

  it("enters a radical that is preceded by other content", () => {
    // The regression: when the root is NOT the first thing on the line, its left
    // boundary stop lands exactly on the preceding glyph's right edge and is
    // dropped in de-duplication. The merged stop must still carry the construct's
    // extent (`partnerX`) so a click on the √ sign enters the root instead of
    // resting at the position before it (the "outside").
    const latex = "a\\sqrt{x}b";
    const layout = layoutMath(latex, { fontSize: 16 });
    const stops = caretStops(layout);
    const leftEdge = stops.find((s) => s.offset === 1)!; // `a`'s right edge = √'s left edge
    const radicandStart = stops.find((s) => s.offset === 7)!; // `x`'s left edge
    // Sample the √ sign's body, at the baseline and high on the sign — both must
    // enter the radicand, not fall back to the position before the root.
    for (let x = leftEdge.x + 0.5; x < radicandStart.x; x += 1) {
      expect(hitTest(layout, x, 0)).toBe(7);
      expect(hitTest(layout, x, -12)).toBe(7);
    }
    // Still resting beside `a` (before the root) on its own half.
    expect(hitTest(layout, leftEdge.x - 1, 0)).toBe(1);
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

  it("hugs a big operator's glyph, not its trailing italic advance", () => {
    // Selecting a side-scripted integral (`\int_0^1`, whole = its `\int` base)
    // must highlight only the ∫ glyph, not the italic-correction advance that
    // reserves room for the limits — otherwise the green bleeds right into the
    // empty script column. The highlight edge must equal the operator's own
    // trailing caret stop (`x + glyph.width`), the caret that sits just after it.
    const layout = layoutMath("\\int_0^1", { fontSize: 16, displayMode: true });
    const rects = selectionRects(layout, 0, "\\int".length);
    expect(rects.length).toBe(1);
    const opEdge = caretRect(layout, "\\int".length)!.x;
    expect(rects[0].x).toBeCloseTo(0, 5);
    expect(rects[0].x + rects[0].width).toBeCloseTo(opEdge, 5);
    // And it must NOT reach the whole layout width (which includes the limits).
    expect(rects[0].width).toBeLessThan(layout.width);
  });

  it("highlights a limit operator's base (\\sum) instead of nothing", () => {
    // A display limit operator builds its base glyph in `stackLimits`; that glyph
    // must carry the operator's source span, or selecting `\sum` yields an empty
    // highlight and an un-landable caret. Selecting the `\sum` base must produce
    // one rect covering the ∑ glyph.
    const layout = layoutMath("\\sum_{i}^{n}", {
      fontSize: 16,
      displayMode: true,
    });
    const rects = selectionRects(layout, 0, "\\sum".length);
    expect(rects.length).toBe(1);
    expect(rects[0].width).toBeGreaterThan(0);
    // The caret can land just after the operator too (a stop exists at its end).
    const stops = caretStops(layout).map((s) => s.offset);
    expect(stops).toContain("\\sum".length);
  });

  it("hugs a selected operator's edges with the `edge` hint", () => {
    // Selecting a `+`/`=` (its edges share a source offset with the med/thick
    // space around it and any neighbouring construct's boundary): a selection
    // ENDPOINT must sit at the operator's own edge — where the highlight is — not
    // drift out across that space. `edge:"start"` hugs right, `edge:"end"` hugs
    // left, so the pair matches the selection rect exactly.
    for (const latex of ["a+b", "a=\\frac{b}{c}"]) {
      const layout = layoutMath(latex, { fontSize: 22, displayMode: true });
      const green = selectionRects(layout, 1, 2)[0];
      const start = caretRect(layout, 1, "start")!;
      const end = caretRect(layout, 2, "end")!;
      expect(start.x).toBeCloseTo(green.x, 5);
      expect(end.x).toBeCloseTo(green.x + green.width, 5);
      // Without the hint the endpoints drift off the highlight (the bug).
      expect(caretRect(layout, 1)!.x).toBeLessThan(green.x);
    }
  });

  it("selects a small operator by point, even between constructs", () => {
    // The offset path (`unitAt`) can't select an operator wedged between two
    // constructs — it maps a tap to a shared boundary and prefers the neighbour.
    // `spanAtPoint` works from the tap point, so tapping the operator's own box
    // selects it. Sample the operator's centre column.
    const cases: Array<[string, string, number]> = [
      ["x^2+y^2", "+", 3], // '+' source offset [3,4)
      ["\\frac{a}{b}-c", "-", 11], // '-' offset [11,12)
      ["a=b", "=", 1], // '=' offset [1,2)
    ];
    for (const [latex, op, opStart] of cases) {
      const layout = layoutMath(latex, { fontSize: 22, displayMode: true });
      // Centre x of the operator's glyph box (from its selection rect).
      const rect = selectionRects(layout, opStart, opStart + 1)[0];
      const cx = rect.x + rect.width / 2;
      const span = spanAtPoint(layout, cx, 0, { minTargetSize: 24 });
      expect(span).not.toBeNull();
      expect(latex.slice(span!.start, span!.end)).toBe(op);
    }
  });

  it("selects the whole construct a tapped glyph lives in", () => {
    // Tapping a fraction's numerator selects the `\frac`; a nested script selects
    // the inner `x^{2}` (nearest enclosing construct), matching the offset path.
    const frac = layoutMath("\\frac{a}{b}", {
      fontSize: 22,
      displayMode: true,
    });
    const num = selectionRects(frac, 6, 7)[0]; // the `a`
    const whole = spanAtPoint(
      frac,
      num.x + num.width / 2,
      num.y + num.height / 2,
      {
        minTargetSize: 24,
      },
    );
    expect(whole).toEqual({ start: 0, end: "\\frac{a}{b}".length });

    const nested = layoutMath("\\frac{x^2}{d}", {
      fontSize: 22,
      displayMode: true,
    });
    const x = selectionRects(nested, 6, 7)[0]; // the `x` inside x^2
    const inner = spanAtPoint(nested, x.x + x.width / 2, x.y + x.height / 2, {
      minTargetSize: 24,
    });
    expect(nested.box).toBeDefined();
    expect("\\frac{x^2}{d}".slice(inner!.start, inner!.end)).toBe("x^2");
  });
});
