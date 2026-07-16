/**
 * The inline-math caret geometry bridge: the source↔pixel mapping MathMark uses
 * to draw the nested tree caret inside a rendered chip and to hit-test clicks
 * back to a source offset. `getInlineMathCaretX` (source offset → x within the
 * chip) and `getInlineMathOffsetAtX` (local x → source offset) must be mutual
 * inverses at the formula's caret stops, and the x must advance left→right
 * across the formula. These run on `@tasfer/tex`'s real data-table layout,
 * so they are deterministic without a canvas.
 */
import {
  getInlineMathCaretRect,
  getInlineMathCaretX,
  getInlineMathDims,
  getInlineMathOffsetAtX,
  getInlineMathOffsetVertical,
  mathCaretOffsets,
  mathSourceAtEdge,
} from "./math";
import { describe, expect, it } from "vitest";

const FS = 16;

describe("inline-math caret bridge", () => {
  it("empty input has no caret geometry", () => {
    expect(getInlineMathCaretX("", FS, 0)).toBe(0);
    expect(getInlineMathOffsetAtX("", FS, 10)).toBe(0);
  });

  it("caret x advances monotonically across the formula", () => {
    const latex = "x^2+y";
    let prev = -Infinity;
    for (let offset = 0; offset <= latex.length; offset++) {
      const x = getInlineMathCaretX(latex, FS, offset);
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
    // Left edge ≈ 0, right edge ≈ the chip's rendered width.
    expect(getInlineMathCaretX(latex, FS, 0)).toBeCloseTo(0, 1);
    const dims = getInlineMathDims(latex, FS)!;
    expect(getInlineMathCaretX(latex, FS, latex.length)).toBeCloseTo(
      dims.width,
      0,
    );
  });

  it("offset-at-x inverts caret-x along the baseline", () => {
    // A flat (baseline-only) formula: every offset is a horizontally-separated
    // caret stop, so the x→offset hit-test inverts caret-x exactly. Stacked
    // constructs (a super/subscript whose stop shares an x with the base at a
    // different height) need the vertical coordinate to disambiguate — that is
    // a later step; here the bridge is exercised on its 1-D contract.
    const latex = "a+b+c";
    for (let offset = 0; offset <= latex.length; offset++) {
      const x = getInlineMathCaretX(latex, FS, offset);
      expect(getInlineMathOffsetAtX(latex, FS, x)).toBe(offset);
    }
  });

  it("a click past the right edge resolves to the last offset", () => {
    const latex = "abc";
    const dims = getInlineMathDims(latex, FS)!;
    expect(getInlineMathOffsetAtX(latex, FS, dims.width + 100)).toBe(
      latex.length,
    );
  });

  it("caret rect hugs its row (a superscript caret is raised off the baseline)", () => {
    const latex = "x^2";
    const base = getInlineMathCaretRect(latex, FS, 0)!; // at 'x' (baseline)
    const sup = getInlineMathCaretRect(latex, FS, 2)!; // at the superscript '2'
    // The whole superscript caret is shifted up (both edges more negative, +y
    // down) — it hugs the script row instead of spanning down to the baseline.
    expect(sup.top).toBeLessThan(base.top);
    expect(sup.bottom).toBeLessThan(base.bottom);
  });

  it("scales with font size (caret x roughly doubles at 2× size)", () => {
    const latex = "a+b";
    const mid = 1; // after 'a'
    const x1 = getInlineMathCaretX(latex, FS, mid);
    const x2 = getInlineMathCaretX(latex, FS * 2, mid);
    expect(x2).toBeCloseTo(x1 * 2, 1);
  });
});

// The edge predicate a host uses to grey out a step-left/right control: it is
// true exactly when there is no further caret stop in that direction.
describe("mathSourceAtEdge", () => {
  it("moves forward through empty matrix cells after a fraction", () => {
    const latex = String.raw`\frac{a}{b}\begin{pmatrix}&{}\\{}&{}\end{pmatrix}`;
    expect(mathCaretOffsets(latex)).toEqual([
      0, 6, 7, 9, 10, 11, 26, 28, 32, 35, 49,
    ]);
  });

  it("reports both edges of a flat formula", () => {
    const latex = "x+y";
    // Left boundary: no stop further left, so left is an edge; right is not.
    expect(mathSourceAtEdge(latex, 0, "left")).toBe(true);
    expect(mathSourceAtEdge(latex, 0, "right")).toBe(false);
    // Right boundary: mirror image.
    expect(mathSourceAtEdge(latex, latex.length, "right")).toBe(true);
    expect(mathSourceAtEdge(latex, latex.length, "left")).toBe(false);
  });

  it("an interior stop is on neither edge", () => {
    const latex = "x+y";
    const interior = mathCaretOffsets(latex).find(
      (o) => o !== 0 && o !== latex.length,
    )!;
    expect(mathSourceAtEdge(latex, interior, "left")).toBe(false);
    expect(mathSourceAtEdge(latex, interior, "right")).toBe(false);
  });

  it("an empty formula is an edge in both directions", () => {
    expect(mathSourceAtEdge("", 0, "left")).toBe(true);
    expect(mathSourceAtEdge("", 0, "right")).toBe(true);
  });

  it("a whole construct is atomic — its far edge is the formula edge", () => {
    // `\frac{a}{b}` stops only at construct boundaries; stepping right from the
    // last stop leaves the formula.
    const latex = "\\frac{a}{b}";
    const stops = mathCaretOffsets(latex);
    expect(mathSourceAtEdge(latex, stops[stops.length - 1], "right")).toBe(
      true,
    );
    expect(mathSourceAtEdge(latex, stops[0], "left")).toBe(true);
  });
});

// Vertical movement over the printed source: the ↑/↓ mapping the caret bridge
// exposes for stacked constructs. Purely layout-driven, so it is pinned on
// LaTeX strings directly.
describe("inline-math vertical nav", () => {
  it("a numerator caret moves down into the denominator", () => {
    const latex = "\\frac{a}{b}";
    // Numerator/denominator slots — NOT indexOf("a"), which would match the
    // 'a' in "\frac".
    const aOffset = latex.indexOf("{a}") + 1; // numerator 'a'
    const bOffset = latex.indexOf("{b}") + 1; // denominator 'b'
    const down = getInlineMathOffsetVertical(latex, FS, aOffset, "down");
    expect(down).not.toBeNull();
    expect(down!).toBeGreaterThanOrEqual(bOffset);

    const up = getInlineMathOffsetVertical(latex, FS, bOffset, "up");
    expect(up).not.toBeNull();
    expect(up!).toBeLessThanOrEqual(aOffset + 1);
  });

  it("a flat formula has no vertical move (caller exits to the line)", () => {
    const latex = "a+b";
    expect(getInlineMathOffsetVertical(latex, FS, 1, "up")).toBeNull();
    expect(getInlineMathOffsetVertical(latex, FS, 1, "down")).toBeNull();
  });

  // An emptied slot (the numerator after deleting its content) stays reachable:
  // the placeholder box carries a caret stop, so ↑ from the denominator lands in
  // the empty numerator and the caret there hugs the numerator row.
  it("the caret can navigate into and sit in an empty numerator slot", () => {
    const latex = "\\frac{}{b}";
    const slotOffset = latex.indexOf("{}") + 1; // between the empty braces
    const bOffset = latex.indexOf("{b}") + 1; // denominator 'b'

    // ↑ from the denominator reaches the empty numerator.
    const up = getInlineMathOffsetVertical(latex, FS, bOffset, "up");
    expect(up).toBe(slotOffset);

    // The empty-slot caret sits on the numerator row — above the denominator's.
    const slot = getInlineMathCaretRect(latex, FS, slotOffset)!;
    const den = getInlineMathCaretRect(latex, FS, bOffset)!;
    expect(slot.top).toBeLessThan(den.top);
  });
});
