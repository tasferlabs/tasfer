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
import { enterInlineMathTreeAtPosition } from "./inline-tree-state";
import { mathExtension } from "./math-extension";
import {
  deleteSelectedText,
  deleteSelectionThroughOwner,
} from "@tasfer/editor/actions/actions";
import {
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  MOVE_CURSOR_RIGHT,
} from "@tasfer/editor/actions/keyboard-actions";
import { TEXT_CLICK } from "@tasfer/editor/actions/pointer-actions";
import { extendSelectionOutOfStructuredMark } from "@tasfer/editor/actions/structured-marks";
import { resolveMarkRuns } from "@tasfer/editor/mark-runs";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { moveCursorToPosition } from "@tasfer/editor/selection";
import { selectionInsideParts } from "@tasfer/editor/selection-inside";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
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

function markdownOf(state: EditorState) {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: state.schema,
  }).trim();
}

function enterAt(state: EditorState, textIndex: number): EditorState {
  const entered = enterInlineMathTreeAtPosition(state, 0, textIndex, {
    allowBoundary: true,
  });
  if (!entered) throw new Error("inline math did not enter tree mode");
  return entered.state;
}

describe("inline-math ↔ text selection crossing", () => {
  it("Shift+Right from a caret at the formula's trailing edge selects the text after it, not the formula", () => {
    const { state, chipEnd } = chipState("crossing-right");
    const inside = enterAt(state, chipEnd);
    expect(inside.document.contentSelection).not.toBeNull();

    const exited = inside.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      inside,
    );
    expect(exited.claimed).toBe(true);
    expect(exited.state.document.contentSelection).toBeNull();
    expect(exited.state.document.selection?.anchor.textIndex).toBe(chipEnd);
    expect(exited.state.document.selection?.focus.textIndex).toBe(chipEnd + 1);
    expect(selectionInsideParts(exited.state)).toEqual([]);

    // The NEXT press continues into the host prose through the flat model.
    const further = exited.state.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      exited.state,
    );
    expect(further.state.document.selection?.anchor.textIndex).toBe(chipEnd);
    expect(further.state.document.selection?.focus.textIndex).toBe(chipEnd + 2);
  });

  it("Shift+Left from a caret at the formula's leading edge selects the text before it", () => {
    const { state, chipStart } = chipState("crossing-left");
    const inside = enterAt(state, chipStart);

    const exited = inside.actionBus.dispatchState(
      EXTEND_SELECTION_LEFT,
      inside,
    );
    expect(exited.claimed).toBe(true);
    expect(exited.state.document.contentSelection).toBeNull();
    expect(exited.state.document.selection?.anchor.textIndex).toBe(chipStart);
    expect(exited.state.document.selection?.focus.textIndex).toBe(
      chipStart - 1,
    );
    expect(selectionInsideParts(exited.state)).toEqual([]);
  });

  it("Shift+Right past the formula's end keeps the part selected inside it", () => {
    const { state, chipStart, chipEnd } = chipState("crossing-part");
    // `x+y`: a caret after `x`, extended to the formula's end, then beyond.
    let current = enterAt(state, chipStart);
    current = current.actionBus.dispatchState(MOVE_CURSOR_RIGHT, current).state;
    for (let i = 0; i < 2; i++) {
      current = current.actionBus.dispatchState(
        EXTEND_SELECTION_RIGHT,
        current,
      ).state;
    }
    expect(current.document.contentSelection).not.toBeNull();

    const out = current.actionBus.dispatchState(
      EXTEND_SELECTION_RIGHT,
      current,
    ).state;
    expect(out.document.contentSelection).toBeNull();
    expect(out.document.selection?.anchor.textIndex).toBe(chipStart);
    expect(out.document.selection?.focus.textIndex).toBe(chipEnd + 1);
    const [part] = selectionInsideParts(out);
    expect(part).toMatchObject({ end: "anchor", side: "start" });
    expect(markdownOf(deleteSelectedText(out).state)).toBe("aa $x$bb");

    // Shift+Left steps back onto the formula's edge: the range is inside it
    // again, and the next press shrinks it there instead of jumping sides.
    const back = out.actionBus.dispatchState(EXTEND_SELECTION_LEFT, out).state;
    expect(back.document.selection).toBeNull();
    expect(back.document.contentSelection).toEqual(
      expect.objectContaining({
        anchor: current.document.contentSelection!.anchor,
      }),
    );
    const shrunk = back.actionBus.dispatchState(
      EXTEND_SELECTION_LEFT,
      back,
    ).state;
    expect(shrunk.document.contentSelection).not.toBeNull();
    expect(markdownOf(deleteSelectionThroughOwner(shrunk).state)).toBe(
      "aa $xy$ bb",
    );
  });

  it("extendSelectionOutOfStructuredMark takes the formula whole or not at all from a caret at its edge", () => {
    const { state, chipEnd } = chipState("crossing-drag");
    // A caret at the formula's end.
    const inside = enterAt(state, chipEnd);

    const after = extendSelectionOutOfStructuredMark(inside, {
      blockIndex: 0,
      textIndex: chipEnd + 2,
    });
    expect(after?.document.contentSelection).toBeNull();
    expect(after?.document.selection?.anchor.textIndex).toBe(chipEnd);
    expect(after?.document.selection?.focus.textIndex).toBe(chipEnd + 2);

    const before = extendSelectionOutOfStructuredMark(inside, {
      blockIndex: 0,
      textIndex: 0,
    });
    expect(before?.document.selection?.anchor.textIndex).toBe(chipEnd);
    expect(before?.document.selection?.focus.textIndex).toBe(0);
    expect(selectionInsideParts(before!)).toEqual([]);
  });

  it("a Shift+Click on the chip with an active caret stays in the flat model", () => {
    const { state, chipStart, chipEnd } = chipState("crossing-shift-click");
    // A click position on a one-char chip is always a boundary; entry from a
    // boundary is gated on the pointer actually hovering the chip, so model
    // the pointer sitting on it.
    const hovering: EditorState = {
      ...moveCursorToPosition(state, 0, 0),
      ui: {
        ...state.ui,
        inlineMathHover: {
          blockIndex: 0,
          startIndex: chipStart,
          endIndex: chipEnd,
        },
      },
    };
    const clicked = hovering.actionBus.dispatchState(TEXT_CLICK, hovering, {
      canvasX: 20,
      canvasY: 20,
      position: { blockIndex: 0, textIndex: chipStart },
      previousMenu: hovering.ui.activeMenu,
      viewport: { width: 500, height: 300, scrollY: 0, documentHeight: 300 },
      modifiers: { ctrlOrMeta: false, shift: true },
    });
    // The chip must NOT capture the click into its tree; the generic caret
    // placement (dispatched separately by the mouse handler) extends flat.
    expect(clicked.state.document.contentSelection).toBeNull();

    const plainClick = hovering.actionBus.dispatchState(TEXT_CLICK, hovering, {
      canvasX: 20,
      canvasY: 20,
      position: { blockIndex: 0, textIndex: chipStart },
      previousMenu: hovering.ui.activeMenu,
      viewport: { width: 500, height: 300, scrollY: 0, documentHeight: 300 },
      modifiers: { ctrlOrMeta: false, shift: false },
    });
    // Without Shift the same click still enters the tree.
    expect(plainClick.state.document.contentSelection).not.toBeNull();
  });
});
