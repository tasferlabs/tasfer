/**
 * Starting an inline formula with a `\`-command (`\frac`, …): the `\` menu inserts
 * the construct by replacing the typed `\query` run. When the `\` is the chip's
 * FIRST char, that replacement drops the math span's start anchor, so the inserted
 * construct would fall OUT of the chip (become plain text) unless the whole
 * resulting formula is re-marked as math. This pins that engine behavior — the
 * invariant `MathCommandMenu`'s `select` relies on.
 */
import { getInlineMathSpans } from "./inline-math-spans";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

// "aa <latex>" with the chip math-marked over [3, 3+len).
function chip(latex: string) {
  const binding = createCRDTbinding("first-char-cmd", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;
  let page = engine.getState();
  page = insertCharsAtPosition(
    page,
    blockId,
    0,
    "aa " + latex,
    binding,
  ).newPage;
  page = markCharsInRange(
    page,
    blockId,
    3,
    3 + latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  return { page, blockId, binding };
}

describe("inline `\\`-command at a chip's first char", () => {
  it("replacing the first char WITHOUT re-marking orphans the construct", () => {
    // Chip "\x^2" at [3,7): the `\` at chip.from=3 is the run's start anchor.
    let { page, blockId, binding } = chip("\\x^2");
    // select("\frac"): replace the `\` [3,4) with "\frac{}{}".
    page = deleteCharsInRange(page, blockId, 3, 4, binding).newPage;
    page = insertCharsAtPosition(
      page,
      blockId,
      3,
      "\\frac{}{}",
      binding,
    ).newPage;
    const spans = getInlineMathSpans(page.blocks[0]);
    // The inserted construct is NOT covered — the chip shrank to just the tail.
    expect(spans.map((s) => s.latex)).toEqual(["x^2"]);
  });

  it("re-marking the whole resulting formula keeps ONE clean chip", () => {
    let { page, blockId, binding } = chip("\\x^2");
    page = deleteCharsInRange(page, blockId, 3, 4, binding).newPage;
    page = insertCharsAtPosition(
      page,
      blockId,
      3,
      "\\frac{}{}",
      binding,
    ).newPage;
    // The fix: re-mark [chip.from, chip.to + latexLen - (caret - backslash)).
    // chip.to=7, latexLen=9, caret-backslash = 4-3 = 1 → end = 7 + 9 - 1 = 15.
    page = markCharsInRange(
      page,
      blockId,
      3,
      15,
      { type: "math" },
      true,
      binding,
    ).newPage;
    const spans = getInlineMathSpans(page.blocks[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].latex).toBe("\\frac{}{}x^2");
    expect(spans[0].startIndex).toBe(3);
    expect(spans[0].endIndex).toBe(15);
  });
});
