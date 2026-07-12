/**
 * Invariant behind the mobile toolbar's "tap a construct" insert
 * (apps/web MountedEditor `insert-math-command`): dropping a multi-char construct
 * at an inline chip's edge must JOIN it into the chip, not leave raw LaTeX beside
 * it.
 *
 * A single-char chip (a lone variable) has no interior caret stop — a tap snaps
 * to its `from` edge — so the construct is always inserted at the boundary, where
 * it lands just outside the math mark. The host re-marks the chip's full grown
 * extent to swallow it. MathNode's typing edge-join observer can't cover this: it
 * only re-marks the single last-typed char, so a multi-char construct would split.
 * These tests pin the raw-insert gap and the union-remark fix the host depends on.
 */
import { createMathTestSyncEngine } from "./__testutils__/math";
import { getInlineMathSpans } from "./inline-math-spans";
import { insertCharsAtPosition, markCharsInRange } from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { describe, expect, it } from "vitest";

/** A page whose single paragraph holds one inline-math chip `latex` at [0, len). */
function chip(latex: string) {
  const binding = createCRDTbinding("construct-join", "peer-1");
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

function spans(page: ReturnType<typeof chip>["page"], blockId: string) {
  return getInlineMathSpans(
    page.blocks.find((b) => b.id === blockId) ?? page.blocks[0],
  ).map((s) => s.latex);
}

describe("dropping a construct at a single-char chip's edge", () => {
  it("a raw insert at the start edge leaves the construct OUTSIDE the chip", () => {
    // The gap: the construct lands before the chip's marked char, so only the
    // original variable stays a formula and `\frac{}{}` renders as raw source.
    let { page, blockId, binding } = chip("x");
    page = insertCharsAtPosition(
      page,
      blockId,
      0,
      "\\frac{}{}",
      binding,
    ).newPage;
    expect(spans(page, blockId)).toEqual(["x"]);
  });

  it("re-marking the chip's grown extent joins the construct into one formula", () => {
    // The fix: after inserting at offset 0 (chip from), re-mark the union
    // [from, to + len) = [0, 1 + 9) so the construct and the variable read as one
    // chip — what the host's `setMark` over `chip.to + delta` produces.
    let { page, blockId, binding } = chip("x");
    page = insertCharsAtPosition(
      page,
      blockId,
      0,
      "\\frac{}{}",
      binding,
    ).newPage;
    page = markCharsInRange(
      page,
      blockId,
      0,
      1 + "\\frac{}{}".length,
      { type: "math" },
      true,
      binding,
    ).newPage;
    expect(spans(page, blockId)).toEqual(["\\frac{}{}x"]);
  });

  it("re-marking joins a construct dropped at the chip's END edge too", () => {
    // The common case: building a formula left-to-right, the caret sits at the
    // chip's right edge (`caretOffset === chip.to`). Insert at offset 1, then
    // re-mark the union [from, to + len) = [0, 1 + 9).
    let { page, blockId, binding } = chip("x");
    page = insertCharsAtPosition(
      page,
      blockId,
      1,
      "\\frac{}{}",
      binding,
    ).newPage;
    page = markCharsInRange(
      page,
      blockId,
      0,
      1 + "\\frac{}{}".length,
      { type: "math" },
      true,
      binding,
    ).newPage;
    expect(spans(page, blockId)).toEqual(["x\\frac{}{}"]);
  });
});
