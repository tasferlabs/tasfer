/**
 * End-to-end edge-join and separator-aware deletion for inline-math chips,
 * driven through the real action pipeline (insertText → TEXT_INPUTTED, and the
 * DELETE_* actions → CONTENT_DELETED) rather than the raw CRDT helpers — so it
 * exercises the observers MathNode wires in `registerActions`, exactly as a
 * keystroke would at runtime. The space-split and its rejoin are tree-owned
 * now; their pipeline coverage lives in `math/space-input.test.ts`.
 */
import {
  createMathTestState,
  createMathTestSyncEngine,
} from "./__testutils__/math";
import { insertText } from "./actions/actions";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  SPLIT_BLOCK,
} from "./actions/edit-actions";
import { getInlineMathSpans } from "./inline-math-spans";
import { moveCursorToPosition } from "./selection";
import type { CursorState, EditorState } from "./state-types";
import { insertCharsAtPosition, markCharsInRange } from "./sync/crdt-utils";
import { createCRDTbinding } from "./sync/sync";
import { describe, expect, it } from "vitest";

/** A live editor state whose single paragraph holds one inline-math chip `latex`. */
function editorWithChip(latex: string, caret: number) {
  const binding = createCRDTbinding("split-merge", "peer-1");
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

  const s0 = createMathTestState(page, { crdtBinding: binding });
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
  it("forward-Deleting a plain inter-atom space merges its atoms (a b → ab)", () => {
    // The forward counterpart of the Backspace case below: an ordinary space
    // between atoms carries no meaning, so Delete takes just the space.
    const s = editorWithChip("a b", 1);
    const merged = s.actionBus.dispatchState(DELETE_FORWARD, s);
    expect(spans(merged.state)).toEqual(["ab"]);
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

  it("a dot at the right edge stays prose, but a digit after it absorbs both (3.14)", () => {
    // The dot is ambiguous when typed — sentence period vs. decimal point — so
    // it lands outside the chip; the digit one keystroke later resolves it as
    // numeric and the observer re-marks the chip to swallow dot and digit. From
    // there the caret is back at the edge, so further digits join normally.
    let s = insertText(editorWithChip("3", 1), ".").state;
    expect(spans(s)).toEqual(["3"]); // dot ejected as prose for now
    s = insertText(s, "1").state;
    expect(spans(s)).toEqual(["3.1"]); // digit pulled the dot back in
    s = insertText(s, "4").state;
    expect(spans(s)).toEqual(["3.14"]);
    expect(s.document.cursor?.position.textIndex).toBe(4);
  });

  it("a comma before a digit absorbs the same way (1,000)", () => {
    let s = insertText(editorWithChip("1", 1), ",").state;
    expect(spans(s)).toEqual(["1"]);
    for (const d of ["0", "0", "0"]) s = insertText(s, d).state;
    expect(spans(s)).toEqual(["1,000"]);
  });

  it("a dot followed by a non-digit keeps the sentence reading ($x^2$. a)", () => {
    let s = insertText(editorWithChip("x^2", 3), ".").state;
    s = insertText(s, " ").state;
    s = insertText(s, "a").state;
    expect(spans(s)).toEqual(["x^2"]); // ". a" stays plain prose after the chip
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

  it("Backspacing before a letter across a command separator deletes the whole command (\\degree C, not \\degreeC)", () => {
    // Regression: the separator space in `\degree C` is absorbed into the command
    // token, so the position before `C` (offset 8) has no editing unit of its own.
    // A Backspace there used to fall back to deleting the raw separator, welding
    // the control word onto `C` into the unknown `\degreeC`. Now the command is
    // deleted together with its separator, leaving a valid chip. This is what made
    // the bug appear only where the soft keyboard parked the caret past the
    // separator (iOS) rather than on it (Android).
    const s = editorWithChip("\\degree C", 8);
    const after = s.actionBus.dispatchState(DELETE_BACKWARD, s);
    expect(spans(after.state)).toEqual(["C"]);
  });

  it("forward-Deleting before a command separator deletes the separator and the following atom (\\degree C → \\degree)", () => {
    // Forward counterpart: Delete sitting just after `\degree` (offset 7, before
    // the separator) must not strand the separator and fuse — it takes the space
    // together with `C`, leaving the command intact.
    const s = editorWithChip("\\degree C", 7);
    const after = s.actionBus.dispatchState(DELETE_FORWARD, s);
    expect(spans(after.state)).toEqual(["\\degree"]);
  });

  it("a plain inter-atom space still merges harmlessly on Backspace (a b → ab)", () => {
    // The separator-aware delete must only fire for a load-bearing command
    // separator: an ordinary space between atoms carries no meaning, so deleting
    // just it (merging the atoms) stays the correct, expected behavior.
    const s = editorWithChip("a b", 2);
    const after = s.actionBus.dispatchState(DELETE_BACKWARD, s);
    expect(spans(after.state)).toEqual(["ab"]);
  });
});
