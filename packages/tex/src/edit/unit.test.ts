/**
 * Editing units adjacent to a caret. A unit is a whole, well-formed piece of the
 * source — a leaf (single char, `\sin`, `\pm`) that deletes outright, or a
 * multi-part construct (`\frac`, scripts, brace groups) the editor selects first.
 * Command names group as one unit, so a unit never chips `\sin` into `\si`/`\s`.
 */
import { describe, expect, it } from "vitest";
import { isInsideConstruct, unitAfter, unitAt, unitBefore } from "./unit";

/** Convenience: unit on each side as a tuple for terse assertions. */
function back(latex: string, offset: number) {
  const u = unitBefore(latex, offset);
  return u ? [u.start, u.end, u.isConstruct] : null;
}
function fwd(latex: string, offset: number) {
  const u = unitAfter(latex, offset);
  return u ? [u.start, u.end, u.isConstruct] : null;
}
/** The double-click selection unit at `offset`, as the same terse tuple. */
function at(latex: string, offset: number) {
  const u = unitAt(latex, offset);
  return u ? [u.start, u.end, u.isConstruct] : null;
}

describe("unitBefore — plain leaves (deleted outright)", () => {
  it("a single character is one leaf", () => {
    expect(back("x+2", 3)).toEqual([2, 3, false]);
    expect(back("x+2", 2)).toEqual([1, 2, false]);
  });

  it("a command name (\\sin) is one leaf", () => {
    // "\sin x", caret right after \sin
    expect(back("\\sin x", 4)).toEqual([0, 4, false]);
  });

  it("a mid-string symbol command (\\pm) groups as one leaf", () => {
    // "a\pm b", caret right after \pm → the whole command, back to offset 1.
    expect(back("a\\pm b", 4)).toEqual([1, 4, false]);
  });

  it("returns null at the very start (backward) / end (forward)", () => {
    expect(back("x+2", 0)).toBeNull();
    expect(back("\\sin", 0)).toBeNull();
    expect(fwd("x+2", 3)).toBeNull();
  });
});

describe("unitBefore — constructs (selected first)", () => {
  it("the whole fraction when the caret is just after it", () => {
    expect(back("\\frac{a}{b}", 11)).toEqual([0, 11, true]);
  });

  it("the whole fraction from the start of the numerator", () => {
    // "\frac{a}{b}", caret before `a` (offset 6) — nothing to delete in the
    // numerator, so escalate to the whole construct.
    expect(back("\\frac{a}{b}", 6)).toEqual([0, 11, true]);
  });

  it("the whole fraction from the start of the denominator", () => {
    // caret before `b` (offset 9)
    expect(back("\\frac{a}{b}", 9)).toEqual([0, 11, true]);
  });

  it("a character inside the numerator stays at the current level", () => {
    // caret after `a` (offset 7)
    expect(back("\\frac{a}{b}", 7)).toEqual([6, 7, false]);
  });

  it("the whole square root after it", () => {
    expect(back("\\sqrt{x}", 8)).toEqual([0, 8, true]);
  });

  it("a character inside the root body", () => {
    // caret after `x` (offset 7)
    expect(back("\\sqrt{x}", 7)).toEqual([6, 7, false]);
  });

  it("the whole supsub — base and scripts together — when the caret is after it", () => {
    // "x^{2}", caret after the script — the base and its script are one unit, so
    // the whole `x^{2}` (offsets 0..5) is selected, not just the `^{2}`.
    expect(back("x^{2}", 5)).toEqual([0, 5, true]);
  });

  it("both scripts and the base together for a sub+sup", () => {
    // "x^{2}_{3}", caret after the whole thing — base + sup + sub as one unit.
    const latex = "x^{2}_{3}";
    expect(back(latex, latex.length)).toEqual([0, latex.length, true]);
  });

  it("a character inside a script body", () => {
    // "x^{2}", caret after `2` (offset 4)
    expect(back("x^{2}", 4)).toEqual([3, 4, false]);
  });

  it("a brace group as a unit", () => {
    expect(back("{ab}", 4)).toEqual([0, 4, true]);
  });

  it("the brace group from its content start", () => {
    // "{ab}", caret before `a` (offset 1)
    expect(back("{ab}", 1)).toEqual([0, 4, true]);
  });

  it("a character within a brace group at the current level", () => {
    // "{ab}", caret after `a` (offset 2)
    expect(back("{ab}", 2)).toEqual([1, 2, false]);
  });
});

describe("unitBefore — empty slots escalate to the construct", () => {
  it("the whole fraction when the caret sits in an empty numerator", () => {
    // "\frac{}{b}" — caret inside the empty numerator braces (offset 6). The
    // slot has no node to delete, so the unit is the whole fraction (regression:
    // this used to crash reading `group[0].span` on the empty slot).
    expect(back("\\frac{}{b}", 6)).toEqual([0, 10, true]);
  });

  it("the whole fraction when the caret sits in an empty denominator", () => {
    // "\frac{a}{}" — caret inside the empty denominator braces (offset 9).
    expect(back("\\frac{a}{}", 9)).toEqual([0, 10, true]);
  });

  it("the whole fraction when both slots are empty", () => {
    // "\frac{}{}" — caret in the empty numerator (offset 6).
    expect(back("\\frac{}{}", 6)).toEqual([0, 9, true]);
  });

  it("the whole root when the caret sits in an empty body, forward too", () => {
    // "\sqrt{}" — caret inside the empty radicand (offset 6).
    expect(back("\\sqrt{}", 6)).toEqual([0, 7, true]);
    expect(fwd("\\sqrt{}", 6)).toEqual([0, 7, true]);
  });
});

describe("unitAfter — forward direction", () => {
  it("the character to the right", () => {
    expect(fwd("x+2", 0)).toEqual([0, 1, false]);
  });

  it("a command name to the right is one leaf", () => {
    expect(fwd("\\sin x", 0)).toEqual([0, 4, false]);
  });

  it("a fraction sitting to the right", () => {
    // "\frac{a}{b}+1", caret at 0, the frac starts here
    expect(fwd("\\frac{a}{b}+1", 0)).toEqual([0, 11, true]);
  });

  it("a character inside the numerator going forward", () => {
    // caret before `a` (offset 6)
    expect(fwd("\\frac{a}{b}", 6)).toEqual([6, 7, false]);
  });
});

describe("unknown commands delete per-character (not as one atomic token)", () => {
  it("backspace removes the last char of an in-progress command", () => {
    // "\al" is unrecognized (mid-typing "\alpha") — it isn't a construct yet, so
    // each Backspace peels one char rather than nuking the whole run.
    expect(back("\\al", 3)).toEqual([2, 3, false]);
    expect(back("\\al", 2)).toEqual([1, 2, false]);
    expect(back("\\al", 1)).toEqual([0, 1, false]);
    expect(back("\\al", 0)).toBeNull();
  });

  it("forward-delete removes the first char of an in-progress command", () => {
    expect(fwd("\\al", 0)).toEqual([0, 1, false]);
    expect(fwd("\\al", 2)).toEqual([2, 3, false]);
  });

  it("a recognized command stays one atomic leaf", () => {
    // Contrast: \sin is known, so it is NOT chipped char by char.
    expect(back("\\sin", 4)).toEqual([0, 4, false]);
  });

  it("an unknown command nested in a fraction numerator chips per-char", () => {
    // "\frac{\al}{b}", caret just after the `l` inside the numerator.
    const latex = "\\frac{\\al}{b}";
    const afterAl = latex.indexOf("\\al") + 3;
    expect(back(latex, afterAl)).toEqual([afterAl - 1, afterAl, false]);
  });
});

describe("unitBefore — nested constructs stay at their level", () => {
  it("an inner construct living inside a fraction numerator", () => {
    // "\frac{\sqrt{x}}{b}", caret just after the inner \sqrt{x}
    const latex = "\\frac{\\sqrt{x}}{b}";
    const afterSqrt = latex.indexOf("}}") + 1; // index of the first of the two closing braces
    expect(back(latex, afterSqrt)).toEqual([6, afterSqrt, true]);
  });
});

describe("unitAt — double-click selects the construct under the pointer, whole", () => {
  it("a fraction from any glyph of its numerator", () => {
    // Single-char numerator, caret after `a`.
    expect(at("\\frac{a}{b}", 7)).toEqual([0, 11, true]);
    // Multi-char numerator, caret BETWEEN the two glyphs — escalates to the whole
    // `\frac` rather than chipping a single source char (the bug this fixes; the
    // delete-side `unitBefore` deliberately stays on the lone `a` here).
    expect(at("\\frac{ab}{c}", 7)).toEqual([0, 12, true]);
    expect(back("\\frac{ab}{c}", 7)).toEqual([6, 7, false]);
  });

  it("a fraction from any glyph of its denominator", () => {
    expect(at("\\frac{a}{b}", 9)).toEqual([0, 11, true]);
    expect(at("\\frac{a}{bc}", 10)).toEqual([0, 12, true]);
  });

  it("the INNERMOST construct when constructs nest", () => {
    // "\frac{x^2}{d}" — clicking the script base selects the whole `x^2`, the
    // innermost construct, not the enclosing fraction.
    const latex = "\\frac{x^2}{d}";
    const afterX = latex.indexOf("x") + 1;
    expect(at(latex, afterX)).toEqual([6, 9, true]);
  });

  it("a square root from a glyph of its body", () => {
    expect(at("\\sqrt{xy}", 7)).toEqual([0, 9, true]);
  });

  it("a lone top-level token selects itself, not its neighbours", () => {
    // A recognized command is its own token…
    expect(at("\\alpha+1", 0)).toEqual([0, 6, false]);
    // …and a bare character stays a single leaf (never widening to `ab`).
    expect(at("ab", 0)).toEqual([0, 1, false]);
  });

  it("prefers the construct over a neighbouring operator at a shared boundary", () => {
    // "\frac{a}{b}+1" — the caret offset at the fraction's right edge is also the
    // `+`'s left edge; the double-click grabs the fraction, not the operator.
    expect(at("\\frac{a}{b}+1", 11)).toEqual([0, 11, true]);
  });

  it("returns null for an empty formula", () => {
    expect(at("", 0)).toBeNull();
  });
});

describe("isInsideConstruct — top-level vs. construct interior", () => {
  it("top-level positions between sibling tokens are not inside a construct", () => {
    // "a b" — the space between two atoms is a clean top-level break point.
    expect(isInsideConstruct("a b", 1)).toBe(false);
    expect(isInsideConstruct("a b", 2)).toBe(false);
    // "x+y" — every interior offset is between top-level siblings.
    expect(isInsideConstruct("x+y", 1)).toBe(false);
    expect(isInsideConstruct("x+y", 2)).toBe(false);
  });

  it("a space inside a fraction slot is inside the construct", () => {
    // "\frac{a b}{c}" — the space sits in the numerator, both of its edges.
    const sp = "\\frac{a b}{c}".indexOf(" ");
    expect(isInsideConstruct("\\frac{a b}{c}", sp)).toBe(true);
    expect(isInsideConstruct("\\frac{a b}{c}", sp + 1)).toBe(true);
  });

  it("positions inside a script are inside the construct", () => {
    // "x^{a b}" — the space in the superscript group.
    const sp = "x^{a b}".indexOf(" ");
    expect(isInsideConstruct("x^{a b}", sp)).toBe(true);
  });

  it("the source boundaries are never inside a construct", () => {
    expect(isInsideConstruct("\\frac{a}{b}", 0)).toBe(false);
    expect(isInsideConstruct("\\frac{a}{b}", "\\frac{a}{b}".length)).toBe(false);
    expect(isInsideConstruct("", 0)).toBe(false);
  });
});
