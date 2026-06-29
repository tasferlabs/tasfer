/**
 * Touch selection-handle drag: the handle under the finger is the *focus* (the
 * moving end) and the opposite handle is the *anchor* (the fixed base). Dragging
 * the start handle past the end keeps the end pinned, and vice versa. This holds
 * even when the grabbed handle is the selection's anchor — onStart swaps the
 * stored endpoints so the dragged end is always the focus.
 */
import { getCursorDocumentCoords } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { hitTestAllRegions } from "./blockRegions";
import { createChromeRegionRegistry } from "./chromeRegions";
import { createInteractionSession } from "./interaction-session";
import { beginRegionInteraction, routeCapturedMove } from "./regions";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const d = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!d.body) d.body = { appendChild: () => {}, removeChild: () => {} };
});

// Short paragraphs so each block sits on its own line; vertical hit-testing
// works in jsdom even though horizontal text measurement does not.
const MD = ["# Title", "AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"].join(
  "\n\n",
);

const viewport: ViewportState = {
  width: 800,
  height: 2000,
  scrollY: 0,
  documentHeight: 4000,
};

function blockCaretPoint(
  state: EditorState,
  blockIndex: number,
): { x: number; y: number } {
  const styles = getEditorStyles(state);
  const c = getCursorDocumentCoords(
    { blockIndex, textIndex: 0 },
    state,
    viewport,
    styles,
  )!;
  return { x: c.x + 2, y: c.y - viewport.scrollY + c.height / 2 };
}

function handleBallPoint(
  state: EditorState,
  which: "anchor" | "focus",
): { x: number; y: number } {
  const styles = getEditorStyles(state);
  const sel = state.document.selection!;
  const pos = which === "anchor" ? sel.anchor : sel.focus;
  const coords = getCursorDocumentCoords(pos, state, viewport, styles)!;
  const handleRadius = styles.selection.handles.size / 2;
  const stemHeight = styles.selection.handles.stemHeight;
  const isTop = which === "anchor" ? sel.isForward : !sel.isForward;
  const ballY = isTop
    ? coords.y - stemHeight - handleRadius
    : coords.y + coords.height + stemHeight + handleRadius;
  return { x: coords.x, y: ballY - viewport.scrollY };
}

function withForwardSelection(
  anchorBlock: number,
  focusBlock: number,
): EditorState {
  const state = createInitialState(loadPage(MD));
  return {
    ...state,
    document: {
      ...state.document,
      selection: {
        anchor: { blockIndex: anchorBlock, textIndex: 0 },
        focus: { blockIndex: focusBlock, textIndex: 0 },
        isForward: anchorBlock <= focusBlock,
        isCollapsed: false,
        lastUpdate: 0,
      },
      cursor: {
        position: { blockIndex: focusBlock, textIndex: 0 },
        lastUpdate: 0,
      },
    },
  };
}

/** Grab the named visual handle and drag it through the given blocks in turn. */
function dragHandleThrough(
  start: EditorState,
  which: "anchor" | "focus",
  blocks: number[],
): EditorState {
  const session = createInteractionSession(createChromeRegionRegistry());
  const grab = handleBallPoint(start, which);
  const claim = hitTestAllRegions(grab, "touch", {
    state: start,
    viewport,
    documentHeight: viewport.documentHeight,
    session,
    visibility: undefined,
  } as never);
  expect(claim?.region.id).toBe("selection-handle");
  expect(claim?.hit).toBe(which);

  const begin = beginRegionInteraction(claim!, grab, "touch", {
    state: start,
    viewport,
    documentHeight: viewport.documentHeight,
    session,
  } as never);
  let cur = (begin as { state: EditorState }).state;

  for (const b of blocks) {
    const res = routeCapturedMove(blockCaretPoint(cur, b), {
      state: cur,
      viewport,
      documentHeight: viewport.documentHeight,
      session,
      updateViewport: undefined,
    } as never);
    cur = res!.state;
  }
  return cur;
}

describe("touch selection-handle drag", () => {
  it("dragging the start (anchor) handle keeps the end pinned and moves the focus", () => {
    // Forward selection: start handle is the anchor (block 2), end is focus (block 5).
    const state = withForwardSelection(2, 5);
    const after = dragHandleThrough(state, "anchor", [3]);
    const sel = after.document.selection!;

    // The end (block 5) is untouched; the dragged handle is the focus at block 3.
    expect(sel.focus.blockIndex).toBe(3);
    expect(sel.anchor.blockIndex).toBe(5);
    expect(sel.isCollapsed).toBe(false);
    // The caret tracks the dragged handle.
    expect(after.document.cursor?.position.blockIndex).toBe(3);
  });

  it("keeps the opposite end fixed when the dragged start handle crosses past it", () => {
    const state = withForwardSelection(2, 5);
    // Drag the start handle down to the end, onto it, then past it.
    const after = dragHandleThrough(state, "anchor", [3, 5, 6]);
    const sel = after.document.selection!;

    // The end (block 5) stayed fixed the whole time; the focus is now below it,
    // so the selection reads forward again (anchor 5 precedes focus 6).
    expect(sel.anchor.blockIndex).toBe(5);
    expect(sel.focus.blockIndex).toBe(6);
    expect(sel.isForward).toBe(true);
    expect(sel.isCollapsed).toBe(false);
  });

  it("dragging the end (focus) handle keeps the start pinned", () => {
    const state = withForwardSelection(2, 5);
    const after = dragHandleThrough(state, "focus", [4]);
    const sel = after.document.selection!;

    // The start (block 2) is the fixed anchor; the focus follows the finger.
    expect(sel.anchor.blockIndex).toBe(2);
    expect(sel.focus.blockIndex).toBe(4);
  });

  it("resolves to a non-empty selection when collapsing the start onto the end", () => {
    const state = withForwardSelection(2, 5);
    const after = dragHandleThrough(state, "anchor", [5]);
    const sel = after.document.selection!;

    expect(sel.anchor.blockIndex).toBe(5);
    expect(sel.focus.blockIndex).toBe(5);
    expect(sel.isCollapsed).toBe(true);
  });
});
