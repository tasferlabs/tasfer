/**
 * Pointer geometry for an inline chip: the region that LIGHTS on hover and the
 * region a click ENTERS the formula through are the same region, resolved by the
 * chip's own hit-test.
 *
 * Both used to be derived from the chip's flat edges instead, which broke in two
 * ways: a nested caret owns every flat caret rect in its block (so the hover
 * probe collapsed to a point and the chip went dark while being edited), and a
 * flat edge is a coarse target (so a click anywhere on the formula entered at
 * its start or end rather than at the construct under the pointer).
 */

import { PLACE_CURSOR_AT_POINT } from "../actions/mouse-actions";
import { POINTER_MOVE, TEXT_CLICK } from "../actions/pointer-actions";
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import {
  getContentSelectionFromViewport,
  getCursorDocumentCoords,
  getTextPositionFromViewport,
  moveCursorToPosition,
} from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { updateContentSelection } from "../structured-selection";
import { isTextualBlock } from "../sync/block-registry";
import { createCRDTbinding } from "../sync/sync";
import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

const viewport: ViewportState = {
  width: 600,
  height: 800,
  scrollY: 0,
  documentHeight: 1000,
};

function chipState(peer: string, markdown = "$abcdefg$"): EditorState {
  const state = createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding("page", peer),
  });
  return moveCursorToPosition(state, 0, 1);
}

/** A point over the middle of the (only) chip, which spans the whole block. */
function chipMidpoint(state: EditorState): { x: number; y: number } {
  const start = getCursorDocumentCoords(
    { blockIndex: 0, textIndex: 0 },
    state,
    viewport,
  );
  const end = getCursorDocumentCoords(
    { blockIndex: 0, textIndex: 1 },
    state,
    viewport,
  );
  if (!start || !end) throw new Error("expected the chip's flat edges");
  return { x: (start.x + end.x) / 2, y: start.y + start.height / 2 };
}

/** Put the nested caret at `sourceOffset` of the chip's canonical source. */
function caretInsideChip(state: EditorState, sourceOffset: number) {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual host block");
  const run = resolveStructuredInlineMathRuns(block)[0];
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

/** The desktop pointer move the event layer dispatches, with real hit-tests. */
function pointerMove(
  state: EditorState,
  point: { x: number; y: number },
): EditorState {
  return state.actionBus.dispatchState(POINTER_MOVE, state, {
    canvasX: point.x,
    canvasY: point.y,
    textPosition: getTextPositionFromViewport(
      point.x,
      point.y,
      state,
      viewport,
    ),
    blockUnderPoint: 0,
    atomicBlock: null,
    viewport,
    resolveCoords: (position) =>
      getCursorDocumentCoords(position, state, viewport),
    resolveContentSelection: () =>
      getContentSelectionFromViewport(
        point.x,
        point.y,
        state,
        viewport,
        "mouse",
      ),
    modifiers: { ctrlOrMeta: false },
  }).state;
}

/** The click the event layer dispatches, including its unclaimed fallback. */
function click(state: EditorState, point: { x: number; y: number }) {
  const position = getTextPositionFromViewport(
    point.x,
    point.y,
    state,
    viewport,
  );
  if (!position) throw new Error("expected a flat position under the pointer");
  const contentSelection = getContentSelectionFromViewport(
    point.x,
    point.y,
    state,
    viewport,
    "mouse",
  );
  const clicked = state.actionBus.dispatchState(TEXT_CLICK, state, {
    canvasX: point.x,
    canvasY: point.y,
    position,
    contentSelection,
    previousMenu: state.ui.activeMenu,
    viewport,
    modifiers: { ctrlOrMeta: false, shift: false },
  });
  const placed = clicked.claimed
    ? clicked.state
    : clicked.state.actionBus.dispatchState(
        PLACE_CURSOR_AT_POINT,
        clicked.state,
        { position, extend: false, contentSelection },
      ).state;
  return { placed, contentSelection };
}

describe("inline chip hover", () => {
  it("lights the chip under the pointer", () => {
    const state = chipState("chip-hover");
    const hovered = pointerMove(state, chipMidpoint(state));
    expect(hovered.ui.inlineMathHover).toEqual({
      blockIndex: 0,
      startIndex: 0,
      endIndex: 1,
    });
  });

  it("keeps lighting it while the caret edits inside the formula", () => {
    const state = chipState("chip-hover-nested");
    const editing = caretInsideChip(state, 2);
    const hovered = pointerMove(editing, chipMidpoint(editing));
    expect(hovered.ui.inlineMathHover).toEqual({
      blockIndex: 0,
      startIndex: 0,
      endIndex: 1,
    });
  });

  it("clears the highlight beside the chip", () => {
    const state = chipState("chip-hover-outside");
    const end = getCursorDocumentCoords(
      { blockIndex: 0, textIndex: 1 },
      state,
      viewport,
    );
    const hovered = pointerMove(state, {
      x: (end?.x ?? 0) + 20,
      y: (end?.y ?? 0) + 2,
    });
    expect(hovered.ui.inlineMathHover).toBeNull();
  });
});

describe("inline chip click", () => {
  it("places the caret on the construct under the pointer, not the chip edge", () => {
    const state = chipState("chip-click");
    const { placed, contentSelection } = click(state, chipMidpoint(state));

    // The chip's own hit-test resolved a mid-formula caret; that exact caret is
    // what the click installs.
    expect(contentSelection).not.toBeNull();
    expect(placed.document.contentSelection?.focus).toEqual(
      contentSelection?.focus,
    );
    // …and it is genuinely mid-formula, not the leading edge the chip's flat
    // position projects to.
    expect(placed.document.contentSelection?.focus).not.toEqual(
      caretInsideChip(state, 0).document.contentSelection?.focus,
    );
  });
});
