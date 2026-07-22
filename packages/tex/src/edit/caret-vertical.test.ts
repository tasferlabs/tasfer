/**
 * Vertical caret navigation inside a formula. `caretVertical` is pure geometry
 * over the laid-out box tree, but the contract it must honor is *structural*:
 * up/down moves between the stacked slots of the enclosing construct (a
 * fraction's halves, a base and its script) — never to a baseline neighbor that
 * merely happens to be geometrically nearby. These cases pin that behavior.
 */
import { describe, expect, it } from "vitest";

import { caretRect, caretVertical } from "./caret";
import { layoutMath } from "../index";

const FS = 16;

/** caretVertical at the x of the current offset (the natural column to keep). */
function move(latex: string, offset: number, dir: "up" | "down"): number | null {
  const layout = layoutMath(latex, { fontSize: FS });
  const x = caretRect(layout, offset)?.x ?? 0;
  return caretVertical(layout, offset, dir, x);
}

describe("caretVertical — structural up/down", () => {
  it("fraction: numerator ↔ denominator", () => {
    // \frac{a}{b} → 'a' at source index 6, 'b' at 9.
    const f = "\\frac{a}{b}";
    expect(move(f, 6, "down")).toBeGreaterThanOrEqual(9); // into denominator
    expect(move(f, 9, "up")).toBeLessThanOrEqual(7); // back into numerator
  });

  it("fraction: no stop beyond the outer slot", () => {
    const f = "\\frac{a}{b}";
    expect(move(f, 6, "up")).toBeNull(); // nothing above the numerator
    expect(move(f, 9, "down")).toBeNull(); // nothing below the denominator
  });

  it("superscript: base ↔ script", () => {
    // x^2 → 'x' at 0, '2' at 2.
    const s = "x^2";
    const up = move(s, 1, "up");
    expect(up).not.toBeNull();
    expect(up!).toBeGreaterThanOrEqual(2); // up from base reaches the script
    expect(move(s, 2, "down")).toBeLessThanOrEqual(1); // down from script → base
  });

  it("down from a numerator reaches the denominator, NOT a baseline sibling", () => {
    // a+\frac{b}{c}+d → 'b' (numerator) at 8, 'c' (denominator) at 11.
    // The baseline atoms a/+/+/d (offsets 0,1,13,14) are geometrically closer
    // in y but off to the side — they must lose to the directly-below 'c'.
    const f = "a+\\frac{b}{c}+d";
    const down = move(f, 8, "down");
    expect(down).not.toBeNull();
    expect(down!).toBeGreaterThanOrEqual(11);
    expect(down!).toBeLessThanOrEqual(12);
  });

  it("matrix: a row down stays in the same column", () => {
    // \begin{matrix}a&b\\c&d\end{matrix}: a above c, b above d.
    const m = "\\begin{matrix}a&b\\\\c&d\\end{matrix}";
    const layout = layoutMath(m, { fontSize: FS, displayMode: true });
    const aOffset = m.indexOf("a");
    const cOffset = m.indexOf("c");
    const ax = caretRect(layout, aOffset)?.x ?? 0;
    const down = caretVertical(layout, aOffset, "down", ax);
    expect(down).not.toBeNull();
    // Lands on 'c' (same column), not 'd'.
    expect(down!).toBeGreaterThanOrEqual(cOffset);
    expect(down!).toBeLessThanOrEqual(cOffset + 1);
  });

  it("flat formula has no vertical stops", () => {
    expect(move("a+b+c", 2, "up")).toBeNull();
    expect(move("a+b+c", 2, "down")).toBeNull();
  });

  it("super/subscript: ↓ from the sup jumps to the sub, over the base", () => {
    // x^2_3 → sup '2' at offset 2, sub '3' at offset 4, base 'x' between them on
    // the baseline. Pure geometry would step ↓ onto the base (same column, nearer
    // row); the structural link must reach the subscript instead.
    const f = "x^2_3";
    expect(move(f, 2, "down")).toBe(4); // sup → sub
    expect(move(f, 4, "up")).toBe(2); // sub → sup
  });

  it("super/subscript written sub-first behaves identically", () => {
    // x_3^2 → sub '3' at offset 2, sup '2' at offset 4.
    const f = "x_3^2";
    expect(move(f, 4, "down")).toBe(2); // sup → sub
    expect(move(f, 2, "up")).toBe(4); // sub → sup
  });

  it("multi-term scripts keep the column, ambiguity takes the first term", () => {
    // a^{bc}_{de}: sup 'b','c' at 3,4; sub 'd','e' at 8,9.
    const f = "a^{bc}_{de}";
    expect(move(f, 3, "down")).toBe(8); // 'b' (1st of sup) → 'd' (1st of sub)
    expect(move(f, 4, "down")).toBe(9); // 'c' (2nd of sup) → 'e' (2nd of sub)
    expect(move(f, 8, "up")).toBe(3); // and back
    expect(move(f, 9, "up")).toBe(4);
  });

  it("a sole superscript still falls back to the base (no sub to pair with)", () => {
    // x^2 — ↓ from the script has no sibling subscript, so it lands on the base.
    expect(move("x^2", 2, "down")).toBeLessThanOrEqual(1);
  });

  it("big-operator limits: ↑/↓ pair the upper and lower limit", () => {
    // \sum_a^b in display mode stacks 'a' below and 'b' above the operator.
    const f = "\\sum_a^b";
    const aOff = f.indexOf("a");
    const bOff = f.indexOf("b");
    const layout = layoutMath(f, { fontSize: FS, displayMode: true });
    const aX = caretRect(layout, aOff)?.x ?? 0;
    const bX = caretRect(layout, bOff)?.x ?? 0;
    expect(caretVertical(layout, bOff, "down", bX)).toBe(aOff); // upper → lower
    expect(caretVertical(layout, aOff, "up", aX)).toBe(bOff); // lower → upper
  });
});
