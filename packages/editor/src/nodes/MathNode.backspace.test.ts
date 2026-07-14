import { createMathTestState } from "../__testutils__/math";
import { DELETE_BACKWARD, DELETE_FORWARD } from "../actions/edit-actions";
import { getInlineMathSpans } from "../inline-math-spans";
import { getSelectionHandlePositions, isNodeSelection } from "../selection";
import type {
  CursorState,
  EditorState,
  Page,
  ViewportState,
} from "../state-types";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import type { MathBlock } from "./MathNode";
import type { Paragraph } from "./TextNode";
import { describe, expect, it } from "vitest";

function paragraph(text: string): Paragraph {
  return {
    id: "paragraph-1",
    orderKey: "a0",
    type: "paragraph",
    charRuns: text ? [{ peerId: "seed", startCounter: 1, text }] : [],
    formats: [],
  };
}

function mathBlock(latex: string): MathBlock {
  return {
    id: "math-1",
    orderKey: "a1",
    type: "math",
    charRuns: latex ? [{ peerId: "seed", startCounter: 100, text: latex }] : [],
    formats: [],
    displayMode: true,
  };
}

function stateWithCursor(page: Page, cursor: CursorState): EditorState {
  const state = createMathTestState(page);
  return {
    ...state,
    document: { ...state.document, cursor },
  };
}

describe("backspace at the start of a math block", () => {
  it("demotes the same block to a paragraph with a math mark", () => {
    const state = stateWithCursor(
      {
        id: "page-1",
        title: "",
        blocks: [paragraph("Euler: "), mathBlock("e^{i\\pi}+1=0")],
      },
      { position: { blockIndex: 1, textIndex: 0 }, lastUpdate: 0 },
    );

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const visibleBlocks = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    expect(visibleBlocks).toHaveLength(2);
    expect(
      getVisibleTextFromRuns((visibleBlocks[0] as Paragraph).charRuns),
    ).toBe("Euler: ");
    expect(visibleBlocks[1].type).toBe("paragraph");
    expect(
      getVisibleTextFromRuns((visibleBlocks[1] as Paragraph).charRuns),
    ).toBe("e^{i\\pi}+1=0");
    expect(getInlineMathSpans(visibleBlocks[1])).toMatchObject([
      {
        startIndex: 0,
        endIndex: 12,
        latex: "e^{i\\pi}+1=0",
      },
    ]);
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 1,
      textIndex: 0,
    });
    expect(result.state.ui.activeMarksMode).toEqual({ type: "inherit" });
  });

  it("also demotes a math block when it is the first block", () => {
    const state = stateWithCursor(
      {
        id: "page-1",
        title: "",
        blocks: [{ ...mathBlock("x^2"), orderKey: "a0" }],
      },
      { position: { blockIndex: 0, textIndex: 0 }, lastUpdate: 0 },
    );

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const visibleBlocks = result.state.document.page.blocks.filter(
      (block) => !block.deleted,
    );

    expect(visibleBlocks).toHaveLength(1);
    expect(visibleBlocks[0].type).toBe("paragraph");
    expect(getInlineMathSpans(visibleBlocks[0])[0]?.latex).toBe("x^2");
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
  });

  it("undo restores the original math block and removes the inline mark", () => {
    const state = stateWithCursor(
      {
        id: "page-1",
        title: "",
        blocks: [{ ...mathBlock("x^2"), orderKey: "a0" }],
      },
      { position: { blockIndex: 0, textIndex: 0 }, lastUpdate: 0 },
    );

    const converted = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const recorded = recordUndoOps(
      state,
      converted.state,
      converted.ops,
      state.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    const block = undone.document.page.blocks[0];

    expect(block.type).toBe("math");
    expect(getVisibleTextFromRuns((block as MathBlock).charRuns)).toBe("x^2");
    expect(block.formats).toEqual([]);
    expect(undone.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 0,
    });
    expect(undone.ui.activeMarksMode).toEqual({ type: "inherit" });

    const redone = redoState(undone).state;
    expect(redone.document.page.blocks[0].type).toBe("paragraph");
    expect(getInlineMathSpans(redone.document.page.blocks[0])[0]?.latex).toBe(
      "x^2",
    );
  });
});

describe("deleting across a command separator in a math block", () => {
  // The separator space in `\degree C` is absorbed into the command token, so the
  // position before `C` carries no editing unit. Deleting only the raw space
  // would fuse the control word onto `C` into the unknown `\degreeC`; the command
  // must be deleted together with its separator instead. (Same root cause as the
  // inline-chip regression — the seam is shared, so a block proves the fix too.)
  it("Backspace before the letter removes the whole command (\\degree C → C)", () => {
    const state = stateWithCursor(
      {
        id: "page-1",
        title: "",
        blocks: [{ ...mathBlock("\\degree C"), orderKey: "a0" }],
      },
      { position: { blockIndex: 0, textIndex: 8 }, lastUpdate: 0 },
    );

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    expect(
      getVisibleTextFromRuns(
        (result.state.document.page.blocks[0] as MathBlock).charRuns,
      ),
    ).toBe("C");
  });

  it("forward-Delete before the separator removes the separator and the atom (\\degree C → \\degree)", () => {
    const state = stateWithCursor(
      {
        id: "page-1",
        title: "",
        blocks: [{ ...mathBlock("\\degree C"), orderKey: "a0" }],
      },
      { position: { blockIndex: 0, textIndex: 7 }, lastUpdate: 0 },
    );

    const result = state.actionBus.dispatchState(DELETE_FORWARD, state);
    expect(
      getVisibleTextFromRuns(
        (result.state.document.page.blocks[0] as MathBlock).charRuns,
      ),
    ).toBe("\\degree");
  });

  it("an ordinary inter-atom space still merges (a b → ab)", () => {
    const state = stateWithCursor(
      {
        id: "page-1",
        title: "",
        blocks: [{ ...mathBlock("a b"), orderKey: "a0" }],
      },
      { position: { blockIndex: 0, textIndex: 2 }, lastUpdate: 0 },
    );

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    expect(
      getVisibleTextFromRuns(
        (result.state.document.page.blocks[0] as MathBlock).charRuns,
      ),
    ).toBe("ab");
  });
});

describe("backspace from following text into a math block", () => {
  it("selects the math block first, then deletes it on the next Backspace", () => {
    const after: Paragraph = {
      id: "paragraph-2",
      orderKey: "a2",
      type: "paragraph",
      charRuns: [{ peerId: "seed", startCounter: 200, text: "after" }],
      formats: [],
    };
    const state = stateWithCursor(
      {
        id: "page-1",
        title: "",
        blocks: [mathBlock("x^2"), after],
      },
      { position: { blockIndex: 1, textIndex: 0 }, lastUpdate: 0 },
    );

    const selected = state.actionBus.dispatchState(DELETE_BACKWARD, state);

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

    expect(deleted.ops[0].op).toBe("block_delete");
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
    const after: Paragraph = {
      id: "paragraph-2",
      orderKey: "a2",
      type: "paragraph",
      charRuns: [{ peerId: "seed", startCounter: 200, text: "after" }],
      formats: [],
    };
    const state = stateWithCursor(
      {
        id: "page-1",
        title: "",
        blocks: [mathBlock("x^2"), after],
      },
      { position: { blockIndex: 1, textIndex: 0 }, lastUpdate: 0 },
    );

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
