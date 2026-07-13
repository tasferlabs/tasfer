/**
 * Crossing between inline-math tree editing and the flat host text.
 *
 * A nested selection is deliberately confined to its attachment, but the
 * GESTURES that hit a chip edge must hand over to the flat model instead of
 * dying there: Shift+Arrow at the formula boundary degrades to a flat
 * selection covering the chip whole (interior tree stops don't map losslessly
 * onto flat offsets) and keeps extending into the prose; a drag/Shift+Click
 * leaving the chip does the same via `extendSelectionOutOfStructuredMark`;
 * and a Shift+Click ONTO a chip stays a flat extension rather than dropping
 * the caret into the tree.
 */
import {
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
} from "../actions/keyboard-actions";
import { TEXT_CLICK } from "../actions/pointer-actions";
import { extendSelectionOutOfStructuredMark } from "../actions/structured-marks";
import { resolveMarkRuns } from "../inline-math-spans";
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { createCRDTbinding } from "../sync/sync";
import { enterInlineMathTreeAtPosition } from "./inline-tree-state";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

/** `aa $x+y$ bb` with the tree-mode inline math rules installed. */
function chipState(peer: string): {
  state: EditorState;
  chipStart: number;
  chipEnd: number;
} {
  const binding = createCRDTbinding("page", peer);
  const state = createInitialState(loadPage("aa $x+y$ bb", schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: binding,
  });
  const run = resolveMarkRuns(state.document.page.blocks[0]).find(
    (candidate) => candidate.name === "math",
  );
  if (!run) throw new Error("expected an inline math run");
  return { state, chipStart: run.startIndex, chipEnd: run.endIndex };
}

function enterAt(state: EditorState, textIndex: number): EditorState {
  const entered = enterInlineMathTreeAtPosition(state, 0, textIndex, {
    allowBoundary: true,
  });
  if (!entered) throw new Error("inline math did not enter tree mode");
  return entered.state;
}

describe("inline-math ↔ text selection crossing", () => {
  it("Shift+Right at the formula's trailing edge exits to a flat whole-chip selection", () => {
    const { state, chipStart, chipEnd } = chipState("crossing-right");
    const inside = enterAt(state, chipEnd);
    expect(inside.document.contentSelection).not.toBeNull();

    const exited = inside.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      inside,
    );
    expect(exited.claimed).toBe(true);
    expect(exited.state.document.contentSelection).toBeNull();
    expect(exited.state.document.selection?.anchor.textIndex).toBe(chipStart);
    expect(exited.state.document.selection?.focus.textIndex).toBe(chipEnd);

    // The NEXT press continues into the host prose through the flat model.
    const further = exited.state.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      exited.state,
    );
    expect(further.state.document.selection?.anchor.textIndex).toBe(chipStart);
    expect(further.state.document.selection?.focus.textIndex).toBe(chipEnd + 1);
  });

  it("Shift+Left at the formula's leading edge exits to a flat whole-chip selection", () => {
    const { state, chipStart, chipEnd } = chipState("crossing-left");
    const inside = enterAt(state, chipStart);

    const exited = inside.actionBus.dispatchState(
      EXTEND_SELECTION_LEFT,
      inside,
    );
    expect(exited.claimed).toBe(true);
    expect(exited.state.document.contentSelection).toBeNull();
    expect(exited.state.document.selection?.anchor.textIndex).toBe(chipEnd);
    expect(exited.state.document.selection?.focus.textIndex).toBe(chipStart);
  });

  it("extendSelectionOutOfStructuredMark covers the chip whole and reaches the target", () => {
    const { state, chipStart, chipEnd } = chipState("crossing-drag");
    const inside = enterAt(state, chipStart + 1);

    const after = extendSelectionOutOfStructuredMark(inside, {
      blockIndex: 0,
      textIndex: chipEnd + 2,
    });
    expect(after?.document.contentSelection).toBeNull();
    expect(after?.document.selection?.anchor.textIndex).toBe(chipStart);
    expect(after?.document.selection?.focus.textIndex).toBe(chipEnd + 2);

    const before = extendSelectionOutOfStructuredMark(inside, {
      blockIndex: 0,
      textIndex: 0,
    });
    expect(before?.document.selection?.anchor.textIndex).toBe(chipEnd);
    expect(before?.document.selection?.focus.textIndex).toBe(0);
  });

  it("a Shift+Click on the chip with an active caret stays in the flat model", () => {
    const { state, chipStart } = chipState("crossing-shift-click");
    const withCaret = moveCursorToPosition(state, 0, 0);
    const clicked = withCaret.actionBus.dispatchState(TEXT_CLICK, withCaret, {
      canvasX: 20,
      canvasY: 20,
      position: { blockIndex: 0, textIndex: chipStart + 1 },
      previousMenu: withCaret.ui.activeMenu,
      viewport: { width: 500, height: 300, scrollY: 0, documentHeight: 300 },
      modifiers: { ctrlOrMeta: false, shift: true },
    });
    // The chip must NOT capture the click into its tree; the generic caret
    // placement (dispatched separately by the mouse handler) extends flat.
    expect(clicked.state.document.contentSelection).toBeNull();

    const plainClick = withCaret.actionBus.dispatchState(
      TEXT_CLICK,
      withCaret,
      {
        canvasX: 20,
        canvasY: 20,
        position: { blockIndex: 0, textIndex: chipStart + 1 },
        previousMenu: withCaret.ui.activeMenu,
        viewport: { width: 500, height: 300, scrollY: 0, documentHeight: 300 },
        modifiers: { ctrlOrMeta: false, shift: false },
      },
    );
    // Without Shift the same click still enters the tree.
    expect(plainClick.state.document.contentSelection).not.toBeNull();
  });
});
