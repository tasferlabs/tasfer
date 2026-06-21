/**
 * Editing units adjacent to a caret. A unit is a whole, well-formed piece of the
 * source — a leaf (single char, `\sin`, `\pm`) that deletes outright, or a
 * multi-part construct (`\frac`, scripts, brace groups) the editor selects first.
 * Command names group as one unit, so a unit never chips `\sin` into `\si`/`\s`.
 */
import { describe, expect, it } from "vitest";
import { unitAfter, unitBefore } from "./unit";

/** Convenience: unit on each side as a tuple for terse assertions. */
function back(latex: string, offset: number) {
  const u = unitBefore(latex, offset);
  return u ? [u.start, u.end, u.isConstruct] : null;
}
function fwd(latex: string, offset: number) {
  const u = unitAfter(latex, offset);
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
