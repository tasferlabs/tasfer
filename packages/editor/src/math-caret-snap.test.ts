/**
 * A LaTeX command is one unit for the caret. Its glyphs all carry the whole
 * command's source span, so the legal caret stops fall only at its edges — the
 * caret can never rest at `\in|t`, and so can never be split into `\in` by a
 * delete or `\inxt` by a keystroke. This pins both the stop set
 * (`mathCaretOffsets`) and the horizontal-movement snap (`mathCaretStep`).
 */
import { mathCaretOffsets, mathCaretStep } from "./nodes/math";
import { loadPage } from "./serlization/loadPage";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { describe, expect, it } from "vitest";

describe("mathCaretOffsets — commands are atomic", () => {
  it("a no-arg command stops only at its edges", () => {
    // `\int` is one glyph spanning [0,4): no interior stops at 1/2/3.
    expect(mathCaretOffsets("\\int")).toEqual([0, 4]);
    expect(mathCaretOffsets("\\sum")).toEqual([0, 4]);
  });

  it("a multi-letter operator name stops only at its edges", () => {
    // `\sin` lays out as three glyphs that all carry the span [0,4).
    expect(mathCaretOffsets("\\sin")).toEqual([0, 4]);
  });

  it("a command followed by text keeps the command atomic", () => {
    // `\int x`: `\int` is the control word [0,4), then a space [4,5), then `x`
    // [5,6). The caret stops are at 0 (before `\int`), 4 (right after it), 5
    // (after the space, before `x`) and 6 (after `x`) — never anywhere INSIDE
    // `\int` (offsets 1..3), so the command stays one atomic token you step over.
    const offsets = mathCaretOffsets("\\int x");
    expect(offsets).toEqual([0, 4, 5, 6]);
    for (const insideCommand of [1, 2, 3]) {
      expect(offsets).not.toContain(insideCommand);
    }
  });

  it("a fraction has no stop inside its structural source (braces/keyword)", () => {
    // `\frac{a}{b}`: the only interior stops are around the glyphs `a` and `b`;
    // `\frac`, `{`, `}` carry no caret position.
    const offsets = mathCaretOffsets("\\frac{a}{b}");
    expect(offsets).toContain(0);
    expect(offsets).toContain(11);
    for (const structural of [1, 2, 3, 4, 5, 8]) {
      expect(offsets).not.toContain(structural);
    }
  });

  it("includes the source boundaries even for empty / glyphless input", () => {
    expect(mathCaretOffsets("")).toEqual([0]);
  });
});

describe("mathCaretStep — horizontal movement snaps over a command", () => {
  function mathBlock(latex: string) {
    const block = loadPage(`$$${latex}$$`).blocks[0];
    expect(block.type).toBe("math");
    expect(getVisibleTextFromRuns(block.charRuns)).toBe(latex);
    return block;
  }

  it("steps from the start of `\\int` straight to its end (skips 1/2/3)", () => {
    const block = mathBlock("\\int");
    expect(mathCaretStep(block, 0, "right")).toBe(4);
  });

  it("steps from the end of `\\int` straight to its start", () => {
    const block = mathBlock("\\int");
    expect(mathCaretStep(block, 4, "left")).toBe(0);
  });

  it("never lands inside the command even from an interior index", () => {
    const block = mathBlock("\\int");
    // Defensive: were the caret somehow mid-command, a step still leaves it.
    expect(mathCaretStep(block, 2, "right")).toBe(4);
    expect(mathCaretStep(block, 2, "left")).toBe(0);
  });

  it("returns null in a plain-text block (caller does its ±1 step)", () => {
    const para = loadPage("hello").blocks[0];
    expect(para.type).toBe("paragraph");
    expect(mathCaretStep(para, 2, "right")).toBeNull();
  });
});
