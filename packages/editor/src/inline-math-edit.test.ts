/**
 * In-place inline-math editing (Phase 3a): a char typed strictly inside a chip
 * joins the LaTeX (the math mark covers it positionally), and an interior delete
 * removes a single LaTeX char — both keeping the chip a single, well-anchored
 * span. Exercised at the CRDT-helper level (the layer the insert/backspace
 * actions call), with ONE binding so char HLCs stay monotonic exactly as in the
 * live editor (a freshly-typed char sorts after the formula's chars).
 */
import { getInlineMathSpans } from "./inline-math-spans";
import {
  mathDeleteUnit,
  mathMaterializeAfterInput,
  mathMergeAfterDelete,
  mathRedundantSpaceAfterInput,
  mathSplitAfterInput,
  mathTransformTypedInput,
  mathUnitBefore,
} from "./nodes/math";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

/** A paragraph holding one inline-math chip `latex`, built from a single binding. */
function chip(latex: string) {
  const binding = createCRDTbinding("inline-math-edit", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  let page = engine.getState();
  page = insertCharsAtPosition(page, blockId, 0, latex, binding).newPage;
  page = markCharsInRange(
    page,
    blockId,
    0,
    latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  return { page, blockId, binding };
}

/** A block equation whose char-run text IS `latex`, built from a single binding. */
function mathBlock(latex: string) {
  const binding = createCRDTbinding("inline-math-edit", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  let page = engine.getState();
  page = insertCharsAtPosition(page, blockId, 0, latex, binding).newPage;
  return { page, blockId, binding };
}

describe("inline-math in-place editing", () => {
  it("a char typed inside the numerator joins the LaTeX, span stays whole", () => {
    const { page, blockId, binding } = chip("\\frac{a}{b}");
    expect(getInlineMathSpans(page.blocks[0])[0].latex).toBe("\\frac{a}{b}");

    // Insert 'x' after the numerator 'a' (visible index 6 → position 7).
    const { newPage } = insertCharsAtPosition(page, blockId, 7, "x", binding);
    const after = getInlineMathSpans(newPage.blocks[0]);
    expect(after).toHaveLength(1);
    expect(after[0].latex).toBe("\\frac{ax}{b}");
  });

  it("an interior delete removes one LaTeX char, span stays whole", () => {
    const { page, blockId, binding } = chip("\\frac{a}{b}");
    // Delete the numerator 'a' (visible index 6).
    const { newPage } = deleteCharsInRange(page, blockId, 6, 7, binding);
    const after = getInlineMathSpans(newPage.blocks[0]);
    expect(after).toHaveLength(1);
    expect(after[0].latex).toBe("\\frac{}{b}");
  });

  it("the raw insert helper leaves an edge char outside the chip", () => {
    // At the CRDT-helper layer an edge char lands OUTSIDE the math mark — typing
    // at `endIndex` inserts past the chip's last marked char. Treating the edge
    // as inside (re-marking the chip to swallow the char) is layered on top by
    // MathNode's post-insert observer, exercised through the real action pipeline
    // in `inline-math-split-merge.test.ts` ("typing a non-space char at the …
    // edge joins the formula"). This pins the helper's lower-level contract.
    const { page, blockId, binding } = chip("x^2");
    const end = getInlineMathSpans(page.blocks[0])[0].endIndex; // past last char
    const { newPage } = insertCharsAtPosition(page, blockId, end, "z", binding);
    expect(getInlineMathSpans(newPage.blocks[0])[0].latex).toBe("x^2");
  });

  it("backspace inside a chip removes a whole command unit, not one char", () => {
    // "a\pm b": a backspace just after `\pm` (source offset 4) deletes the whole
    // command — the same range the backspace action computes via the bridge —
    // leaving "a b" with the span's anchor chars ('a', 'b') intact. `\pm` is one
    // AST node, so the unit is the leaf [1,4), not a single char.
    const { page, blockId, binding } = chip("a\\pm b");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const unit = mathUnitBefore(span.latex, 4)!;
    expect(unit.isConstruct).toBe(false);
    const from = span.startIndex + unit.start;
    expect(from).toBe(span.startIndex + 1); // back to the start of `\pm`, not 3

    const { newPage } = deleteCharsInRange(
      page,
      blockId,
      from,
      span.startIndex + 4,
      binding,
    );
    const after = getInlineMathSpans(newPage.blocks[0]);
    expect(after).toHaveLength(1);
    expect(after[0].latex).toBe("a b");
  });

  it("backspace at a single-construct chip's edge chips off its trailing leaf, not the whole construct", () => {
    // A chip that is itself one construct (`\sqrt{a}`) must not be selected and
    // deleted whole from outside: Backspace just past it enters and removes the
    // radicand's trailing leaf `a` (→ `\sqrt{}`), one unit at a time. Resting at
    // the chip's far edge is visually indistinguishable from "just after `a`"
    // (the closing brace has zero width), so this is what the user expects.
    const { page, blockId, binding } = chip("\\sqrt{a}");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const unit = mathDeleteUnit(page.blocks[0], span.endIndex, "backward")!;
    expect(unit.isConstruct).toBe(false);
    expect({ from: unit.from, to: unit.to }).toEqual({
      from: span.startIndex + 6, // the `a`
      to: span.startIndex + 7,
    });
    const { newPage } = deleteCharsInRange(
      page,
      blockId,
      unit.from,
      unit.to,
      binding,
    );
    expect(getInlineMathSpans(newPage.blocks[0])[0].latex).toBe("\\sqrt{}");
  });

  it("delete at a single-construct chip's left edge chips off its leading leaf", () => {
    const { page } = chip("\\sqrt{a}");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const unit = mathDeleteUnit(page.blocks[0], span.startIndex, "forward")!;
    expect(unit.isConstruct).toBe(false);
    expect({ from: unit.from, to: unit.to }).toEqual({
      from: span.startIndex + 6,
      to: span.startIndex + 7,
    });
  });

  it("a plain trailing leaf at a chip edge is still erased directly (no construct drill)", () => {
    // `xy` is not one construct — Backspace at its edge removes the trailing `y`.
    const { page } = chip("xy");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const unit = mathDeleteUnit(page.blocks[0], span.endIndex, "backward")!;
    expect({
      from: unit.from,
      to: unit.to,
      isConstruct: unit.isConstruct,
    }).toEqual({
      from: span.startIndex + 1,
      to: span.startIndex + 2,
      isConstruct: false,
    });
  });

  it("materializing \\frac inside a chip marks the new braces so they stay in the formula", () => {
    // Typing `\frac` as a standalone chip then materializing must keep the `{}{}`
    // INSIDE the chip (they land at the chip's right edge, otherwise outside the
    // math mark) and drop the caret in the first empty slot.
    const { page } = chip("\\frac");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const mat = mathMaterializeAfterInput(page.blocks[0], span.endIndex)!;
    expect(mat.inserts).toEqual([{ at: span.startIndex + 5, text: "{}{}" }]);
    // The grown chip [start, end + 4) must be re-marked so the braces join it.
    expect(mat.markRange).toEqual({
      from: span.startIndex,
      to: span.endIndex + 4,
    });
    // Caret lands inside the first `{}` (numerator), not in trailing plain text.
    expect(mat.caret).toBe(span.startIndex + 6);
  });

  it("the \\ command menu replaces the typed query with the construct, span whole", () => {
    // "a\sum b": the user typed `\sum` inside a chip (with 'a' before and ' b'
    // after as anchors). Selecting "Summation" replaces [1,5) (the `\sum`) with
    // the template — the exact interior delete+insert the change API runs — so
    // the chip stays one span and becomes "a\sum_{}^{} b", ready to fill.
    const { page, blockId, binding } = chip("a\\sum b");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const from = span.startIndex + 1; // the `\`
    const to = span.startIndex + 5; // after `\sum`

    const { newPage: p1 } = deleteCharsInRange(
      page,
      blockId,
      from,
      to,
      binding,
    );
    const { newPage: p2 } = insertCharsAtPosition(
      p1,
      blockId,
      from,
      "\\sum_{}^{}",
      binding,
    );
    const after = getInlineMathSpans(p2.blocks[0]);
    expect(after).toHaveLength(1);
    expect(after[0].latex).toBe("a\\sum_{}^{} b");
  });
});

describe("inline-math split on space / merge on delete", () => {
  it("a space typed inside a chip splits it into two chips around a plain space", () => {
    // "xy" chip; type a space between x and y → block text "x y", caret at 2.
    const { page, blockId, binding } = chip("xy");
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      1,
      " ",
      binding,
    );
    // Still one tolerant span before the split runs.
    expect(getInlineMathSpans(typed.blocks[0])[0].latex).toBe("x y");

    // The post-insert observer strips "math" from the just-typed space (caret 2).
    const split = mathSplitAfterInput(typed.blocks[0], 2)!;
    expect(split).toEqual({ from: 1, to: 2 });
    const { newPage: out } = markCharsInRange(
      typed,
      blockId,
      split.from,
      split.to,
      { type: "math" },
      false,
      binding,
    );

    const spans = getInlineMathSpans(out.blocks[0]);
    expect(spans.map((s) => s.latex)).toEqual(["x", "y"]);
  });

  it("a space typed inside a construct does not split (cannot divide a construct)", () => {
    // "\frac{a}{b}" chip; type a space inside the numerator, right after `a`.
    const { page, blockId, binding } = chip("\\frac{a}{b}");
    const numEnd = "\\frac{a".length; // position just after `a`
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      numEnd,
      " ",
      binding,
    );
    // Caret lands just past the typed space.
    expect(mathSplitAfterInput(typed.blocks[0], numEnd + 1)).toBeNull();
    // The chip stays whole, with the space living in the math source.
    const spans = getInlineMathSpans(typed.blocks[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].latex).toBe("\\frac{a }{b}");
  });

  it("deleting the separating space merges the two chips back into one", () => {
    // Start from the split state: two chips "x" and "y" with a plain space at 1.
    const { page, blockId, binding } = chip("xy");
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      1,
      " ",
      binding,
    );
    const { newPage: split } = markCharsInRange(
      typed,
      blockId,
      1,
      2,
      { type: "math" },
      false,
      binding,
    );
    expect(getInlineMathSpans(split.blocks[0])).toHaveLength(2);

    // Delete the plain space → the two chips become adjacent.
    const { newPage: deleted } = deleteCharsInRange(
      split,
      blockId,
      1,
      2,
      binding,
    );
    const plans = mathMergeAfterDelete(deleted.blocks[0])!;
    expect(plans).toEqual([{ from: 0, to: 2, separatorsAt: [] }]);

    const { newPage: merged } = markCharsInRange(
      deleted,
      blockId,
      plans[0].from,
      plans[0].to,
      { type: "math" },
      true,
      binding,
    );
    const spans = getInlineMathSpans(merged.blocks[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].latex).toBe("xy");
  });

  it("plans a separator when merging would fuse a command with a letter", () => {
    // Two adjacent chips "\sin" and "x" (no char between) must re-merge to the
    // valid "\sin x", not the broken unknown command "\sinx".
    const { page, blockId, binding } = chip("\\sinx");
    // Mark [0,4) "\sin" and [4,5) "x" as two separate touching math chips.
    let p = markCharsInRange(
      page,
      blockId,
      0,
      4,
      { type: "math" },
      false,
      binding,
    ).newPage;
    p = markCharsInRange(
      p,
      blockId,
      0,
      4,
      { type: "math" },
      true,
      binding,
    ).newPage;
    p = markCharsInRange(
      p,
      blockId,
      4,
      5,
      { type: "math" },
      true,
      binding,
    ).newPage;
    expect(getInlineMathSpans(p.blocks[0]).map((s) => s.latex)).toEqual([
      "\\sin",
      "x",
    ]);
    const plans = mathMergeAfterDelete(p.blocks[0])!;
    expect(plans).toEqual([{ from: 0, to: 5, separatorsAt: [4] }]);
  });

  it("no merge when the chips are still separated by text", () => {
    const { page, blockId, binding } = chip("xy");
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      1,
      " ",
      binding,
    );
    const { newPage: split } = markCharsInRange(
      typed,
      blockId,
      1,
      2,
      { type: "math" },
      false,
      binding,
    );
    // The space is still there, so the two chips are not adjacent.
    expect(mathMergeAfterDelete(split.blocks[0])).toBeNull();
  });
});

describe("inline-math redundant-space drop", () => {
  it("flags a meaningless space typed inside a construct for deletion", () => {
    // "\frac{a}{b}" chip; type a space inside the numerator, right after `a`.
    // It can't split (a construct is indivisible) and renders identically with
    // or without it, so it's dead source to drop — not saved as `\frac{a }{b}`.
    const { page, blockId, binding } = chip("\\frac{a}{b}");
    const numEnd = "\\frac{a".length;
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      numEnd,
      " ",
      binding,
    );
    expect(mathSplitAfterInput(typed.blocks[0], numEnd + 1)).toBeNull();
    expect(mathRedundantSpaceAfterInput(typed.blocks[0], numEnd + 1)).toEqual({
      from: numEnd,
      to: numEnd + 1,
    });
  });

  it("keeps a space that separates a command from a following letter", () => {
    // "\sinx" with a space typed before the `x` → "\sin x": the space is load-
    // bearing (dropping it fuses into the unknown command "\sinx").
    const { page, blockId, binding } = chip("\\sinx");
    const at = "\\sin".length;
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      at,
      " ",
      binding,
    );
    expect(getInlineMathSpans(typed.blocks[0])[0].latex).toBe("\\sin x");
    expect(mathRedundantSpaceAfterInput(typed.blocks[0], at + 1)).toBeNull();
  });

  it("keeps a literal space inside a text-mode group", () => {
    // "\text{ab}" with a space typed between the letters → "\text{a b}": text-mode
    // spaces are real glyphs, so the space must survive.
    const { page, blockId, binding } = chip("\\text{ab}");
    const at = "\\text{a".length;
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      at,
      " ",
      binding,
    );
    expect(getInlineMathSpans(typed.blocks[0])[0].latex).toBe("\\text{a b}");
    expect(mathRedundantSpaceAfterInput(typed.blocks[0], at + 1)).toBeNull();
  });

  it("drops a meaningless space typed inside a block equation", () => {
    // Block math "ab"; a space typed between the atoms renders identically, so
    // it's flagged for deletion rather than persisted as "a b".
    const { page, blockId, binding } = mathBlock("ab");
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      1,
      " ",
      binding,
    );
    expect(typed.blocks[0].type).toBe("math");
    expect(mathRedundantSpaceAfterInput(typed.blocks[0], 2)).toEqual({
      from: 1,
      to: 2,
    });
  });

  it("keeps a command separator in a block equation", () => {
    const { page, blockId, binding } = mathBlock("\\sinx");
    const at = "\\sin".length;
    const { newPage: typed } = insertCharsAtPosition(
      page,
      blockId,
      at,
      " ",
      binding,
    );
    expect(mathRedundantSpaceAfterInput(typed.blocks[0], at + 1)).toBeNull();
  });
});

describe("script typed at an accent base's end scripts the whole construct", () => {
  it("redirects `^` typed at \\dot{x|} to just past the construct (block)", () => {
    // The accent is one construct: the script must attach to \dot{x} as a whole
    // (`\dot{x}^{…}`), never grow the base under the dot (`\dot{x^{…}}`).
    const { page } = mathBlock("\\dot{x}");
    const caret = "\\dot{x".length;
    expect(mathTransformTypedInput(page.blocks[0], caret, "^")).toEqual({
      input: "^",
      insertAt: "\\dot{x}".length,
    });
  });

  it("re-bases the redirect target to block coordinates inside a chip", () => {
    // Chip "\vec{v}" preceded by plain text "t ": chip-local hop 6 → 7 must map
    // to block indices (startIndex + offset), and markdown stays suppressed.
    const { page, blockId, binding } = chip("\\vec{v}");
    const { newPage } = insertCharsAtPosition(page, blockId, 0, "t ", binding);
    const span = getInlineMathSpans(newPage.blocks[0])[0];
    expect(span.latex).toBe("\\vec{v}");
    const caret = span.startIndex + "\\vec{v".length;
    expect(mathTransformTypedInput(newPage.blocks[0], caret, "_")).toEqual({
      input: "_",
      suppressMarkdown: true,
      insertAt: span.startIndex + "\\vec{v}".length,
    });
  });

  it("materializes the redirected script into \\dot{x}^{} with the caret in it", () => {
    // Full flow: redirect the insert, apply it, then the TEXT_INPUTTED
    // materializer fills the script's braces and lands the caret inside them.
    const { page, blockId, binding } = mathBlock("\\dot{x}");
    const t = mathTransformTypedInput(page.blocks[0], "\\dot{x".length, "^")!;
    const { newPage } = insertCharsAtPosition(
      page,
      blockId,
      t.insertAt!,
      t.input,
      binding,
    );
    const caret = t.insertAt! + 1;
    const mat = mathMaterializeAfterInput(newPage.blocks[0], caret)!;
    expect(mat.inserts).toEqual([{ at: caret, text: "{}" }]);
    expect(mat.caret).toBe(caret + 1);
  });

  it("does not redirect from the middle of the base or inside \\widehat", () => {
    // Mid-base (`\dot{x|y}`): no construct redirect — but a `y` follows, which a
    // bare `^` would swallow, so the script emits its empty box AT the caret
    // (insertAt is the caret, not hopped past the accent) and keeps `y` a sibling.
    const mid = mathBlock("\\dot{xy}");
    expect(
      mathTransformTypedInput(mid.page.blocks[0], "\\dot{x".length, "^"),
    ).toEqual({
      input: "^{}",
      insertAt: "\\dot{x".length,
      caret: "\\dot{x^".length + 1,
    });
    // At the end of a stretchy accent's base (`\widehat{ab|}`) the next char is the
    // slot's own `}` — nothing to grab — so the bare operator passes through
    // unchanged (null) for the materializer to open the box.
    const wide = mathBlock("\\widehat{ab}");
    expect(
      mathTransformTypedInput(wide.page.blocks[0], "\\widehat{ab".length, "^"),
    ).toBeNull();
  });
});

describe("typed braces become their escaped literal form in math content", () => {
  it("escapes { typed in a block equation", () => {
    const { page } = mathBlock("x+1");
    expect(mathTransformTypedInput(page.blocks[0], 3, "{")).toEqual({
      input: "\\{",
    });
  });

  it("escapes } typed inside a chip's construct slot (never closes the slot)", () => {
    const { page } = chip("\\frac{12}{2}");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const caret = span.startIndex + "\\frac{12".length;
    expect(mathTransformTypedInput(page.blocks[0], caret, "}")).toEqual({
      input: "\\}",
      suppressMarkdown: true,
    });
  });

  it("keeps { raw right after a typed backslash (completing \\{ itself)", () => {
    const { page } = mathBlock("\\");
    expect(mathTransformTypedInput(page.blocks[0], 1, "{")).toBeNull();
  });

  it("keeps { raw after a control word (opening its argument)", () => {
    const { page } = mathBlock("\\text");
    expect(mathTransformTypedInput(page.blocks[0], 5, "{")).toBeNull();
  });

  it("keeps } raw while a raw-opened group is unclosed", () => {
    const { page } = mathBlock("\\text{ab");
    expect(mathTransformTypedInput(page.blocks[0], 8, "}")).toBeNull();
  });

  it("a multi-char insert keeps its braces (source text, not a keystroke)", () => {
    const { page } = mathBlock("x");
    expect(
      mathTransformTypedInput(page.blocks[0], 1, "\\frac{a}{b}"),
    ).toBeNull();
  });
});
