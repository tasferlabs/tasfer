/**
 * Editing units adjacent to a caret. A unit is a whole, well-formed piece of the
 * source — a leaf (single char, `\sin`, `\pm`) that deletes outright, or a
 * multi-part construct (`\frac`, scripts, brace groups) the editor selects first.
 * Command names group as one unit, so a unit never chips `\sin` into `\si`/`\s`.
 */
import { describe, expect, it } from "vitest";
import {
  isInsideConstruct,
  resolveSelectionRange,
  scriptAttachOffset,
  unitAfter,
  unitAt,
  unitBefore,
} from "./unit";

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

describe("unitBefore/After — an empty script slot peels off alone", () => {
  // A caret inside an EMPTY `_{}`/`^{}` slot deletes just that script (operator
  // and braces), keeping the base — so a limit is optional: add `_`, back out to
  // a bare operator. Contrast the fraction cases above, where an empty slot
  // escalates to the whole construct.
  it("removes an empty subscript, leaving the base and the other script", () => {
    // "\int_{}^{}" — caret in the empty sub (offset 6) peels `_{}` (offsets 4..7)
    // → "\int^{}"; caret in the empty sup (offset 9) peels `^{}` (7..10).
    expect(back("\\int_{}^{}", 6)).toEqual([4, 7, false]);
    expect(fwd("\\int_{}^{}", 6)).toEqual([4, 7, false]);
    expect(back("\\int_{}^{}", 9)).toEqual([7, 10, false]);
    expect(fwd("\\int_{}^{}", 9)).toEqual([7, 10, false]);
  });

  it("peels the sole empty script back to a bare operator", () => {
    // "\int_{}" and "\int^{}" — the empty script (offsets 4..7) is all that is
    // deleted, leaving "\int".
    expect(back("\\int_{}", 6)).toEqual([4, 7, false]);
    expect(fwd("\\int_{}", 6)).toEqual([4, 7, false]);
    expect(back("\\int^{}", 6)).toEqual([4, 7, false]);
    // "x^{}" → back to a bare "x".
    expect(back("x^{}", 3)).toEqual([1, 4, false]);
    expect(fwd("x^{}", 3)).toEqual([1, 4, false]);
  });

  it("peels only the EMPTY script when the sibling script is filled", () => {
    // "\int_{a}^{}" — caret in the empty sup (offset 10) peels `^{}` (8..11),
    // leaving "\int_{a}". A caret inside the FILLED sub is untouched: its glyph
    // deletes at its own level, and the construct still escalates from its edge.
    expect(back("\\int_{a}^{}", 10)).toEqual([8, 11, false]);
    expect(fwd("\\int_{a}^{}", 10)).toEqual([8, 11, false]);
    expect(back("\\int_{a}^{}", 7)).toEqual([6, 7, false]); // the `a` glyph
    expect(back("\\int_{a}^{}", 6)).toEqual([0, 11, true]); // edge → whole construct
  });

  it("a filled script still selects the whole construct (unchanged)", () => {
    // "x^{2}" — nothing empty, so the base+script unit is preserved.
    expect(back("x^{2}", 5)).toEqual([0, 5, true]);
    expect(back("x^{2}", 4)).toEqual([3, 4, false]);
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

describe("resolveSelectionRange — level-aware range snapping", () => {
  // `→` reads "from anchor to focus": travel direction is anchor→focus, so the
  // focus edge is "end" when focus > anchor, "start" otherwise.
  const range = (latex: string, anchor: number, focus: number) => {
    const edge = focus >= anchor ? "end" : "start";
    const r = resolveSelectionRange(latex, anchor, focus, edge);
    return [r.anchor, r.focus];
  };

  it("at the top level a fraction is one atomic unit", () => {
    // "a\frac{b}{c}d": fraction spans [1, 12). Selecting from before it (offset 1)
    // rightward into the numerator takes the whole `\frac`.
    const latex = "a\\frac{b}{c}d";
    expect(range(latex, 1, 8)).toEqual([1, 12]); // into the numerator → whole frac
  });

  it("stays WITHIN a slot when both endpoints share it (level-aware)", () => {
    // "\frac{ab}{c}": both endpoints in the numerator [6, 8) — select just `a`,
    // the numerator is NOT collapsed to the whole fraction.
    expect(range("\\frac{ab}{c}", 6, 7)).toEqual([6, 7]);
    expect(range("\\frac{ab}{c}", 7, 8)).toEqual([7, 8]);
  });

  it("escalates to the fraction when endpoints straddle its two slots", () => {
    // Numerator → denominator: the shared level is the top level, so the whole
    // `\frac{a}{b}` (│[0,11)) is taken.
    expect(range("\\frac{a}{b}", 6, 9)).toEqual([0, 11]);
  });

  it("selects within the INNER fraction of a nested one", () => {
    // "\frac{\frac{a}{b}}{c}": inner frac is [6, 17). Numerator `a` at 12,
    // denominator `b` at 15 — both inside the outer numerator, so straddling the
    // inner slots escalates only to the INNER fraction, not the outer one.
    const latex = "\\frac{\\frac{a}{b}}{c}";
    expect(range(latex, 12, 15)).toEqual([6, 17]);
  });

  it("direction of travel decides include vs exclude (select less)", () => {
    // "a\frac{b}{c}d": whole fraction selected as [1, 12). Moving the focus LEFT
    // back into it (focus 8 < prev, edge "start") drops it to the near edge.
    const latex = "a\\frac{b}{c}d";
    // grow right: anchor 1, focus into numerator → include whole frac
    expect(resolveSelectionRange(latex, 1, 8, "end")).toEqual({
      anchor: 1,
      focus: 12,
    });
    // shrink: focus travelling left into the frac → exclude (near edge)
    expect(resolveSelectionRange(latex, 1, 8, "start")).toEqual({
      anchor: 1,
      focus: 1,
    });
  });

  it("leaves a top-level range between siblings untouched", () => {
    // "\frac{a}{b}+1": selecting the trailing `+1` never touches the fraction.
    expect(range("\\frac{a}{b}+1", 11, 13)).toEqual([11, 13]);
  });

  it("passes a collapsed range through", () => {
    expect(resolveSelectionRange("\\frac{a}{b}", 6, 6, "end")).toEqual({
      anchor: 6,
      focus: 6,
    });
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
    expect(isInsideConstruct("\\frac{a}{b}", "\\frac{a}{b}".length)).toBe(
      false,
    );
    expect(isInsideConstruct("", 0)).toBe(false);
  });
});

describe("scriptAttachOffset — scripts attach to the whole accented construct", () => {
  it("the end of a non-stretchy accent's base hops past the construct", () => {
    // "\dot{x|}" — a `^` typed here means \dot{x}^{…}, not \dot{x^{…}}.
    expect(scriptAttachOffset("\\dot{x}", 6, "^")).toBe(7);
    expect(scriptAttachOffset("\\vec{v}", 6, "^")).toBe(7);
    // A multi-token base still hops from its end.
    expect(scriptAttachOffset("\\vec{AB}", 7, "^")).toBe(8);
  });

  it("hops even when the accent sits inside another construct's slot", () => {
    // "x^{\dot{a|}}" — the hop lands inside the superscript group, after \dot{a}.
    expect(scriptAttachOffset("x^{\\dot{a}}", 9, "^")).toBe(10);
  });

  it("nested accents escalate to after the outermost construct", () => {
    // "\hat{\dot{x|}}" — the whole \hat{\dot{x}} is one accented construct.
    expect(scriptAttachOffset("\\hat{\\dot{x}}", 11, "^")).toBe(13);
  });

  it("does not hop from the middle of the base or an empty base", () => {
    // "\dot{x|y}" — the script belongs to `x`, inside the base.
    expect(scriptAttachOffset("\\dot{xy}", 6, "^")).toBeNull();
    // "\dot{|}" — nothing accented yet; keep the default behavior.
    expect(scriptAttachOffset("\\dot{}", 5, "^")).toBeNull();
  });

  it("never hops out of a stretchy accent (it spans arbitrary content)", () => {
    const latex = "\\widehat{ab}";
    expect(scriptAttachOffset(latex, latex.length - 1, "^")).toBeNull();
  });

  it("ignores an unbraced base and a fraction slot", () => {
    // "\dot x|" — the caret is already past the construct; nothing to hop.
    expect(scriptAttachOffset("\\dot x", 6, "^")).toBeNull();
    // "\frac{a|}{b}" — a fraction slot is not a redirecting construct.
    expect(scriptAttachOffset("\\frac{a}{b}", 7, "^")).toBeNull();
  });
});

describe("scriptAttachOffset — the matching script attaches to the same base", () => {
  it("a `^` at the end of a subscript hops past the whole supsub", () => {
    // "x_{n|}" + `^` must mean x_{n}^{…} (both scripts, one base), never
    // x_{n^{…}} (a superscript nested in the subscript's content).
    expect(scriptAttachOffset("x_{n}", 4, "^")).toBe(5);
    // "x^{2|}" + `_` is the mirror case → x^{2}_{…}.
    expect(scriptAttachOffset("x^{2}", 4, "_")).toBe(5);
    // A multi-token slot still hops from its end.
    expect(scriptAttachOffset("x_{ab}", 5, "^")).toBe(6);
  });

  it("hops when the scripted base is itself a construct", () => {
    // "\frac{a}{b}_{n|}" + `^` → \frac{a}{b}_{n}^{…}.
    const latex = "\\frac{a}{b}_{n}";
    expect(scriptAttachOffset(latex, latex.length - 1, "^")).toBe(latex.length);
  });

  it("does NOT hop when the matching script already exists", () => {
    // "x_{n|}^{2}" + `^` can't add a second superscript, so it stays put
    // (nesting into `n`); the parser would drop a duplicate `^{}` anyway.
    expect(scriptAttachOffset("x_{n}^{2}", 4, "^")).toBeNull();
    // Typing the SAME script the caret sits in never escalates either.
    expect(scriptAttachOffset("x^{2}", 4, "^")).toBeNull();
    expect(scriptAttachOffset("x_{n}", 4, "_")).toBeNull();
  });

  it("does not hop from the middle of a slot or an empty slot", () => {
    // "x_{a|b}" — the script belongs to `a`, inside the subscript.
    expect(scriptAttachOffset("x_{ab}", 4, "^")).toBeNull();
    // "x_{|}" — nothing to script yet; keep the default behavior.
    expect(scriptAttachOffset("x_{}", 3, "^")).toBeNull();
  });
});
