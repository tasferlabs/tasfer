/**
 * Partial selection across an inline-math chip.
 *
 * A chip's own top-level tokens are selectable, so a range that crosses INTO a
 * chip from surrounding text (Shift+Arrow or a drag) may rest at an interior
 * caret stop — selecting part of the formula — and covers the whole chip only
 * once the moving focus reaches the chip's far edge (i.e. once it has selected
 * fully out the other side). A nested construct is still never partially
 * covered: entering it snaps to the whole construct. Drives `mathSelectionRange`
 * directly (the level-aware snap the shift-select / drag paths funnel through).
 */
import { getInlineMathSpans } from "./inline-math-spans";
import { mathSelectionRange } from "./nodes/math";
import { insertCharsAtPosition, markCharsInRange } from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

/**
 * A paragraph reading `AB` + a math chip `latex` + `CD`, so the chip is flanked
 * by plain text on both sides. Returns the block plus the chip's block span.
 */
function flankedChip(latex: string) {
  const binding = createCRDTbinding("inline-math-partial", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  const text = `AB${latex}CD`;
  let page = insertCharsAtPosition(
    engine.getState(),
    blockId,
    0,
    text,
    binding,
  ).newPage;
  page = markCharsInRange(
    page,
    blockId,
    2,
    2 + latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  const block = page.blocks[0];
  const span = getInlineMathSpans(block)[0];
  return { block, span };
}

describe("inline-math — partial selection across a chip", () => {
  it("a forward selection entering the chip rests at an interior stop", () => {
    // `AB` `x+y` `CD`: chip is [2,5), interior stops at 3 (after x) and 4 (after +).
    const { span } = flankedChip("x+y");
    expect(span.startIndex).toBe(2);
    expect(span.endIndex).toBe(5);
  });

  it("focus stepping into the chip selects only the covered tokens, not the whole chip", () => {
    const { block, span } = flankedChip("x+y");
    // Anchor in the leading plain text, focus one stop inside the chip (after `x`).
    const r = mathSelectionRange(block, 0, span.startIndex + 1, "end");
    expect(r).toEqual({ anchor: 0, focus: span.startIndex + 1 });
  });

  it("the whole chip is selected only once the focus reaches its far edge", () => {
    const { block, span } = flankedChip("x+y");
    // Focus at the chip's right edge (endIndex) — no endpoint is strictly inside,
    // so nothing snaps and the range already spans the whole chip.
    const r = mathSelectionRange(block, 0, span.endIndex, "end");
    expect(r).toBeNull();
  });

  it("a backward selection entering from the right rests at an interior stop", () => {
    const { block, span } = flankedChip("x+y");
    // Anchor in the trailing plain text (past `CD`), focus one stop inside the
    // chip from the right (before `y`).
    const anchor = span.endIndex + 2; // past C, D
    const r = mathSelectionRange(block, anchor, span.endIndex - 1, "start");
    expect(r).toEqual({ anchor, focus: span.endIndex - 1 });
  });

  it("an interior anchor stays put when the focus leaves the chip (partial)", () => {
    const { block, span } = flankedChip("x+y");
    // Anchor parked after `x` inside the chip, focus dragged out to the right.
    const focus = span.endIndex + 2;
    const r = mathSelectionRange(block, span.startIndex + 1, focus, "end");
    expect(r).toEqual({ anchor: span.startIndex + 1, focus });
  });

  it("a nested construct is never partially covered — entering it snaps whole", () => {
    // The chip IS a single top-level construct: a selection crossing into it from
    // outside takes the whole `\frac`, never half of it.
    const { block, span } = flankedChip("\\frac{a}{b}");
    const aOffset = "\\frac{a}{b}".indexOf("{a}") + 1; // the numerator glyph
    const r = mathSelectionRange(block, 0, span.startIndex + aOffset, "end");
    expect(r).toEqual({ anchor: 0, focus: span.endIndex });
  });

  it("both endpoints inside one chip still resolve at the chip's own levels", () => {
    // Regression: the both-inside path is unchanged — a range wholly within the
    // chip selects its top-level tokens.
    const { block, span } = flankedChip("x+y");
    const r = mathSelectionRange(
      block,
      span.startIndex + 1,
      span.startIndex + 2,
      "end",
    );
    expect(r).toEqual({
      anchor: span.startIndex + 1,
      focus: span.startIndex + 2,
    });
  });
});
