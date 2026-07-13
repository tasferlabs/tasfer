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
import { createMathTestSyncEngine } from "./__testutils__/math";
import { getInlineMathSpans } from "./inline-math-spans";
import { mathSelectionRange } from "./nodes/math";
import { insertCharsAtPosition, markCharsInRange } from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { describe, expect, it } from "vitest";

/**
 * A paragraph reading `AB` + a math chip `latex` + `CD`, so the chip is flanked
 * by plain text on both sides. Returns the block plus the chip's block span.
 */
function flankedChip(latex: string) {
  const binding = createCRDTbinding("inline-math-partial", "peer-1");
  const engine = createMathTestSyncEngine(binding);
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

/**
 * A paragraph reading `AB` + chip `latex1` + `CD` + chip `latex2` + `EF`, so two
 * chips are flanked and separated by plain text. Returns the block plus both
 * chips' block spans.
 */
function twoChips(latex1: string, latex2: string) {
  const binding = createCRDTbinding("inline-math-partial-2", "peer-1");
  const engine = createMathTestSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  const text = `AB${latex1}CD${latex2}EF`;
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
    2 + latex1.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  const start2 = 2 + latex1.length + 2;
  page = markCharsInRange(
    page,
    blockId,
    start2,
    start2 + latex2.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  const block = page.blocks[0];
  const [span1, span2] = getInlineMathSpans(block);
  return { block, span1, span2 };
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

  it("endpoints in two different chips select both chips whole", () => {
    const { block, span1, span2 } = twoChips("x+y", "a+b");
    // Anchor one stop inside chip 1, focus one stop inside chip 2: the range
    // spans two constructs, so both snap to whole-chip edges.
    const r = mathSelectionRange(
      block,
      span1.startIndex + 1,
      span2.startIndex + 1,
      "end",
    );
    expect(r).toEqual({ anchor: span1.startIndex, focus: span2.endIndex });
  });

  it("a focus entering a SECOND chip takes it whole, not partially", () => {
    const { block, span2 } = twoChips("x+y", "a+b");
    // Anchor in the leading text, selection already swept over all of chip 1;
    // the focus now rests one stop inside chip 2. With another construct
    // engaged, chip 2 is atomic.
    const r = mathSelectionRange(block, 0, span2.startIndex + 1, "end");
    expect(r).toEqual({ anchor: 0, focus: span2.endIndex });
  });

  it("shrinking back out of the second chip drops it whole", () => {
    const { block, span2 } = twoChips("x+y", "a+b");
    // Focus travelling LEFT (focusEdge "start") rests inside chip 2 on the way
    // back: it snaps to the chip's near edge, dropping the whole chip.
    const r = mathSelectionRange(block, 0, span2.endIndex - 1, "start");
    expect(r).toEqual({ anchor: 0, focus: span2.startIndex });
  });

  it("an interior anchor widens to its whole chip once a second chip is engaged", () => {
    const { block, span1, span2 } = twoChips("x+y", "a+b");
    // Anchor parked inside chip 1, focus dragged past chip 2 into the trailing
    // text: two constructs engaged, so the anchor's partial coverage widens out.
    const focus = span2.endIndex + 1;
    const r = mathSelectionRange(block, span1.startIndex + 1, focus, "end");
    expect(r).toEqual({ anchor: span1.startIndex, focus });
  });

  it("a backward selection into a second chip takes it whole", () => {
    const { block, span1, span2 } = twoChips("x+y", "a+b");
    // Anchor in the trailing text, focus travelling left rests inside chip 1
    // with chip 2 already swept over: chip 1 snaps whole.
    const anchor = span2.endIndex + 2;
    const r = mathSelectionRange(block, anchor, span1.endIndex - 1, "start");
    expect(r).toEqual({ anchor, focus: span1.startIndex });
  });

  it("with only one chip engaged, partial entry is unchanged by a second chip elsewhere", () => {
    const { block, span1 } = twoChips("x+y", "a+b");
    // Focus one stop inside chip 1, chip 2 untouched: the single-construct
    // partial-selection behavior still applies.
    const r = mathSelectionRange(block, 0, span1.startIndex + 1, "end");
    expect(r).toEqual({ anchor: 0, focus: span1.startIndex + 1 });
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
