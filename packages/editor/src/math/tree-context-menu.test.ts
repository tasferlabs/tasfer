/**
 * Right-click context menu over structured math — regression for the missing
 * "Edit matrix" item and the destroyed selection.
 *
 * A backspace next to a matrix holds (selects) the whole construct as a nested
 * content selection; the flat compatibility selection stays null. The old
 * `handleContextMenu` only checked the flat selection, so a right-click ran
 * `updateCursor`, which cleared the held construct before the host could build
 * its menu items — the menu then saw no selection (Copy/Cut hidden) and no
 * matrix context ("Edit matrix" missing, the matrix target being unreachable
 * through the materialized block's empty flat projection).
 */
import { OPEN_CONTEXT_MENU } from "../action-bus";
import { insertText } from "../actions/actions";
import { DELETE_BACKWARD } from "../actions/edit-actions";
import { handleContextMenu } from "../events/keysEvents";
import { mathExtension } from "../math-extension";
import { mathMatrixContext } from "../nodes/math";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type {
  EditorState,
  MouseEvent as EditorMouseEvent,
  ViewportState,
} from "../state-types";
import { createInitialState } from "../state-utils";
import {
  type ContentPoint,
  updateContentSelection,
} from "../structured-selection";
import { canonicalizeStructuredDocument } from "../sync/structured-content";
import { createCRDTbinding } from "../sync/sync";
import { printMathDocument } from "./data";
import {
  getMathStructuredDocument,
  structuredToMathDocument,
} from "./structured";
import {
  mathContentSelectionFromSourceOffset,
  mathSourceOffsetFromContentPoint,
} from "./tree-selection";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());

const VIEWPORT: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2000,
};

function treeState(markdown: string): EditorState {
  const binding = createCRDTbinding("default-page", "repro");
  return createInitialState(loadPage(markdown, treeMathSchema.data), {
    schema: treeMathSchema.data,
    nodes: createNodeRegistry(treeMathSchema.nodes),
    marks: createMarkRegistry(treeMathSchema.marks),
    crdtBinding: binding,
  });
}

/** The host adapter's caret→matrix probe (apps/web treeMath.ts equivalent). */
function matrixContextAtPoint(state: EditorState, point: ContentPoint) {
  const block = state.document.page.blocks.find(
    (b) => b.id === point.blockId && !b.deleted,
  );
  const raw = block?.structuredContent?.[point.contentId];
  const document = raw ? canonicalizeStructuredDocument(raw) : null;
  const math = document ? structuredToMathDocument(document) : undefined;
  const sourceOffset = document
    ? mathSourceOffsetFromContentPoint(document, point)
    : null;
  if (!document || !math || sourceOffset === null) return null;
  return mathMatrixContext(printMathDocument(math), sourceOffset);
}

/** Display equation with a fraction + 2×2 pmatrix, whole matrix held via the
 * backspace-selects-construct path. */
function heldMatrixState(): EditorState {
  const latex = String.raw`\frac{a}{b}\begin{pmatrix}{}&{}\\{}&{}\end{pmatrix}`;
  let state = moveCursorToPosition(
    treeState(`$$\n${latex}\n$$`),
    0,
    latex.length,
  );
  // Materialize the structured document, then park the tree caret at the
  // equation's end — immediately after the matrix.
  state = insertText(state, "").state;
  const document = getMathStructuredDocument(state.document.page.blocks[0]);
  if (!document) throw new Error("expected structured math");
  const caret = mathContentSelectionFromSourceOffset(
    state.document.page.blocks[0].id,
    document.rootId,
    document,
    latex.length,
  );
  if (!caret) throw new Error("expected caret at equation end");
  state = updateContentSelection(state, caret);
  const held = state.actionBus.dispatchState(DELETE_BACKWARD, state);
  if (!held.claimed) throw new Error("expected backspace to hold the matrix");
  return held.state;
}

function rightClick(state: EditorState): {
  state: EditorState;
  menu: { hasSelection: boolean } | null;
} {
  let menu: { hasSelection: boolean } | null = null;
  const dispose = state.actionBus.register(OPEN_CONTEXT_MENU, (payload) => {
    menu = { hasSelection: payload.hasSelection };
    return true;
  });
  const event = {
    x: 400,
    y: 30,
    button: 2,
    preventDefault() {},
  } as unknown as EditorMouseEvent;
  const next = handleContextMenu(
    state,
    VIEWPORT,
    event as unknown as globalThis.MouseEvent,
    { left: 0, top: 0 },
    { captured: false } as never,
  );
  dispose();
  return { state: next, menu };
}

describe("context menu over a held structured-math construct", () => {
  it("keeps the held matrix selected and reports it as a selection", () => {
    const held = heldMatrixState();
    const selection = held.document.contentSelection;
    expect(selection).not.toBeNull();
    expect(selection?.anchor).not.toEqual(selection?.focus);

    const { state, menu } = rightClick(held);

    // The nested selection must survive the right-click…
    expect(state.document.contentSelection).toEqual(selection);
    // …and count as a selection for the menu's Copy/Cut items.
    expect(menu).toEqual({ hasSelection: true });
  });

  it("resolves the matrix from the surviving selection endpoints", () => {
    const { state } = rightClick(heldMatrixState());
    const selection = state.document.contentSelection;
    if (!selection) throw new Error("expected a surviving content selection");

    // The host probes focus then anchor (a whole-construct selection ends just
    // after the matrix, so the anchor is the endpoint inside it).
    const ctx =
      matrixContextAtPoint(state, selection.focus) ??
      matrixContextAtPoint(state, selection.anchor);
    expect(ctx).toMatchObject({ env: "pmatrix", rows: 2, cols: 2 });
  });
});
