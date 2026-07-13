/**
 * Double-click word selection at inline-math chip BOUNDARIES.
 *
 * A chip's visible chars are its raw LaTeX, so the offset word-select must
 * treat the whole run as the word it visually is: an offset resting on a chip
 * edge (where no prose word sits) selects the chip whole, a word beside a chip
 * never drags chip source into the selection, and an offset just past a word
 * (a double-click past the line end, or in the side padding mapped to the line
 * edge) selects the word that ended there — matching native text fields.
 */
import {
  createMathTestState,
  createMathTestSyncEngine,
  loadMathPage,
} from "../__testutils__/math";
import { insertCharsAtPosition, markCharsInRange } from "../sync/crdt-utils";
import { createCRDTbinding } from "../sync/sync";
import { selectWordAtPosition } from "./actions";
import { describe, expect, it } from "vitest";

/**
 * A paragraph reading `prefix` + chip `latex` + `suffix`, with the chip's chars
 * marked directly so word chars can sit flush against the chip edges (markdown
 * would not tokenize `ab$x+y$` reliably).
 */
function chipPage(prefix: string, latex: string, suffix: string) {
  const binding = createCRDTbinding("word-select-boundary", "peer-1");
  const engine = createMathTestSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;

  let page = insertCharsAtPosition(
    engine.getState(),
    blockId,
    0,
    `${prefix}${latex}${suffix}`,
    binding,
  ).newPage;
  page = markCharsInRange(
    page,
    blockId,
    prefix.length,
    prefix.length + latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  return {
    state: createMathTestState(page, { crdtBinding: binding }),
    chipStart: prefix.length,
    chipEnd: prefix.length + latex.length,
  };
}

function selectAt(state: ReturnType<typeof chipPage>["state"], index: number) {
  return selectWordAtPosition(state, { blockIndex: 0, textIndex: index })
    .document.selection;
}

describe("selectWordAtPosition at chip boundaries", () => {
  it("an offset on the chip's trailing edge at the line end selects the chip whole", () => {
    const { state, chipStart, chipEnd } = chipPage("AB ", "x+y", "");
    const sel = selectAt(state, chipEnd);
    expect(sel?.anchor.textIndex).toBe(chipStart);
    expect(sel?.focus.textIndex).toBe(chipEnd);
  });

  it("an offset on the chip's leading edge selects the chip whole", () => {
    const { state, chipStart, chipEnd } = chipPage("", "x+y", " AB");
    const sel = selectAt(state, chipStart);
    expect(sel?.anchor.textIndex).toBe(chipStart);
    expect(sel?.focus.textIndex).toBe(chipEnd);
  });

  it("a word flush against the chip's trailing edge selects without chip source", () => {
    // "AB" + `x+y` + "CD": the chip's `y` and the C are adjacent word chars —
    // the prose scan must stop at the run edge, not run into the LaTeX.
    const { state, chipEnd } = chipPage("AB", "x+y", "CD");
    const sel = selectAt(state, chipEnd + 1);
    expect(sel?.anchor.textIndex).toBe(chipEnd);
    expect(sel?.focus.textIndex).toBe(chipEnd + 2);
  });

  it("a word flush against the chip's leading edge selects without chip source", () => {
    const { state, chipStart } = chipPage("AB", "x+y", "");
    const sel = selectAt(state, 0);
    expect(sel?.anchor.textIndex).toBe(0);
    expect(sel?.focus.textIndex).toBe(chipStart);
  });

  it("a boundary offset between chip and word still prefers the adjacent word", () => {
    // Existing rule: the char AT the offset wins when it is prose.
    const { state, chipEnd } = chipPage("", "x+y", "CD");
    const sel = selectAt(state, chipEnd);
    expect(sel?.anchor.textIndex).toBe(chipEnd);
    expect(sel?.focus.textIndex).toBe(chipEnd + 2);
  });

  it("an offset past the end of a plain line selects the word that ended there", () => {
    const page = loadMathPage("hello world");
    const state = createMathTestState(page);
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: "hello world".length,
    }).document.selection;
    expect(sel?.anchor.textIndex).toBe("hello ".length);
    expect(sel?.focus.textIndex).toBe("hello world".length);
  });

  it("an offset with no word at or before it still selects nothing", () => {
    const page = loadMathPage("a . b");
    const state = createMathTestState(page);
    // On the `.` with a space before it: no word ends or starts here.
    const sel = selectWordAtPosition(state, {
      blockIndex: 0,
      textIndex: 2,
    }).document.selection;
    expect(sel == null || sel.isCollapsed).toBe(true);
  });
});
