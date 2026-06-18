/**
 * Vertical caret navigation *inside a block (display) equation*. A `$$…$$` math
 * block is textual — its char-run text IS the LaTeX, so the block text index is
 * the LaTeX offset — but unlike a paragraph its rows are stacked construct slots
 * (a fraction's halves, a super/subscript), not wrapped text lines. ArrowUp /
 * ArrowDown must therefore descend through those slots before exiting the block,
 * exactly as the inline-math chips already do. These drive the real
 * `moveCursorUp`/`moveCursorDown` over a fabricated state (no canvas mount).
 */
import { moveCursorDown, moveCursorUp } from "./selection";
import { loadPage } from "./serlization/loadPage";
import type { CursorState, EditorState } from "./state-types";
import { createInitialState } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { describe, expect, it } from "vitest";

function mathState(latex: string): EditorState {
  const page = loadPage(`$$${latex}$$`);
  expect(page.blocks[0].type).toBe("math");
  expect(getVisibleTextFromRuns(page.blocks[0].charRuns)).toBe(latex);
  return createInitialState(page);
}

function at(s: EditorState, textIndex: number): EditorState {
  const cursor: CursorState = {
    position: { blockIndex: 0, textIndex },
    lastUpdate: 0,
  };
  return { ...s, document: { ...s.document, cursor } };
}

function caret(s: EditorState): number | undefined {
  return s.document.cursor?.position.textIndex;
}

describe("block math — vertical caret navigation", () => {
  it("moves from the numerator down into the denominator and back", () => {
    const f = "\\frac{a}{b}";
    const aOff = f.indexOf("{a}") + 1; // numerator 'a'
    const bOff = f.indexOf("{b}") + 1; // denominator 'b'
    const s = mathState(f);

    const down = moveCursorDown(at(s, aOff));
    expect(down.document.cursor?.position.blockIndex).toBe(0);
    expect(caret(down)).toBeGreaterThanOrEqual(bOff);

    const up = moveCursorUp(at(s, bOff));
    expect(up.document.cursor?.position.blockIndex).toBe(0);
    expect(caret(up)).toBeLessThanOrEqual(aOff + 1);
  });

  it("moves from a superscript down into the subscript (over the base)", () => {
    // x^2_3 → sup '2' at offset 2, sub '3' at offset 4.
    const s = mathState("x^2_3");
    expect(caret(moveCursorDown(at(s, 2)))).toBe(4); // sup → sub
    expect(caret(moveCursorUp(at(s, 4)))).toBe(2); // sub → sup
  });

  it("exits the block (changes block) when there is no row beyond the edge slot", () => {
    // A trailing paragraph gives ArrowDown somewhere to land.
    const page = loadPage("$$\\frac{a}{b}$$\n\ntail");
    const s = createInitialState(page);
    const bOff = "\\frac{a}{b}".indexOf("{b}") + 1;

    // ↓ from the denominator (bottom slot) leaves the math block.
    const down = moveCursorDown(at(s, bOff));
    expect(down.document.cursor?.position.blockIndex).not.toBe(0);

    // ↑ from the numerator (top slot) leaves upward — already the first block,
    // so it clamps to the block start rather than descending a slot.
    const aOff = "\\frac{a}{b}".indexOf("{a}") + 1;
    const up = moveCursorUp(at(s, aOff));
    expect(caret(up)).toBeLessThanOrEqual(aOff);
  });
});
