/**
 * The inline-math caret bridge: the screen↔source mapping that lets a caret live
 * *inside* a rendered chip. `getInlineMathCaretX` (source offset → x within the
 * chip) and `getInlineMathOffsetAtX` (local x → source offset) must be mutual
 * inverses at the chip's caret stops, and the x must advance left→right across
 * the formula. These run on `@cypherkit/tex`'s real data-table layout, so they
 * are deterministic without a canvas.
 */
import { getInlineMathSpans } from "../inline-math-spans";
import { loadPage } from "../serlization/loadPage";
import { deleteFromRuns, iterateVisibleChars } from "../sync/char-runs";
import {
  getInlineMathCaretRect,
  getInlineMathCaretX,
  getInlineMathDims,
  getInlineMathOffsetAtX,
  getInlineMathOffsetVertical,
  mathDeleteUnit,
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

// End-to-end of the up/down data path the editor's moveCursorUp/Down rides:
// a real parsed inline-math chip (the chip's visible chars carry the LaTeX) →
// span lookup → vertical offset. Catches off-by-one between block indices and
// LaTeX offsets that a pure-tex test can't.
describe("inline-math vertical nav over a parsed chip", () => {
  it("a numerator caret moves down into the denominator", () => {
    const block = loadPage("$\\frac{a}{b}$").blocks[0];
    const spans = getInlineMathSpans(block);
    expect(spans).toHaveLength(1);
    const { latex } = spans[0];
    expect(latex).toBe("\\frac{a}{b}");

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

  it("a flat chip has no vertical move (caller exits to the line)", () => {
    const block = loadPage("$a+b$").blocks[0];
    const { latex } = getInlineMathSpans(block)[0];
    expect(getInlineMathOffsetVertical(latex, FS, 1, "up")).toBeNull();
    expect(getInlineMathOffsetVertical(latex, FS, 1, "down")).toBeNull();
  });

  // An emptied slot (the numerator after deleting its content) stays reachable:
  // the placeholder box carries a caret stop, so ↑ from the denominator lands in
  // the empty numerator and the caret there hugs the numerator row.
  it("the caret can navigate into and sit in an empty numerator slot", () => {
    const block = loadPage("$\\frac{}{b}$").blocks[0];
    const { latex } = getInlineMathSpans(block)[0];
    expect(latex).toBe("\\frac{}{b}");

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

// Deleting the chip's first/last unit removes just that unit and leaves the rest
// a valid chip — it must NOT nuke the whole span. This pairs with
// `getInlineMathSpans` resolving endpoints tolerantly: dropping the leading char
// tombstones the span's `startCharId`, yet the surviving chars still resolve.
describe("inline-math first/last-unit deletion keeps the rest of the chip", () => {
  it("backspacing the first unit targets only that unit, not the whole chip", () => {
    const block = loadPage("$abc$").blocks[0];
    const span = getInlineMathSpans(block)[0];
    expect(span).toMatchObject({ startIndex: 0, latex: "abc" });

    // Caret just inside the chip, after the first char.
    const del = mathDeleteUnit(block, span.startIndex + 1, "backward");
    expect(del).toEqual({
      from: span.startIndex,
      to: span.startIndex + 1,
      isConstruct: false,
    });
  });

  it("backspacing at the right edge enters the chip and targets its last unit", () => {
    const block = loadPage("$abc$").blocks[0];
    const span = getInlineMathSpans(block)[0];
    expect(span).toMatchObject({ startIndex: 0, endIndex: 3, latex: "abc" });

    // Caret resting just past the chip — Backspace must delete the trailing
    // unit ('c'), not nuke the whole chip.
    const del = mathDeleteUnit(block, span.endIndex, "backward");
    expect(del).toEqual({
      from: span.startIndex + 2,
      to: span.startIndex + 3,
      isConstruct: false,
    });
  });

  it("deleting forward at the left edge enters the chip and targets its first unit", () => {
    const block = loadPage("$abc$").blocks[0];
    const span = getInlineMathSpans(block)[0];

    // Caret resting just before the chip — Delete must remove the leading unit
    // ('a'), not the whole chip.
    const del = mathDeleteUnit(block, span.startIndex, "forward");
    expect(del).toEqual({
      from: span.startIndex,
      to: span.startIndex + 1,
      isConstruct: false,
    });
  });

  it("a span whose leading anchor char is deleted still resolves to the rest", () => {
    const block = loadPage("$abc$").blocks[0];
    const firstId = [...iterateVisibleChars(block.charRuns)][0].id;

    const pruned = {
      ...block,
      charRuns: deleteFromRuns(block.charRuns, [firstId]),
    };
    const spans = getInlineMathSpans(pruned);
    expect(spans).toHaveLength(1);
    // The chip shifts up by the deleted leading char but stays intact as "bc".
    expect(spans[0]).toMatchObject({ startIndex: 0, endIndex: 2, latex: "bc" });
  });

  it("deleting every char in the span drops it entirely", () => {
    const block = loadPage("$ab$").blocks[0];
    const ids = [...iterateVisibleChars(block.charRuns)].map((c) => c.id);
    const pruned = { ...block, charRuns: deleteFromRuns(block.charRuns, ids) };
    expect(getInlineMathSpans(pruned)).toHaveLength(0);
  });
});
