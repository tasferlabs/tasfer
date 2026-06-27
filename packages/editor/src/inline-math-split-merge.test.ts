/**
 * End-to-end split/merge for inline-math chips, driven through the real action
 * pipeline (insertText → TEXT_INPUTTED, and the DELETE_* actions → CONTENT_DELETED)
 * rather than the raw CRDT helpers — so it exercises the observers MathNode wires
 * in `registerActions`, exactly as a keystroke would at runtime.
 */
import { deleteText, insertText } from "./actions/actions";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  SPLIT_BLOCK,
} from "./actions/edit-actions";
import { getInlineMathSpans } from "./inline-math-spans";
import { moveCursorToPosition } from "./selection";
import type { CursorState, EditorState } from "./state-types";
import { createInitialState } from "./state-utils";
import { insertCharsAtPosition, markCharsInRange } from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

/** A live editor state whose single paragraph holds one inline-math chip `latex`. */
function editorWithChip(latex: string, caret: number) {
  const binding = createCRDTbinding("split-merge", "peer-1");
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

  const s0 = createInitialState(page, { crdtBinding: binding });
  const cursor: CursorState = {
    position: { blockIndex: 0, textIndex: caret },
    lastUpdate: 0,
  };
  return { ...s0, document: { ...s0.document, cursor } } as EditorState;
}

function spans(s: EditorState) {
  return getInlineMathSpans(s.document.page.blocks[0]).map((sp) => sp.latex);
}

describe("inline-math split/merge through the action pipeline", () => {
  it("typing a space inside a chip splits it into two rendered chips", () => {
    // caret between the two atoms of "ab"
    const { state } = insertText(editorWithChip("ab", 1), " ");
    expect(spans(state)).toEqual(["a", "b"]);
  });

  it("Backspacing the separator merges the two chips back into one", () => {
    const split = insertText(editorWithChip("ab", 1), " ").state;
    expect(spans(split)).toEqual(["a", "b"]);
    // After the split the caret sits just past the space (chip B's left edge).
    const merged = split.actionBus.dispatchState(DELETE_BACKWARD, split);
    expect(spans(merged.state)).toEqual(["ab"]);
  });

  it("forward-Deleting the separator merges too", () => {
    let split = insertText(editorWithChip("ab", 1), " ").state;
    // Put the caret just before the space (chip A's right edge) and Delete.
    split = {
      ...split,
      document: {
        ...split.document,
        cursor: { position: { blockIndex: 0, textIndex: 1 }, lastUpdate: 0 },
      },
    };
    const merged = split.actionBus.dispatchState(DELETE_FORWARD, split);
    expect(spans(merged.state)).toEqual(["ab"]);
  });

  it("a multi-letter command keeps its rendering across split and merge", () => {
    // "\alpha\beta": split right after \alpha, then merge back.
    const split = insertText(editorWithChip("\\alpha\\beta", 6), " ").state;
    expect(spans(split)).toEqual(["\\alpha", "\\beta"]);
    const merged = split.actionBus.dispatchState(DELETE_BACKWARD, split);
    expect(spans(merged.state)).toEqual(["\\alpha\\beta"]);
  });

  it("splitting a chip whose leading char was deleted keeps the mark (no raw source)", () => {
    // Regression: editing a chip can tombstone its anchor char (here, deleting
    // the chip's leading 'a' leaves the span's startCharId a tombstone, which
    // `resolveMarkRuns` still resolves to "bc"). A later split removes the mark
    // over the space — the reducer must resolve the span's surviving chars
    // tolerantly, or it drops the whole mark and the text renders as raw LaTeX.
    let s = editorWithChip("abc", 1);
    s = deleteText(s).state; // delete leading 'a' -> "bc", startCharId tombstoned
    expect(spans(s)).toEqual(["bc"]);
    s = moveCursorToPosition(s, 0, 1); // between b and c
    const split = insertText(s, " ").state;
    expect(spans(split)).toEqual(["b", "c"]); // mark survives the split, not []
  });

  it("Enter splits a chip across blocks, Backspace rejoins it whole (no raw half)", () => {
    // Regression: Enter inside a chip block-splits the paragraph, dividing the
    // "math" mark across the two blocks (first half "ab", second half "cd").
    // Backspace rejoins the blocks; the second half is re-marked over its fresh
    // chars, which must UNION with — not replace — the surviving first-half span.
    // Replacing it stripped the mark from "ab", leaving it to render as raw
    // LaTeX while only "cd" stayed a formula (the reported bug).
    let s = editorWithChip("abcd", 2);
    s = s.actionBus.dispatchState(SPLIT_BLOCK, s).state;
    expect(spans(s)).toEqual(["ab"]); // block 0
    expect(
      getInlineMathSpans(s.document.page.blocks[1]).map((x) => x.latex),
    ).toEqual(["cd"]); // block 1

    s = moveCursorToPosition(s, 1, 0); // caret at start of block 1
    s = s.actionBus.dispatchState(DELETE_BACKWARD, s).state;
    expect(spans(s)).toEqual(["abcd"]); // one whole chip again, not ["cd"]
  });

  it("typing a non-space char at the right edge joins the formula", () => {
    // Caret just past the chip's last char (its right edge). The char lands
    // outside the mark at the CRDT layer, but the edge counts as inside — the
    // observer re-marks the chip to swallow it, extending the same formula.
    const { state } = insertText(editorWithChip("x^2", 3), "z");
    expect(spans(state)).toEqual(["x^2z"]);
    expect(state.document.cursor?.position.textIndex).toBe(4);
  });

  it("typing a non-space char at the left edge joins the formula", () => {
    const { state } = insertText(editorWithChip("x^2", 0), "a");
    expect(spans(state)).toEqual(["ax^2"]);
    // Caret sits after the freshly-joined leading char.
    expect(state.document.cursor?.position.textIndex).toBe(1);
  });

  it("a letter after a trailing command at the right edge keeps a separator (\\oint x)", () => {
    // `\oint` + `x` at the edge must become the valid `\oint x`, never the
    // unknown command `\ointx` — the join inserts the separator before marking.
    const { state } = insertText(editorWithChip("\\oint", 5), "x");
    expect(spans(state)).toEqual(["\\oint x"]);
    expect(state.document.cursor?.position.textIndex).toBe(7);
  });

  it("completing a command at the right edge joins it, then materializes (\\fra + c)", () => {
    // Edge join runs before materialize: `c` joins `\fra` into `\frac`, which
    // then fills its `\frac{}{}` slots, landing the caret in the numerator.
    const { state } = insertText(editorWithChip("\\fra", 4), "c");
    expect(spans(state)).toEqual(["\\frac{}{}"]);
    expect(state.document.cursor?.position.textIndex).toBe(6);
  });

  it("a space at the right edge leaves the chip (does not join)", () => {
    // The space is the "leave the formula" gesture: it stays plain text after
    // the chip, which is unchanged (no join, no split).
    const { state } = insertText(editorWithChip("ab", 2), " ");
    expect(spans(state)).toEqual(["ab"]);
  });

  it("a space at the left edge leaves the chip (stays plain text before it)", () => {
    const { state } = insertText(editorWithChip("ab", 0), " ");
    expect(spans(state)).toEqual(["ab"]);
  });

  it("merging a command into a following letter keeps a separator (\\sin x, not \\sinx)", () => {
    // "\sin x": split right after \sin, then merge back — the merge must reinsert
    // a separator so the result is the valid "\sin x", never the broken "\sinx"
    // (which would render as a red unknown command, i.e. raw source).
    const split = insertText(editorWithChip("\\sinx", 4), " ").state;
    expect(spans(split)).toEqual(["\\sin", "x"]);
    const merged = split.actionBus.dispatchState(DELETE_BACKWARD, split);
    expect(spans(merged.state)).toEqual(["\\sin x"]);
  });
});
