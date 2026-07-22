/**
 * Readonly documents never surface math interactivity affordances. A readonly
 * editor (`isReadonlyBase`) must not light a math block's hover/active backdrop
 * nor an inline-math chip on pointer move — mirroring the image resize handles,
 * which are likewise hidden when the document can't be edited. The gate is
 * `isReadonlyBase` (not `mode === "readonly"`) so it also holds in the `select`
 * mode a readonly editor enters for copy.
 */

import { createMathTestState } from "../__testutils__/math";
import { POINTER_MOVE } from "../actions/pointer-actions";
import type { Page } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
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
  // "math" sits outside the closed core Block union, hence the crossing cast.
  return { id: "page-1", title: "Math", blocks: [mathBlock("x^2") as never] };
}

// Drive a desktop pointer move at `canvasX` on the (only) math block's row.
// Defaults to a point inside the content column (paddingLeft is 40 on desktop).
function hoverMathBlock(state: EditorState, canvasX = 100): EditorState {
  return state.actionBus.dispatchState(POINTER_MOVE, state, {
    canvasX,
    canvasY: 10,
    textPosition: null,
    blockUnderPoint: 0,
    atomicBlock: null,
    viewport,
    resolveCoords: () => null,
    modifiers: { ctrlOrMeta: false },
  }).state;
}

describe("math hover in readonly", () => {
  it("an editable editor lights the hovered math block", () => {
    const next = hoverMathBlock(createMathTestState(mathPage()));
    expect(next.ui.hoveredMathBlockIndex).toBe(0);
  });

  it("a readonly editor never lights the hovered math block", () => {
    const next = hoverMathBlock(
      createMathTestState(mathPage(), { mode: "readonly" }),
    );
    expect(next.ui.hoveredMathBlockIndex).toBeNull();
  });
});

describe("math hover horizontal bounds", () => {
  // The backdrop fills the content column, so hovering the page margins beside
  // the equation (same row, but left of paddingLeft) must not light the block.
  it("does not light the block when hovering the left page margin", () => {
    const next = hoverMathBlock(createMathTestState(mathPage()), 10);
    expect(next.ui.hoveredMathBlockIndex).toBeNull();
  });

  it("does not light the block when hovering the right page margin", () => {
    // viewport.width (600) - paddingRight (40) = 560 is the content-column edge.
    const next = hoverMathBlock(createMathTestState(mathPage()), 580);
    expect(next.ui.hoveredMathBlockIndex).toBeNull();
  });

  it("lights the block when hovering inside the content column", () => {
    const next = hoverMathBlock(createMathTestState(mathPage()), 300);
    expect(next.ui.hoveredMathBlockIndex).toBe(0);
  });
});
