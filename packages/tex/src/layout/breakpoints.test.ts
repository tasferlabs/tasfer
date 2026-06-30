/**
 * Top-level line-break offsets — where an inline formula may wrap across lines.
 * Breaks sit before binary operators and relations (never before the first atom,
 * never inside a construct), and each split piece must re-parse cleanly.
 */
import { describe, expect, it } from "vitest";

import { breakpoints, layoutMath } from "../index";

describe("breakpoints", () => {
  it("breaks before each binary operator and relation", () => {
    // "a + b = c": '+' at index 2, '=' at index 6.
    const bp = breakpoints("a + b = c");
    expect(bp).toEqual([2, 6]);
  });

  it("never breaks before a leading operator", () => {
    // A leading '+' has nothing before it, so it is not a break.
    expect(breakpoints("+ a + b")).toEqual([4]);
  });

  it("has no break inside a single construct", () => {
    expect(breakpoints("\\frac{a+b}{c+d}")).toEqual([]);
    expect(breakpoints("\\sqrt{x+y+z}")).toEqual([]);
  });

  it("returns empty for an atom with no top-level operator", () => {
    expect(breakpoints("xyz")).toEqual([]);
    expect(breakpoints("")).toEqual([]);
  });

  it("splitting at a breakpoint yields re-parseable pieces", () => {
    const latex = "a + b + c = d";
    const bp = breakpoints(latex);
    const cuts = [0, ...bp, latex.length];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const piece = latex.slice(cuts[i], cuts[i + 1]);
      // Every piece lays out without throwing and has positive width.
      expect(layoutMath(piece).width).toBeGreaterThan(0);
    }
  });
});
