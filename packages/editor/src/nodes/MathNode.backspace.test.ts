/**
 * Backspace around a structured display equation.
 *
 * A math block's flat char runs are EMPTY — its content is the block-authority
 * MathDocument — so every editing gesture flows through the tree: Backspace at
 * the equation's leading edge demotes the block to a paragraph holding one
 * inline chip (the tree is reused losslessly as the chip's supplemental
 * attachment), deletes inside the equation resolve against tree units (a
 * command and its separator die together), and Backspace from the following
 * prose selects the whole block as a node selection before deleting it.
 */
import { DELETE_BACKWARD, DELETE_FORWARD } from "../actions/edit-actions";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "../feature-facets";
import { resolveStructuredInlineMathRuns } from "../math/inline-structured";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  mathContentIdForBlock,
} from "../math/structured";
import { mathContentSelectionFromSourceOffset } from "../math/tree-selection";
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import {
  getSelectionHandlePositions,
  isNodeSelection,
  moveCursorToPosition,
} from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { updateContentSelection } from "../structured-selection";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import { createCRDTbinding } from "../sync/sync";
import type { TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

function stateFor(markdown: string, peer: string): EditorState {
  return createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding("page", peer),
  });
}

/** Nested caret at `sourceOffset` inside the display equation at `blockIndex`. */
function treeCaretAt(
  state: EditorState,
  blockIndex: number,
  sourceOffset: number,
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  const document = getMathStructuredDocument(block);
  if (!document) throw new Error("expected a structured math block");
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    mathContentIdForBlock(block.id),
    document,
    sourceOffset,
  );
  if (!selection) throw new Error("expected a tree caret");
  return updateContentSelection(state, selection);
}

function blockSource(state: EditorState, blockIndex: number) {
  return getStructuredMathSource(state.document.page.blocks[blockIndex]);
}

describe("backspace at the start of a math block", () => {
  it("demotes the same block to a paragraph holding one inline chip", () => {
    let state = stateFor("Euler:\n\n$$\nE=mc^2\n$$", "demote");
    const mathIndex = state.document.page.blocks.findIndex(
      (block) => (block.type as string) === "math",
    );
    expect(mathIndex).toBeGreaterThan(0);
    state = treeCaretAt(state, mathIndex, 0);

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    expect(result.claimed).toBe(true);
    const converted = result.state.document.page.blocks[mathIndex];

    // The preceding prose is untouched — the block CONVERTS in place rather
    // than joining into its neighbour.
    expect(
      getVisibleTextFromRuns(
        (result.state.document.page.blocks[0] as TextualBlock).charRuns,
      ),
    ).toBe("Euler:");
    expect(converted.type).toBe("paragraph");
    // The paragraph's flat text is exactly one anchor char…
    expect(getVisibleTextFromRuns((converted as TextualBlock).charRuns)).toBe(
      STRUCTURED_MARK_ANCHOR_CHAR,
    );
    // …whose mark carries the equation's tree, losslessly (canonical print).
    expect(
      resolveStructuredInlineMathRuns(converted as TextualBlock),
    ).toMatchObject([{ startIndex: 0, endIndex: 1, latex: "E=m{c}^{2}" }]);
    // Backspace demotes at the leading edge, so the caret stays before the chip.
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: mathIndex,
      textIndex: 0,
    });
    expect(result.state.document.contentSelection).toBeNull();
  });

  it("also demotes a math block when it is the first block", () => {
    let state = stateFor("$$\nx^2\n$$", "demote-first");
    state = treeCaretAt(state, 0, 0);

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const visibleBlocks = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    expect(visibleBlocks).toHaveLength(1);
    expect(visibleBlocks[0].type).toBe("paragraph");
    expect(
      resolveStructuredInlineMathRuns(visibleBlocks[0] as TextualBlock)[0]
        ?.latex,
    ).toBe("{x}^{2}");
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });

  it("does not demote from a caret in the equation's interior", () => {
    let state = stateFor("$$\nx+y\n$$", "demote-interior");
    state = treeCaretAt(state, 0, 2); // after the `+`

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    // Interior Backspace is a tree edit, not a structural conversion.
    expect(result.state.document.page.blocks[0].type).toBe("math");
    expect(blockSource(result.state, 0)).toBe("xy");
  });

  it("undo restores the math block and its authority document", () => {
    let state = stateFor("$$\nx^2\n$$", "demote-undo");
    state = treeCaretAt(state, 0, 0);

    const converted = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    expect(converted.state.document.page.blocks[0].type).toBe("paragraph");
    const recorded = recordUndoOps(
      state,
      converted.state,
      converted.ops,
      state.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    const block = undone.document.page.blocks[0];

    expect(block.type).toBe("math");
    // The block-authority tree is back, and no stray chip chars survive.
    expect(getStructuredMathSource(block)).toBe("{x}^{2}");
    expect(
      "charRuns" in block ? getVisibleTextFromRuns(block.charRuns) : null,
    ).toBe("");

    const redone = redoState(undone).state;
    expect(redone.document.page.blocks[0].type).toBe("paragraph");
    expect(
      resolveStructuredInlineMathRuns(
        redone.document.page.blocks[0] as TextualBlock,
      )[0]?.latex,
    ).toBe("{x}^{2}");
  });
});

describe("deleting across a command separator in a math block", () => {
  // The separator space in `\degree C` is absorbed into the command token, so
  // the position before `C` carries no standalone editing unit. Deleting only
  // the raw space would fuse the control word onto `C` into the unknown
  // `\degreeC`; the command must be deleted together with its separator.
  it("Backspace before the letter removes the whole command (\\degree C → C)", () => {
    let state = stateFor("$$\n\\degree C\n$$", "sep-backspace");
    expect(blockSource(state, 0)).toBe("\\degree C");
    state = treeCaretAt(state, 0, "\\degree C".indexOf("C"));

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    expect(blockSource(result.state, 0)).toBe("C");
  });

  it("forward-Delete after the command removes the separator and the atom (\\degree C → \\degree)", () => {
    let state = stateFor("$$\n\\degree C\n$$", "sep-forward");
    state = treeCaretAt(state, 0, "\\degree".length);

    const result = state.actionBus.dispatchState(DELETE_FORWARD, state);
    expect(blockSource(result.state, 0)).toBe("\\degree");
  });
});

describe("backspace from following text into a math block", () => {
  const following = (peer: string) => {
    // No blank line, so the paragraph directly follows the equation.
    const state = stateFor("$$\nx^2\n$$\nafter", peer);
    expect(state.document.page.blocks.map((block) => block.type)).toEqual([
      "math",
      "paragraph",
    ]);
    return moveCursorToPosition(state, 1, 0);
  };

  it("selects the math block first, then deletes it on the next Backspace", () => {
    const state = following("select-then-delete");
    const selected = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    // First press: pure selection, no mutation.
    expect(selected.ops).toHaveLength(0);
    expect(selected.state.document.page.blocks[0].type).toBe("math");
    expect(selected.state.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 0 },
      isCollapsed: false,
    });

    const deleted = selected.state.actionBus.dispatchState(
      DELETE_BACKWARD,
      selected.state,
    );

    expect(deleted.ops.map((op) => op.op)).toContain("block_delete");
    expect(deleted.state.document.page.blocks[0].deleted).toBe(true);
    expect(
      deleted.state.document.page.blocks
        .filter((block) => !block.deleted)
        .map((block) => block.type),
    ).toEqual(["paragraph"]);
  });

  it("renders the selected math block as a node selection, not text handles", () => {
    // The node-selection sentinel (anchor === focus, isCollapsed: false) is a
    // whole-block selection, not a zero-width text range. The mobile selection
    // handles would otherwise both resolve to the math's start edge — two
    // teardrops stacked into a stray caret-like bar. They must be suppressed so
    // the block paints its own selected state instead.
    const state = following("node-selection-handles");
    const selected = state.actionBus.dispatchState(
      DELETE_BACKWARD,
      state,
    ).state;

    expect(isNodeSelection(selected.document.selection)).toBe(true);

    const viewport: ViewportState = {
      width: 800,
      height: 2000,
      scrollY: 0,
      documentHeight: 2000,
    };
    expect(getSelectionHandlePositions(selected, viewport)).toBeNull();
  });
});

describe("isNodeSelection", () => {
  const at = (blockIndex: number, textIndex: number) => ({
    blockIndex,
    textIndex,
  });

  it("is true only for a non-collapsed selection pinned to one position", () => {
    expect(
      isNodeSelection({
        anchor: at(0, 0),
        focus: at(0, 0),
        isForward: true,
        isCollapsed: false,
      }),
    ).toBe(true);
  });

  it("is false for a real text range and for a collapsed caret", () => {
    expect(
      isNodeSelection({
        anchor: at(0, 0),
        focus: at(0, 3),
        isForward: true,
        isCollapsed: false,
      }),
    ).toBe(false);
    expect(
      isNodeSelection({
        anchor: at(0, 2),
        focus: at(0, 2),
        isForward: true,
        isCollapsed: true,
      }),
    ).toBe(false);
    expect(isNodeSelection(null)).toBe(false);
  });
});
