/**
 * A lone typed space is never math content. In a structured display equation
 * it is swallowed (math mode collapses whitespace, so persisting it would only
 * create dead source), while still completing a pending `\command` and leaving
 * `\`+space as the atomic control space. In an inline chip a top-level space
 * is the "leave the formula" gesture: it splits the chip into two independent
 * chips around a plain host space, or ejects one plain space at an edge.
 * Enter is the block-level sibling of that gesture — it divides the chip
 * across a block boundary — and Backspace at either seam rejoins the chips
 * into one formula.
 */
import { insertText } from "../actions/actions";
import { DELETE_BACKWARD, SPLIT_BLOCK } from "../actions/edit-actions";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { mathExtension } from "../math-extension";
import type { TextualBlock } from "../nodes/TextNode";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { updateContentSelection } from "../structured-selection";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { createCRDTbinding } from "../sync/sync";
import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { enterInlineMathTreeAtPosition } from "./inline-tree-state";
import { getStructuredMathSource } from "./structured";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());

/** One flat anchor char per chip — shorthand for readable flat-text asserts. */
const A = STRUCTURED_MARK_ANCHOR_CHAR;

function treeState(markdown: string): EditorState {
  return createInitialState(loadPage(markdown, treeMathSchema.data), {
    schema: treeMathSchema.data,
    nodes: createNodeRegistry(treeMathSchema.nodes),
    marks: createMarkRegistry(treeMathSchema.marks),
    crdtBinding: createCRDTbinding("default-page", "space-input-test"),
  });
}

function backspace(state: EditorState): EditorState {
  return state.actionBus.dispatchState(DELETE_BACKWARD, state, undefined).state;
}

function enter(state: EditorState): EditorState {
  return state.actionBus.dispatchState(SPLIT_BLOCK, state, undefined).state;
}

function typeText(state: EditorState, text: string): EditorState {
  if (!state.document.cursor && !state.document.contentSelection) {
    state = moveCursorToPosition(state, 0, 0);
  }
  for (const char of text) {
    state = insertText(state, char).state;
  }
  return state;
}

function blockText(state: EditorState, blockIndex = 0): string {
  const block = state.document.page.blocks[blockIndex] as TextualBlock;
  return getVisibleTextFromRuns(block.charRuns);
}

function inlineRuns(state: EditorState, blockIndex = 0) {
  return resolveStructuredInlineMathRuns(
    state.document.page.blocks[blockIndex] as TextualBlock,
  );
}

/**
 * A chip's interior has no flat positions — the anchor char is atomic — so a
 * mid-formula caret is a nested content selection at a canonical source offset.
 */
function caretAtSourceOffset(
  state: EditorState,
  sourceOffset: number,
  blockIndex = 0,
): EditorState {
  const block = state.document.page.blocks[blockIndex] as TextualBlock;
  const run = inlineRuns(state, blockIndex)[0];
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

describe("space in a structured display equation", () => {
  it("swallows a typed space and keeps typing in place", () => {
    const state = typeText(treeState("$$\n\n$$"), "a b");
    expect(getStructuredMathSource(state.document.page.blocks[0])).toBe("ab");
  });

  it("is a no-op in an empty equation", () => {
    const state = typeText(treeState("$$\n\n$$"), " ");
    expect(getStructuredMathSource(state.document.page.blocks[0])).toBe("");
  });

  it("still completes a pending command without persisting the space", () => {
    const state = typeText(treeState("$$\n\n$$"), "\\alpha x");
    expect(getStructuredMathSource(state.document.page.blocks[0])).toBe(
      "\\alpha x",
    );
  });

  it("keeps the atomic control space", () => {
    const state = typeText(treeState("$$\n\n$$"), "\\ ");
    expect(getStructuredMathSource(state.document.page.blocks[0])).toBe("\\ ");
  });

  it("collapses dead spaces in a multi-character commit, keeping separators", () => {
    // A paste with no command in it cannot carry meaningful spaces — math mode
    // collapses them all — while a command-bearing paste keeps its required
    // separator through the semantic path.
    let plain = treeState("$$\n\n$$");
    plain = moveCursorToPosition(plain, 0, 0);
    plain = insertText(plain, "a").state;
    plain = insertText(plain, "x y").state;
    expect(getStructuredMathSource(plain.document.page.blocks[0])).toBe("axy");

    let command = treeState("$$\n\n$$");
    command = moveCursorToPosition(command, 0, 0);
    command = insertText(command, "a").state;
    command = insertText(command, "\\sin x").state;
    expect(getStructuredMathSource(command.document.page.blocks[0])).toBe(
      "a\\sin x",
    );

    let blank = treeState("$$\n\n$$");
    blank = moveCursorToPosition(blank, 0, 0);
    blank = insertText(blank, "a").state;
    blank = insertText(blank, "  ").state;
    expect(getStructuredMathSource(blank.document.page.blocks[0])).toBe("a");
  });

  it("parses away dead spaces at load, keeping command separators", () => {
    // Imported LaTeX may carry spaces that mean nothing in math mode. The
    // eager parse at load drops them, while a control word keeps the
    // separator it needs before a following letter.
    expect(
      getStructuredMathSource(treeState("$$\na b\n$$").document.page.blocks[0]),
    ).toBe("ab");
    expect(
      getStructuredMathSource(
        treeState("$$\n\\sin x\n$$").document.page.blocks[0],
      ),
    ).toBe("\\sin x");
  });
});

describe("space in an inline math chip", () => {
  it("splits the chip in two around a plain host space", () => {
    let state = treeState("hello $xy$ world");
    const run = inlineRuns(state)[0];
    state = caretAtSourceOffset(state, 1); // x|y
    state = insertText(state, " ").state;

    expect(blockText(state)).toBe(`hello ${A} ${A} world`);
    const runs = inlineRuns(state);
    expect(runs.map((entry) => entry.latex)).toEqual(["x", "y"]);
    expect(runs.every((entry) => entry.document)).toBe(true);
    // The caret lands after the separating space, ready for prose.
    expect(state.document.contentSelection).toBeNull();
    expect(state.document.cursor?.position.textIndex).toBe(run.startIndex + 2);
  });

  it("keeps whole constructs on one side of the split", () => {
    let state = treeState("$\\frac{a}{b}y$");
    // The construct occupies one caret stop; the split point is right after it.
    state = caretAtSourceOffset(state, "\\frac{a}{b}".length);
    state = insertText(state, " ").state;

    const runs = inlineRuns(state);
    expect(runs.map((entry) => entry.latex)).toEqual(["\\frac{a}{b}", "y"]);
  });

  it("swallows a space typed inside a construct slot", () => {
    let state = treeState("$\\frac{ab}{c}$");
    const textBefore = blockText(state);
    // `\frac{a|b}{c}` — strictly inside the numerator.
    state = caretAtSourceOffset(state, "\\frac{a".length);
    state = insertText(state, " ").state;

    const runs = inlineRuns(state);
    expect(runs).toHaveLength(1);
    expect(runs[0].latex).toBe("\\frac{ab}{c}");
    expect(blockText(state)).toBe(textBefore);
  });

  it("ejects a plain space at the chip's trailing edge", () => {
    let state = treeState("$xy$");
    const run = inlineRuns(state)[0];
    const entered = enterInlineMathTreeAtPosition(state, 0, run.endIndex, {
      allowBoundary: true,
    });
    expect(entered).toBeDefined();
    state = insertText(entered!.state, " ").state;

    expect(blockText(state)).toBe(`${A} `);
    const runs = inlineRuns(state);
    expect(runs.map((entry) => entry.latex)).toEqual(["xy"]);
    expect(state.document.contentSelection).toBeNull();
    expect(state.document.cursor?.position.textIndex).toBe(run.endIndex + 1);
  });

  it("ejects a plain space at the chip's leading edge", () => {
    let state = treeState("$xy$");
    const run = inlineRuns(state)[0];
    const entered = enterInlineMathTreeAtPosition(state, 0, run.startIndex, {
      allowBoundary: true,
    });
    expect(entered).toBeDefined();
    state = insertText(entered!.state, " ").state;

    expect(blockText(state)).toBe(` ${A}`);
    expect(inlineRuns(state).map((entry) => entry.latex)).toEqual(["xy"]);
    expect(state.document.cursor?.position.textIndex).toBe(run.startIndex + 1);
  });

  it("keeps the atomic control space inside a chip", () => {
    let state = treeState("$xy$");
    state = caretAtSourceOffset(state, 1);
    state = typeText(state, "\\ ");

    const runs = inlineRuns(state);
    expect(runs).toHaveLength(1);
    expect(runs[0].latex).toBe("x\\ y");
  });

  it("collapses a pasted space inside a chip instead of splitting it", () => {
    // A multi-character commit is source, not the space gesture: the chip
    // stays whole and the command-free paste loses its dead space.
    let state = treeState("$xy$");
    state = caretAtSourceOffset(state, 1);
    state = insertText(state, "a b").state;

    const runs = inlineRuns(state);
    expect(runs).toHaveLength(1);
    expect(runs[0].latex).toBe("xaby");
  });
});

describe("Enter divides a chip across a block boundary", () => {
  it("splits an attached chip into two attached chips in two blocks", () => {
    let state = treeState("hello $xy$ world");
    state = caretAtSourceOffset(state, 1);
    state = enter(state);

    expect(blockText(state, 0)).toBe(`hello ${A}`);
    expect(blockText(state, 1)).toBe(`${A} world`);
    const first = inlineRuns(state, 0);
    expect(first.map((entry) => entry.latex)).toEqual(["x"]);
    expect(first[0].document).toBeTruthy();
    const second = inlineRuns(state, 1);
    expect(second.map((entry) => entry.latex)).toEqual(["y"]);
    expect(second[0].document).toBeTruthy();
    // The caret starts block two, right before the second half.
    expect(state.document.cursor?.position).toEqual({
      blockIndex: 1,
      textIndex: 0,
    });
  });

  it("Backspace at the boundary rejoins the halves into one formula", () => {
    let state = treeState("hello $xy$ world");
    state = caretAtSourceOffset(state, 1);
    state = enter(state);
    state = backspace(state);

    expect(blockText(state)).toBe(`hello ${A} world`);
    const runs = inlineRuns(state);
    expect(runs).toHaveLength(1);
    expect(runs[0].latex).toBe("xy");
    expect(runs[0].document).toBeTruthy();
  });

  it("moves a whole attached chip to block two when Enter lands before it", () => {
    // Split one chip in two via the space gesture, then Enter right before the
    // second one: the generic split carries the attached run across the
    // boundary — the moved chip must keep resolving a live document, not
    // degrade over a dangling contentId.
    let state = treeState("ab $xy$ tail");
    state = caretAtSourceOffset(state, 1);
    state = insertText(state, " ").state; // "ab ￼ ￼ tail", chips x / y
    const second = inlineRuns(state)[1];
    expect(second.document).toBeTruthy();
    state = moveCursorToPosition(state, 0, second.startIndex);
    state = enter(state);

    expect(blockText(state, 0)).toBe(`ab ${A} `);
    expect(blockText(state, 1)).toBe(`${A} tail`);
    const moved = inlineRuns(state, 1);
    expect(moved.map((entry) => entry.latex)).toEqual(["y"]);
    expect(moved[0].document).toBeTruthy();
    // Block one keeps its own chip attached, and the moved attachment died
    // with its chars — only the clone on block two survives.
    const kept = inlineRuns(state, 0);
    expect(kept.map((entry) => entry.latex)).toEqual(["x"]);
    expect(kept[0].document).toBeTruthy();
    expect(
      Object.keys(
        (state.document.page.blocks[0] as TextualBlock).structuredContent ?? {},
      ),
    ).toHaveLength(1);
  });

  it("keeps a construct whole: Enter inside a slot splits after the chip", () => {
    let state = treeState("$\\frac{ab}{c}$ tail");
    // `\frac{a|b}{c}` — strictly inside the numerator; the construct cannot
    // be divided, so the split exits past the whole formula and the chip is
    // left untouched (never cut mid-command into `\frac{a` / `b}{c}`).
    state = caretAtSourceOffset(state, "\\frac{a".length);
    state = enter(state);

    expect(blockText(state, 0)).toBe(A);
    const kept = inlineRuns(state, 0);
    expect(kept.map((entry) => entry.latex)).toEqual(["\\frac{ab}{c}"]);
    expect(blockText(state, 1)).toBe(" tail");
    expect(inlineRuns(state, 1)).toHaveLength(0);
  });
});

describe("rejoining chips a delete left touching", () => {
  it("fuses the two halves of a split back into one attached chip", () => {
    let state = treeState("hello $xy$ world");
    state = caretAtSourceOffset(state, 1);
    state = insertText(state, " ").state;
    expect(inlineRuns(state).map((entry) => entry.latex)).toEqual(["x", "y"]);

    // The caret sits right after the separating space; Backspace removes it
    // and the chips fuse back into one formula.
    state = backspace(state);

    expect(blockText(state)).toBe(`hello ${A} world`);
    const runs = inlineRuns(state);
    expect(runs).toHaveLength(1);
    expect(runs[0].latex).toBe("xy");
    expect(runs[0].document).toBeTruthy();
    // The caret promotes to the nested seam so the next keystroke keeps
    // working the merged formula.
    expect(state.document.contentSelection).not.toBeNull();
  });

  it("reinserts the separator a control word needs when fusing", () => {
    let state = treeState("$\\sin$ $x$");
    const runs = inlineRuns(state);
    expect(runs.map((entry) => entry.latex)).toEqual(["\\sin", "x"]);
    state = moveCursorToPosition(state, 0, runs[1].startIndex);
    state = backspace(state);

    const merged = inlineRuns(state);
    expect(merged).toHaveLength(1);
    expect(merged[0].latex).toBe("\\sin x");
    expect(merged[0].document).toBeTruthy();
  });
});
