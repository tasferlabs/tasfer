/**
 * In-place inline-math editing (Phase 3a): a char typed strictly inside a chip
 * joins the LaTeX (the math mark covers it positionally), and an interior delete
 * removes a single LaTeX char — both keeping the chip a single, well-anchored
 * span. Exercised at the CRDT-helper level (the layer the insert/backspace
 * actions call), with ONE binding so char HLCs stay monotonic exactly as in the
 * live editor (a freshly-typed char sorts after the formula's chars).
 */
import { getInlineMathSpans } from "./inline-math-spans";
import { mathUnitBefore } from "./nodes/math";
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

  it("typing at the right edge inserts plain text after the chip", () => {
    const { page, blockId, binding } = chip("x^2");
    const end = getInlineMathSpans(page.blocks[0])[0].endIndex; // past last char
    const { newPage } = insertCharsAtPosition(page, blockId, end, "z", binding);
    // The chip is unchanged; 'z' is outside it.
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

  it("the \\ command menu replaces the typed query with the construct, span whole", () => {
    // "a\int b": the user typed `\int` inside a chip (with 'a' before and ' b'
    // after as anchors). Selecting "Integral" replaces [1,5) (the `\int`) with
    // the template — the exact interior delete+insert the change API runs — so
    // the chip stays one span and becomes "a\int_{}^{} b", ready to fill.
    const { page, blockId, binding } = chip("a\\int b");
    const span = getInlineMathSpans(page.blocks[0])[0];
    const from = span.startIndex + 1; // the `\`
    const to = span.startIndex + 5; // after `\int`

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
      "\\int_{}^{}",
      binding,
    );
    const after = getInlineMathSpans(p2.blocks[0]);
    expect(after).toHaveLength(1);
    expect(after[0].latex).toBe("a\\int_{}^{} b");
  });
});
