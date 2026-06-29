/**
 * Readonly documents never surface math interactivity affordances. A readonly
 * editor (`isReadonlyBase`) must not light a math block's hover/active backdrop
 * nor an inline-math chip on pointer move — mirroring the image resize handles,
 * which are likewise hidden when the document can't be edited. The gate is
 * `isReadonlyBase` (not `mode === "readonly"`) so it also holds in the `select`
 * mode a readonly editor enters for copy.
 */

import { POINTER_MOVE } from "../actions/pointer-actions";
import type { EditorState, Page, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import type { MathBlock } from "./MathNode";
import { describe, expect, it } from "vitest";

const viewport: ViewportState = {
  width: 600,
  height: 800,
  scrollY: 0,
  documentHeight: 1000,
};

function mathBlock(latex: string): MathBlock {
  return {
    id: "math-1",
    orderKey: "a0",
    deleted: false,
    type: "math",
    charRuns: [{ peerId: "peer", startCounter: 0, text: latex }],
    formats: [],
    displayMode: true,
  };
}

function mathPage(): Page {
  return { id: "page-1", title: "Math", blocks: [mathBlock("x^2")] };
}

// Drive a desktop pointer move that lands squarely on the (only) math block.
function hoverMathBlock(state: EditorState): EditorState {
  return state.actionBus.dispatchState(POINTER_MOVE, state, {
    canvasX: 10,
    canvasY: 10,
    textPosition: null,
    blockUnderPoint: 0,
    atomicBlock: null,
    pointerX: 10,
    pointerY: 10,
    viewport,
    resolveCoords: () => null,
    modifiers: { ctrlOrMeta: false },
  }).state;
}

describe("math hover in readonly", () => {
  it("an editable editor lights the hovered math block", () => {
    const next = hoverMathBlock(createInitialState(mathPage()));
    expect(next.ui.hoveredMathBlockIndex).toBe(0);
  });

  it("a readonly editor never lights the hovered math block", () => {
    const next = hoverMathBlock(
      createInitialState(mathPage(), { mode: "readonly" }),
    );
    expect(next.ui.hoveredMathBlockIndex).toBeNull();
  });
});
