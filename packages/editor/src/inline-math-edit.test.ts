/**
 * In-place inline-math editing (Phase 3a): a char typed strictly inside a chip
 * joins the LaTeX (the math mark covers it positionally), and an interior delete
 * removes a single LaTeX char — both keeping the chip a single, well-anchored
 * span. Exercised at the CRDT-helper level (the layer the insert/backspace
 * actions call), with ONE binding so char HLCs stay monotonic exactly as in the
 * live editor (a freshly-typed char sorts after the formula's chars).
 */
import { createMathTestSyncEngine } from "./__testutils__/math";
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
import { createCRDTbinding } from "./sync/sync";
import { describe, expect, it } from "vitest";

/** A paragraph holding one inline-math chip `latex`, built from a single binding. */
function chip(latex: string) {
  const binding = createCRDTbinding("inline-math-edit", "peer-1");
  const engine = createMathTestSyncEngine(binding);
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
  const engine = createMathTestSyncEngine(binding);
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

  it("escapes a `}` typed before an existing group's closer to a literal glyph", () => {
    // `\text{hi|}` (a pre-existing, balanced run) — caret flush before the closing
    // `}`. A typed `}` NEVER steps over a construct's closer: it is a literal brace
    // glyph the user wants IN the group, so it escapes to `\}` (`\text{hi\}}`),
    // exactly like the fraction-slot case below. Group `{}` come from
    // materialization/paste, not from this typing path, so there is no auto-pair
    // closer to step over.
    const { page } = chip("\\text{hi}");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const caret = span.startIndex + "\\text{hi".length;
    expect(mathTransformTypedInput(page.blocks[0], caret, "}")).toEqual({
      input: "\\}",
      suppressMarkdown: true,
    });
  });

  it("escapes a `}` typed at a fraction slot's end to a literal glyph", () => {
    // `\frac{12|}{2}` — caret in the numerator, flush before its closing `}`. A
    // fraction's `{}` slots are MATERIALIZED (`\frac` → `\frac{}{}`), not a brace
    // pair the user typed and had auto-closed, so a typed `}` here is a literal
    // brace glyph the user wants IN the slot — it escapes to `\}` (`\frac{12\}}{2}`)
    // instead of stepping over the closer. Stepping over stranded the caret in the
    // `}{` gap, so the next typed `}` escaped into the denominator
    // (`\frac{12}\}{2}` — a stray brace under the bar, the reported corruption).
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

  it("escapes a `{` typed after a command word (no argument auto-open)", () => {
    // A typed `{` never opens a command's argument — even flush after `\text`, it
    // is a literal brace glyph, so it escapes to `\{` (`\text\{`). This makes the
    // "raw `{` runs to the source end and swallows the trailing content" corruption
    // unrepresentable; a `\text{…}` run enters via materialization or paste, not
    // this single-char typing path.
    const { page } = mathBlock("\\text");
    expect(mathTransformTypedInput(page.blocks[0], 5, "{")).toEqual({
      input: "\\{",
    });
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

  it("a \\ typed before a slot's closing brace gains a separating space", () => {
    // Regression: caret in `\frac{|}{}`, user types `\` to start a command. Without
    // a separator the `\` fuses with the numerator's `}` into `\}` (a brace glyph),
    // unclosing the numerator so the parser materializes a phantom slot at the end
    // and a stray `{}` block appears beside the fraction. The transform inserts a
    // separating space instead — `\frac{\ }{}` (balanced, no phantom) — and lands
    // the caret between the `\` and the space so command typing continues.
    const eq = mathBlock("\\frac{}{}");
    const numCaret = "\\frac{".length; // 6, inside the empty numerator
    expect(mathTransformTypedInput(eq.page.blocks[0], numCaret, "\\")).toEqual({
      input: "\\ ",
      caret: numCaret + 1,
    });

    // Same at the boundary before the NEXT slot's opening brace (`\frac{}|{}`).
    const between = "\\frac{}".length; // 7, before the denominator's `{`
    expect(mathTransformTypedInput(eq.page.blocks[0], between, "\\")).toEqual({
      input: "\\ ",
      caret: between + 1,
    });

    // Inside an inline chip the same holds, plus markdown is suppressed.
    const c = chip("\\frac{}{}");
    const span = getInlineMathSpans(c.page.blocks[0])[0];
    expect(
      mathTransformTypedInput(c.page.blocks[0], span.startIndex + 6, "\\"),
    ).toEqual({
      input: "\\ ",
      suppressMarkdown: true,
      caret: span.startIndex + 7,
    });
  });

  it("materialization no longer appends a stray block for a \\-separated frac slot", () => {
    // With the separator in place the numerator is `\ ` (a control space), not the
    // brace-eating `\}`, so the source stays balanced and the materializer finds
    // nothing to fill — no phantom `{}` beside the fraction, and it holds as the
    // command grows (`\frac{\alpha }{}`).
    for (const latex of ["\\frac{\\ }{}", "\\frac{\\alpha }{}"]) {
      const { page } = mathBlock(latex);
      expect(
        mathMaterializeAfterInput(page.blocks[0], latex.length),
      ).toBeNull();
    }
  });

  it("a \\ typed before a matrix column separator gains a separating space", () => {
    // The reported bug: caret after `a`, before the `&` in a matrix row. Without a
    // separator the `\` fuses with the `&` into `\&` — a literal ampersand, not a
    // column separator — so the two cells merge into one and a cell is lost. The
    // transform wedges a `\ ` control space so the `&` keeps separating the cells.
    const eq = mathBlock("\\begin{matrix}a&b\\end{matrix}");
    const ampCaret = "\\begin{matrix}a".length; // just before the `&`
    expect(mathTransformTypedInput(eq.page.blocks[0], ampCaret, "\\")).toEqual({
      input: "\\ ",
      caret: ampCaret + 1,
    });
  });

  it("a \\ typed before a script operator or row break gains a separating space", () => {
    // Before `^`: without the separator `x|^2` fuses into `x\^2` (a literal caret,
    // the `2` de-scripts). Before a matrix row break `\\`: `|\\` would extend into
    // `\\\` and orphan the row structure.
    const script = mathBlock("x^2");
    expect(mathTransformTypedInput(script.page.blocks[0], 1, "\\")).toEqual({
      input: "\\ ",
      caret: 2,
    });

    const rows = mathBlock("\\begin{matrix}a\\\\b\\end{matrix}");
    const rowCaret = "\\begin{matrix}a".length; // just before the `\\`
    expect(
      mathTransformTypedInput(rows.page.blocks[0], rowCaret, "\\"),
    ).toEqual({
      input: "\\ ",
      caret: rowCaret + 1,
    });
  });

  it("a \\ typed before a \\sqrt index bracket gains a separating space", () => {
    // `\sqrt[3]{x}` — caret after `3`, before the `]`. Without a separator the `\`
    // fuses into `\]`, so the optional index runs past the bracket and swallows the
    // `{x}` radicand (leaving the root empty). The `\ ` keeps the `]` closing the
    // index, so the radicand survives.
    const eq = mathBlock("\\sqrt[3]{x}");
    const idxCaret = "\\sqrt[3".length; // just before the `]`
    expect(mathTransformTypedInput(eq.page.blocks[0], idxCaret, "\\")).toEqual({
      input: "\\ ",
      caret: idxCaret + 1,
    });
  });

  it("keeps { raw right after a typed backslash in open space (completing \\{)", () => {
    // The separator only triggers when a brace is ALREADY at the caret. A lone `\`
    // typed in open space (next char not a brace) passes through untouched, so the
    // two-keystroke `\` then `{` still composes the escaped `\{`.
    const { page } = mathBlock("x");
    expect(mathTransformTypedInput(page.blocks[0], 1, "\\")).toBeNull();
  });
});

describe("typed $, #, %, & become their escaped literal form in math content", () => {
  it("escapes $, #, % typed in a block equation to their literal glyphs", () => {
    for (const [ch, escaped] of [
      ["$", "\\$"],
      ["#", "\\#"],
      ["%", "\\%"],
    ] as const) {
      const { page } = mathBlock("x+1");
      expect(mathTransformTypedInput(page.blocks[0], 3, ch)).toEqual({
        input: escaped,
      });
    }
  });

  it("escapes a & typed outside a matrix (a raw & would be dropped by the parser)", () => {
    const { page } = mathBlock("a");
    expect(mathTransformTypedInput(page.blocks[0], 1, "&")).toEqual({
      input: "\\&",
    });
  });

  it("keeps a & raw inside a matrix cell (real column separator)", () => {
    // Caret after the first cell's content: the `&` moves to the next column and
    // must stay a structural separator, not become a literal ampersand glyph.
    const { page } = mathBlock("\\begin{matrix}a&b\\end{matrix}");
    const caret = "\\begin{matrix}a".length;
    expect(mathTransformTypedInput(page.blocks[0], caret, "&")).toBeNull();
  });

  it("keeps the char raw right after a typed backslash (completing the escape)", () => {
    // Two-keystroke `\` then `&` composes `\&` — the second keystroke must not
    // escape again into `\\&`.
    const { page } = mathBlock("\\");
    expect(mathTransformTypedInput(page.blocks[0], 1, "&")).toBeNull();
    expect(mathTransformTypedInput(page.blocks[0], 1, "$")).toBeNull();
  });

  it("suppresses markdown when escaping inside an inline chip", () => {
    // Caret between the two chars, clearly interior to the chip — a stray `$`
    // there must not be left raw to reinterpret the surrounding markdown.
    const { page } = chip("ab");
    const span = getInlineMathSpans(page.blocks[0])[0];
    expect(
      mathTransformTypedInput(page.blocks[0], span.startIndex + 1, "$"),
    ).toEqual({ input: "\\$", suppressMarkdown: true });
  });

  it("a multi-char insert keeps its raw chars (source text, not a keystroke)", () => {
    // No single-char escape applies, and the insert is unchanged, so the
    // transform reports nothing to do (the `&` stays raw source text).
    const { page } = mathBlock("x");
    expect(mathTransformTypedInput(page.blocks[0], 1, "a&b")).toBeNull();
  });
});

describe("typing an unknown command is never blocked (keystrokes always land)", () => {
  it("lets a letter through even when it builds an unknown command", () => {
    // `\fra` + `k` → `\frak`. `\frak` isn't a real command, but the keystroke is
    // NEVER swallowed — the user's action always takes effect (it renders as an
    // unknown command, not silently dropped). `null` = insert `k` verbatim.
    const { page } = mathBlock("\\fra");
    expect(mathTransformTypedInput(page.blocks[0], 4, "k")).toBeNull();
    // A dead-end first letter right after a lone `\` lands too.
    const b = mathBlock("\\");
    expect(mathTransformTypedInput(b.page.blocks[0], 1, "Y")).toBeNull();
  });

  it("passes a completing letter straight through", () => {
    // `\fra` + `c` → `\frac`.
    const { page } = mathBlock("\\fra");
    expect(mathTransformTypedInput(page.blocks[0], 4, "c")).toBeNull();
  });

  it("still separates a letter after a COMPLETE command (a new atom)", () => {
    // `\alpha` + `s` is the variable `s`, separated so it doesn't fuse into the
    // unknown `\alphas` — a separator space, not a blocked keystroke.
    const { page } = mathBlock("\\alpha");
    expect(mathTransformTypedInput(page.blocks[0], 6, "s")).toEqual({
      input: " s",
    });
  });

  it("never touches plain-text letters", () => {
    const { page } = mathBlock("ab");
    expect(mathTransformTypedInput(page.blocks[0], 2, "c")).toBeNull();
  });

  it("lands the keystroke (suppressing markdown) inside an inline chip", () => {
    // Caret interior to the chip, at the trailing edge of the `\fra` run (before
    // the `x`) — typing `k` builds `\frakx`, and the keystroke still lands.
    const { page } = chip("\\frax");
    const span = getInlineMathSpans(page.blocks[0])[0];
    expect(
      mathTransformTypedInput(page.blocks[0], span.startIndex + 4, "k"),
    ).toEqual({ input: "k", suppressMarkdown: true });
  });

  it("keeps a multi-char insert intact (source text)", () => {
    // A paste of `\frak` is source, not a keystroke — inserted verbatim.
    const { page } = mathBlock("x");
    expect(mathTransformTypedInput(page.blocks[0], 1, "\\frak")).toBeNull();
  });
});
