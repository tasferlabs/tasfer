import { DELETE_BACKWARD } from "../actions/edit-actions";
import { getInlineMathSpans } from "../inline-math-spans";
import type { CursorState, EditorState, Page } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import type { MathBlock } from "./MathNode";
import type { Paragraph } from "./TextNode";
import { describe, expect, it } from "vitest";

function paragraph(text: string): Paragraph {
  return {
    id: "paragraph-1",
    afterId: null,
    type: "paragraph",
    charRuns: text ? [{ peerId: "seed", startCounter: 1, text }] : [],
    formats: [],
  };
}

function mathBlock(latex: string): MathBlock {
  return {
    id: "math-1",
    afterId: "paragraph-1",
    type: "math",
    charRuns: latex ? [{ peerId: "seed", startCounter: 100, text: latex }] : [],
    formats: [],
    displayMode: true,
  };
}

function stateWithCursor(page: Page, cursor: CursorState): EditorState {
  const state = createInitialState(page);
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
        blocks: [{ ...mathBlock("x^2"), afterId: null }],
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
        blocks: [{ ...mathBlock("x^2"), afterId: null }],
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
