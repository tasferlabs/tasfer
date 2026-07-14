/**
 * Edge-join and separator-aware deletion for inline-math chips, driven through
 * the real action pipeline (insertText and the DELETE_* actions) exactly as a
 * keystroke would at runtime. A chip is one atomic anchor char in the flat
 * text; typing flush against its edge continues the formula THROUGH THE TREE,
 * while space and sentence punctuation stay prose. The space-split and its
 * rejoin are covered in `math/space-input.test.ts`.
 */
import { insertText } from "./actions/actions";
import { DELETE_BACKWARD, DELETE_FORWARD } from "./actions/edit-actions";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "./feature-facets";
import { resolveStructuredInlineMathRuns } from "./math/inline-structured";
import { mathContentSelectionFromSourceOffset } from "./math/tree-selection";
import { mathExtension } from "./math-extension";
import type { TextualBlock } from "./nodes/TextNode";
import { createMarkRegistry } from "./rendering/marks";
import { createNodeRegistry } from "./rendering/nodes";
import { baseSchema } from "./schema";
import { moveCursorToPosition } from "./selection";
import { loadPage } from "./serlization/loadPage";
import type { EditorState } from "./state-types";
import { createInitialState } from "./state-utils";
import { updateContentSelection } from "./structured-selection";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { createCRDTbinding } from "./sync/sync";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());

/** One flat anchor char per chip — shorthand for readable flat-text asserts. */
const A = STRUCTURED_MARK_ANCHOR_CHAR;

/** A live editor state whose single paragraph holds one inline-math chip. */
function editorWithChip(latex: string, edge: "start" | "end"): EditorState {
  const state = createInitialState(
    loadPage(`$${latex}$`, treeMathSchema.data),
    {
      schema: treeMathSchema.data,
      nodes: createNodeRegistry(treeMathSchema.nodes),
      marks: createMarkRegistry(treeMathSchema.marks),
      crdtBinding: createCRDTbinding("split-merge", "peer-1"),
    },
  );
  const run = runs(state)[0];
  return moveCursorToPosition(
    state,
    0,
    edge === "start" ? run.startIndex : run.endIndex,
  );
}

function runs(state: EditorState) {
  return resolveStructuredInlineMathRuns(
    state.document.page.blocks[0] as TextualBlock,
  );
}

function latexes(state: EditorState): (string | undefined)[] {
  return runs(state).map((run) => run.latex);
}

function blockText(state: EditorState): string {
  const block = state.document.page.blocks[0] as TextualBlock;
  return getVisibleTextFromRuns(block.charRuns);
}

/** Nested caret at a canonical source offset inside the block's only chip. */
function caretAtSourceOffset(
  state: EditorState,
  sourceOffset: number,
): EditorState {
  const block = state.document.page.blocks[0] as TextualBlock;
  const run = runs(state)[0];
  if (!run?.contentId || !run.document) {
    throw new Error("expected an attached inline math run");
  }
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    run.contentId,
    run.document,
    sourceOffset,
  );
  if (!selection) throw new Error("expected a nested math caret");
  return updateContentSelection(state, selection);
}

describe("typing at a chip's flat edges through the action pipeline", () => {
  it("a non-space char at the right edge continues the formula in the tree", () => {
    // The anchor char is atomic: the keystroke lands in the attachment, never
    // in the flat text, and the caret promotes to a nested tree position.
    const { state } = insertText(editorWithChip("x^2", "end"), "z");
    expect(latexes(state)).toEqual(["{x}^{2}z"]);
    expect(blockText(state)).toBe(A);
    expect(state.document.contentSelection).not.toBeNull();
    expect(state.document.cursor).toBeNull();
  });

  it("a non-space char at the left edge continues the formula in the tree", () => {
    const { state } = insertText(editorWithChip("x^2", "start"), "a");
    expect(latexes(state)).toEqual(["a{x}^{2}"]);
    expect(blockText(state)).toBe(A);
    expect(state.document.contentSelection).not.toBeNull();
  });

  it("a letter after a trailing command keeps a separator (\\oint x)", () => {
    // `\oint` + `x` at the edge must become the valid `\oint x`, never the
    // unknown command `\ointx` — the tree insert supplies the separator.
    const { state } = insertText(editorWithChip("\\oint", "end"), "x");
    expect(latexes(state)).toEqual(["\\oint x"]);
  });

  it("completing a typed command at the edge materializes it (\\fra + c)", () => {
    // The whole command is typed keystroke by keystroke at the chip edge; the
    // completing `c` turns the pending `\fra` into `\frac{}{}` with its empty
    // slots materialized, ready to fill through the tree.
    let state = editorWithChip("x", "end");
    for (const char of "\\frac") state = insertText(state, char).state;
    expect(latexes(state)).toEqual(["x\\frac{}{}"]);
    expect(state.document.contentSelection).not.toBeNull();
  });

  it("a dot at the right edge stays prose, but a digit after it absorbs both (3.14)", () => {
    // The dot is ambiguous when typed — sentence period vs. decimal point — so
    // it is ejected as prose; the digit one keystroke later resolves it as
    // numeric and pulls both back into the formula.
    let s = insertText(editorWithChip("3", "end"), ".").state;
    expect(latexes(s)).toEqual(["3"]);
    expect(blockText(s)).toBe(`${A}.`); // dot ejected as prose for now
    s = insertText(s, "1").state;
    expect(latexes(s)).toEqual(["3.1"]); // digit pulled the dot back in
    expect(blockText(s)).toBe(A);
    s = insertText(s, "4").state;
    expect(latexes(s)).toEqual(["3.14"]);
  });

  it("a comma before a digit absorbs the same way (1,000)", () => {
    let s = insertText(editorWithChip("1", "end"), ",").state;
    expect(latexes(s)).toEqual(["1"]);
    for (const d of ["0", "0", "0"]) s = insertText(s, d).state;
    expect(latexes(s)).toEqual(["1,000"]);
  });

  it("a dot followed by a non-digit keeps the sentence reading ($x^2$. a)", () => {
    let s = insertText(editorWithChip("x^2", "end"), ".").state;
    s = insertText(s, " ").state;
    s = insertText(s, "a").state;
    expect(latexes(s)).toEqual(["{x}^{2}"]); // ". a" stays plain prose
    expect(blockText(s)).toBe(`${A}. a`);
  });

  it("a space at the right edge leaves the chip (does not join)", () => {
    // The space is the "leave the formula" gesture: it stays plain text after
    // the chip, which is unchanged (no join, no split).
    const { state } = insertText(editorWithChip("ab", "end"), " ");
    expect(latexes(state)).toEqual(["ab"]);
    expect(blockText(state)).toBe(`${A} `);
  });

  it("a space at the left edge leaves the chip (stays plain text before it)", () => {
    const { state } = insertText(editorWithChip("ab", "start"), " ");
    expect(latexes(state)).toEqual(["ab"]);
    expect(blockText(state)).toBe(` ${A}`);
  });
});

describe("separator-aware deletion inside a chip", () => {
  it("Backspacing before a letter across a command separator deletes the whole command (\\degree C, not \\degreeC)", () => {
    // The separator space in `\degree C` is absorbed into the command token,
    // so the caret stop before `C` has no separate space unit. Backspace there
    // must delete the command together with its separator — welding the
    // control word onto `C` would produce the unknown `\degreeC`.
    let s = caretAtSourceOffset(editorWithChip("\\degree C", "end"), 8);
    s = s.actionBus.dispatchState(DELETE_BACKWARD, s).state;
    expect(latexes(s)).toEqual(["C"]);
  });

  it("forward-Deleting before a command separator takes the separator and the following atom (\\degree C → \\degree)", () => {
    // Forward counterpart: Delete sitting just after `\degree` must not strand
    // the separator and fuse — it takes the space together with `C`.
    let s = caretAtSourceOffset(editorWithChip("\\degree C", "end"), 7);
    s = s.actionBus.dispatchState(DELETE_FORWARD, s).state;
    expect(latexes(s)).toEqual(["\\degree"]);
  });
});
