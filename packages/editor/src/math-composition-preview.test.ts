/**
 * IME composition in math source.
 *
 * Composition is SUPPORTED in math and shows a LIVE preview: the composing string
 * is folded into the render through the SAME node/mark transform the commit uses
 * (`transformTypedInput`). In math that wraps text the math fonts can't render
 * (CJK, kana, …) into a `\text{…}` run — which the host font typesets — so the
 * injected preview parses and the formula stays typeset instead of flashing to
 * raw source, and it matches exactly what compositionend commits. Plain prose
 * folds the raw text in at the caret, unchanged.
 */
import { startComposition } from "./composition";
import {
  handleCompositionEnd,
  handleCompositionStart,
} from "./events/compositionEvents";
import {
  getInlineMathSpans,
  resolveMarkRunsFromChars,
} from "./inline-math-spans";
import { getContentWithComposition } from "./nodes/TextNode";
import { moveCursorToPosition } from "./selection";
import type { Page } from "./serlization/loadPage";
import type { EditorState, ViewportState } from "./state-types";
import { createInitialState } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "./sync/crdt-utils";
import {
  type CRDTbinding as CRDTbindingType,
  createCRDTbinding,
  createSyncEngine,
} from "./sync/sync";
import { describe, expect, it } from "vitest";

const VIEWPORT = { scrollY: 0, height: 800, width: 600 } as ViewportState;

function compositionEvent(data: string): CompositionEvent {
  return { data } as CompositionEvent;
}

/** A focused edit-mode state with the caret at `(blockIndex, textIndex)`. */
function focusedAt(
  page: Page,
  binding: CRDTbindingType,
  blockIndex: number,
  textIndex: number,
): EditorState {
  let state = createInitialState(page, { crdtBinding: binding });
  state = { ...state, view: { ...state.view, isFocused: true } };
  state = moveCursorToPosition(state, blockIndex, textIndex);
  return state;
}

/** Put the caret at `textIndex` and arm an active composition of `text`. */
function composingAt(
  page: Page,
  binding: CRDTbindingType,
  textIndex: number,
  text: string,
): EditorState {
  const state = focusedAt(page, binding, 0, textIndex);
  return startComposition(state, text, { blockIndex: 0, textIndex });
}

function mathBlock(latex: string) {
  const binding = createCRDTbinding("math-preview", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "math", { displayMode: true });
  engine.emit([blockOp]);
  const page = insertCharsAtPosition(
    engine.getState(),
    blockOp.blockId,
    0,
    latex,
    binding,
  ).newPage;
  return { page, binding };
}

/** Paragraph: inline-math chip `latex` at `[0, latex.length]`, then `trailing`. */
function inlineChip(latex: string, trailing = "") {
  const binding = createCRDTbinding("math-preview", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;
  let page = insertCharsAtPosition(
    engine.getState(),
    blockId,
    0,
    latex + trailing,
    binding,
  ).newPage;
  page = markCharsInRange(
    page,
    blockId,
    0,
    latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  return { page, binding };
}

function latexOf(state: EditorState, blockIndex = 0): string {
  return getVisibleTextFromRuns(
    state.document.page.blocks[blockIndex].charRuns,
  );
}

describe("IME composition preview in math is wrapped, not withheld", () => {
  it("folds a CJK preview into a block equation as a \\text run (stays typeset)", () => {
    const { page, binding } = mathBlock("x+y");
    const state = composingAt(page, binding, 2, "あ"); // caret in "x+|y"

    const content = getContentWithComposition(
      state.document.page.blocks[0],
      state,
      0,
    );
    // Injected WRAPPED, so the equation's LaTeX parses (あ renders via the host
    // font) instead of de-typesetting to raw source.
    expect(content.compositionRange).not.toBeNull();
    expect(content.chars.map((c) => c.char).join("")).toBe("x+\\text{あ}y");
  });

  it("fills an empty script slot the caret sits just past (`x^{}|` → inside)", () => {
    // "x^{}" has a caret stop at 4 — one past the empty superscript's `}`, sitting
    // visually almost on the tiny empty box. Composing there must land INSIDE the
    // script, not on the baseline beside it (`x^{}あ`) where the box is stranded.
    const { page, binding } = mathBlock("x^{}");
    const state = composingAt(page, binding, 4, "あ");

    const content = getContentWithComposition(
      state.document.page.blocks[0],
      state,
      0,
    );
    expect(content.chars.map((c) => c.char).join("")).toBe("x^{\\text{あ}}");
  });

  it("folds a CJK preview into an inline chip as a \\text run", () => {
    const { page, binding } = inlineChip("ab"); // chip "ab" at [0,2]
    const state = composingAt(page, binding, 1, "あ"); // strictly inside

    const content = getContentWithComposition(
      state.document.page.blocks[0],
      state,
      0,
    );
    // The wrapped preview lands inside the chip, so its resolved LaTeX carries it
    // and still typesets — no raw source leaks.
    const runs = resolveMarkRunsFromChars(
      content.chars,
      content.formats,
    ).filter((r) => r.name === "math");
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("a\\text{あ}b");
  });

  it("folds a raw preview inline in plain prose (unchanged)", () => {
    const binding = createCRDTbinding("math-preview", "peer-1");
    const engine = createSyncEngine(binding);
    const blockOp = engine.createBlockInsert(null, "paragraph", {});
    engine.emit([blockOp]);
    const page = insertCharsAtPosition(
      engine.getState(),
      blockOp.blockId,
      0,
      "hi",
      binding,
    ).newPage;
    const state = composingAt(page, binding, 2, "あ");

    const content = getContentWithComposition(
      state.document.page.blocks[0],
      state,
      0,
    );
    expect(content.compositionRange).not.toBeNull();
    expect(content.chars.map((c) => c.char).join("")).toBe("hiあ");
  });
});

describe("IME composition still commits into math", () => {
  it("commits the composed text into a block equation (mark/type preserved)", () => {
    const { page, binding } = mathBlock("x+y");
    let state = focusedAt(page, binding, 0, 3); // caret at the end
    state = handleCompositionStart(state, compositionEvent("z")).state;
    expect(state.ui.composition?.isComposing).toBe(true);

    const { state: after } = handleCompositionEnd(
      state,
      compositionEvent("z"),
      VIEWPORT,
    );
    // Composed text landed, the block is still a math block (renders typeset).
    expect(after.ui.composition).toBeNull();
    expect(after.document.page.blocks[0].type).toBe("math");
    expect(latexOf(after)).toContain("z");
  });

  it("commits the composed text inside an inline chip, keeping the math mark", () => {
    const { page, binding } = inlineChip("\\alpha");
    let state = focusedAt(page, binding, 0, 3); // strictly inside the chip
    state = handleCompositionStart(state, compositionEvent("z")).state;

    const { state: after } = handleCompositionEnd(
      state,
      compositionEvent("z"),
      VIEWPORT,
    );
    expect(after.ui.composition).toBeNull();
    // The chip absorbed the char and stays a single math span — the mark was not
    // stripped, so no raw source leaks (the reader still sees a typeset chip).
    const spans = getInlineMathSpans(after.document.page.blocks[0]);
    expect(spans).toHaveLength(1);
    expect(spans[0].latex).toContain("z");
  });
});

describe("IME preview keeps a chip typeset when a boundary char is tombstoned", () => {
  // Regression: a chip that has been edited carries a tombstoned endpoint char
  // (deleting its trailing char leaves `endCharId` pointing at a tombstone). The
  // preview render used to build its char array from VISIBLE chars only, so
  // `resolveMarkRunsFromChars` couldn't find the tombstoned endpoint and dropped
  // the whole span — the chip flashed to raw LaTeX for the whole composition,
  // even with the caret on the chip's outer edge (preview lands OUTSIDE the chip).
  function chipWithTombstonedEnd() {
    const binding = createCRDTbinding("math-preview", "peer-1");
    const engine = createSyncEngine(binding);
    const blockOp = engine.createBlockInsert(null, "paragraph", {});
    engine.emit([blockOp]);
    const blockId = blockOp.blockId;
    // Mark all of "\alphaX" as math, then delete the trailing "X": the span's
    // endCharId now anchors to a tombstone while the chip resolves to "\alpha".
    let page = insertCharsAtPosition(
      engine.getState(),
      blockId,
      0,
      "\\alphaX",
      binding,
    ).newPage;
    page = markCharsInRange(
      page,
      blockId,
      0,
      "\\alphaX".length,
      { type: "math" },
      true,
      binding,
    ).newPage;
    page = deleteCharsInRange(
      page,
      blockId,
      "\\alpha".length,
      "\\alphaX".length,
      binding,
    ).newPage;
    return { page, binding };
  }

  it("resolves the chip as a replacement run at the right edge mid-compose", () => {
    const { page, binding } = chipWithTombstonedEnd();
    // Sanity: the chip resolves to "\alpha" and its endpoint is a tombstone.
    expect(getInlineMathSpans(page.blocks[0])).toEqual([
      { startIndex: 0, endIndex: 6, latex: "\\alpha" },
    ]);

    // Caret on the chip's RIGHT edge (index 6, just past "\alpha"), composing.
    const state = composingAt(page, binding, 6, "s");
    const content = getContentWithComposition(
      state.document.page.blocks[0],
      state,
      0,
    );

    // The chip must still resolve as a math run (typeset), NOT collapse to raw
    // source. The composed "s" folds in OUTSIDE the chip.
    const runs = resolveMarkRunsFromChars(
      content.chars,
      content.formats,
    ).filter((r) => r.name === "math");
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("\\alpha");
    expect(runs[0].startIndex).toBe(0);
    expect(runs[0].endIndex).toBe(6);
    expect(
      content.chars
        .filter((c) => !c.deleted)
        .map((c) => c.char)
        .join(""),
    ).toBe("\\alphas");
  });
});
