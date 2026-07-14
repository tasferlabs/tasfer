/**
 * Arrow navigation across inline math chips in an RTL host block.
 *
 * A formula's interior always renders LTR, but the HOST side of its edges
 * follows the block's direction: in RTL prose the text logically AFTER the
 * chip sits visually to its LEFT. The enter/exit bridges must therefore mirror
 * their flat-offset mapping in RTL — the legacy flat model navigated this
 * correctly, and tree mode used to bail ("leave RTL to the ordinary mover"),
 * which made chips impossible to arrow into and exits land on the wrong side.
 */
import {
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
} from "../actions/keyboard-actions";
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { getBlockDirection } from "../rtl";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { updateContentSelection } from "../structured-selection";
import { isTextualBlock } from "../sync/block-registry";
import { createCRDTbinding } from "../sync/sync";
import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

function rtlChipState(): EditorState {
  const binding = createCRDTbinding("page", "rtl-nav");
  const state = createInitialState(loadPage("مرحبا $xy$ سلام", schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: binding,
  });
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  if (getBlockDirection(block, state.marks) !== "rtl") {
    throw new Error("expected the harness block to resolve RTL");
  }
  return state;
}

function chipRun(state: EditorState) {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  const run = resolveStructuredInlineMathRuns(block)[0];
  if (!run?.contentId || !run.document || run.latex === undefined) {
    throw new Error("expected an attached inline math run");
  }
  return run;
}

/**
 * The identity-bearing point a nested caret at `sourceOffset` would occupy.
 * Compared against the live selection focus so the asserts stay pure —
 * mapping the live selection BACK to an offset would need math layout.
 */
function pointAtSourceOffset(state: EditorState, sourceOffset: number) {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  const run = chipRun(state);
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    run.contentId!,
    run.document!,
    sourceOffset,
  );
  if (!selection) throw new Error("expected a nested math caret");
  const { kind, nodeId, afterCharId } = selection.focus as {
    kind?: string;
    nodeId?: string;
    afterCharId?: string | null;
  };
  return { kind, nodeId, afterCharId };
}

function nestedFocusPoint(state: EditorState) {
  const focus = state.document.contentSelection?.focus as
    | { kind?: string; nodeId?: string; afterCharId?: string | null }
    | undefined;
  if (!focus) throw new Error("expected an active content selection");
  return {
    kind: focus.kind,
    nodeId: focus.nodeId,
    afterCharId: focus.afterCharId,
  };
}

function enterAtSourceOffset(
  state: EditorState,
  sourceOffset: number,
): EditorState {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  const run = chipRun(state);
  const selection = mathContentSelectionFromSourceOffset(
    block.id,
    run.contentId!,
    run.document!,
    sourceOffset,
  );
  if (!selection) throw new Error("expected a nested math caret");
  return updateContentSelection(state, selection);
}

describe("entering an inline chip with arrows in an RTL block", () => {
  it("ArrowRight at the chip's visual-left edge (run end) enters at source start", () => {
    const state = rtlChipState();
    const run = chipRun(state);
    const at = moveCursorToPosition(state, 0, run.endIndex);
    const moved = at.actionBus.dispatchState(MOVE_CURSOR_RIGHT, at);
    expect(moved.state.document.contentSelection).toBeTruthy();
    expect(nestedFocusPoint(moved.state)).toEqual(
      pointAtSourceOffset(moved.state, 0),
    );
  });

  it("ArrowLeft at the chip's visual-right edge (run start) enters at source end", () => {
    const state = rtlChipState();
    const run = chipRun(state);
    const at = moveCursorToPosition(state, 0, run.startIndex);
    const moved = at.actionBus.dispatchState(MOVE_CURSOR_LEFT, at);
    expect(moved.state.document.contentSelection).toBeTruthy();
    expect(nestedFocusPoint(moved.state)).toEqual(
      pointAtSourceOffset(moved.state, run.latex!.length),
    );
  });
});

describe("exiting an inline chip with arrows in an RTL block", () => {
  it("ArrowLeft at the formula's source start exits to the run's END offset", () => {
    const state = enterAtSourceOffset(rtlChipState(), 0);
    const run = chipRun(state);
    const moved = state.actionBus.dispatchState(MOVE_CURSOR_LEFT, state);
    expect(moved.state.document.contentSelection).toBeNull();
    expect(moved.state.document.cursor?.position.textIndex).toBe(run.endIndex);
  });

  it("ArrowRight at the formula's source end exits to the run's START offset", () => {
    const before = rtlChipState();
    const run = chipRun(before);
    const state = enterAtSourceOffset(before, run.latex!.length);
    const moved = state.actionBus.dispatchState(MOVE_CURSOR_RIGHT, state);
    expect(moved.state.document.contentSelection).toBeNull();
    expect(moved.state.document.cursor?.position.textIndex).toBe(
      run.startIndex,
    );
  });
});
