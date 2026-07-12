/**
 * Render and edit must resolve an inline-math chip to the SAME extent.
 *
 * The edit/caret path (`getInlineMathSpans`) and the render path
 * (`TextNode.replacementRuns`) both now go through `resolveMarkRunsFromChars`,
 * the one tolerant, ordinal-based resolver. Before that, the render path did a
 * strict `startCharId`/`endCharId` lookup and dropped a whole chip the moment an
 * endpoint char was tombstoned (e.g. backspacing the last char of a formula),
 * while the caret kept descending into it — so the painted chip and the live
 * caret diverged. These pin the two paths together over the resolver they share.
 */
import { createMathTestSyncEngine } from "./__testutils__/math";
import {
  getInlineMathSpans,
  resolveMarkRunsFromChars,
} from "./inline-math-spans";
import type { Block } from "./serlization/loadPage";
import { charRunsToChars } from "./sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { describe, expect, it } from "vitest";

function chip(latex: string) {
  const binding = createCRDTbinding("render-res", "peer-1");
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

/** The math run the render path resolves (mirrors `TextNode.replacementRuns`). */
function renderMathRun(
  block: Block,
): { start: number; end: number; text: string } | null {
  const r = resolveMarkRunsFromChars(
    charRunsToChars(block.charRuns),
    block.formats,
  ).find((run) => run.name === "math");
  return r ? { start: r.startIndex, end: r.endIndex, text: r.text } : null;
}

describe("inline-math render/edit resolution agree", () => {
  it("a whole chip resolves identically for render and edit", () => {
    const { page } = chip("\\frac{a}{b}");
    const edit = getInlineMathSpans(page.blocks[0])[0];
    const render = renderMathRun(page.blocks[0])!;
    expect(render.text).toBe(edit.latex);
    expect(render.start).toBe(edit.startIndex);
    expect(render.end).toBe(edit.endIndex);
  });

  it("survives deleting the chip's TRAILING anchor char (render no longer drops it)", () => {
    const { page, blockId, binding } = chip("xy");
    const { newPage } = deleteCharsInRange(page, blockId, 1, 2, binding); // del 'y'
    const edit = getInlineMathSpans(newPage.blocks[0])[0];
    const render = renderMathRun(newPage.blocks[0]);
    expect(edit.latex).toBe("x");
    expect(render).not.toBeNull();
    expect(render!.text).toBe(edit.latex);
    expect(render!.start).toBe(edit.startIndex);
    expect(render!.end).toBe(edit.endIndex);
  });

  it("survives deleting the chip's LEADING anchor char", () => {
    const { page, blockId, binding } = chip("ab");
    const { newPage } = deleteCharsInRange(page, blockId, 0, 1, binding); // del 'a'
    const edit = getInlineMathSpans(newPage.blocks[0])[0];
    const render = renderMathRun(newPage.blocks[0]);
    expect(edit.latex).toBe("b");
    expect(render).not.toBeNull();
    expect(render!.text).toBe(edit.latex);
    expect(render!.start).toBe(edit.startIndex);
    expect(render!.end).toBe(edit.endIndex);
  });
});
