/**
 * Touch selection-handle drag: the handle under the finger is the *focus* (the
 * moving end) and the opposite handle is the *anchor* (the fixed base). Dragging
 * the start handle past the end keeps the end pinned, and vice versa. This holds
 * even when the grabbed handle is the selection's anchor — onStart swaps the
 * stored endpoints so the dragged end is always the focus.
 */
import { CURSOR_DRAG_BOUNDARY } from "../action-bus";
import type { MathBlock } from "../nodes/MathNode";
import {
  getCursorDocumentCoords,
  getTextPositionFromViewport,
} from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, Page, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { hitTestAllRegions } from "./blockRegions";
import { createChromeRegionRegistry } from "./chromeRegions";
import {
  createInteractionSession,
  type InteractionSession,
} from "./interaction-session";
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

/** Grab the named visual handle, returning the live session and post-grab state. */
function grabHandle(
  start: EditorState,
  which: "anchor" | "focus",
): { session: InteractionSession; state: EditorState } {
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
  return { session, state: (begin as { state: EditorState }).state };
}

/** One captured-drag move of the held handle to a viewport point. */
function moveHandle(
  session: InteractionSession,
  state: EditorState,
  p: { x: number; y: number },
): EditorState {
  const res = routeCapturedMove(p, {
    state,
    viewport,
    documentHeight: viewport.documentHeight,
    session,
    updateViewport: undefined,
  } as never);
  return res!.state;
}

/** Grab the named visual handle and drag it through the given blocks in turn. */
function dragHandleThrough(
  start: EditorState,
  which: "anchor" | "focus",
  blocks: number[],
): EditorState {
  const { session, state } = grabHandle(start, which);
  let cur = state;
  for (const b of blocks) {
    cur = moveHandle(session, cur, blockCaretPoint(cur, b));
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

  it("ticks a boundary haptic each time the dragged handle crosses into a new block", () => {
    const state = withForwardSelection(2, 5);
    let boundaryTicks = 0;
    state.actionBus.register(CURSOR_DRAG_BOUNDARY, () => {
      boundaryTicks += 1;
    });

    // Focus starts at block 5; dragging it through three distinct blocks crosses
    // a boundary on each move, so the host gets a tap per crossing.
    dragHandleThrough(state, "focus", [4, 3, 2]);
    expect(boundaryTicks).toBe(3);
  });

  it("does not tick a boundary haptic when the handle stays in the same block", () => {
    const state = withForwardSelection(2, 5);
    let boundaryTicks = 0;
    state.actionBus.register(CURSOR_DRAG_BOUNDARY, () => {
      boundaryTicks += 1;
    });

    // Re-landing on the focus's current block (5) moves nothing, so no tap.
    dragHandleThrough(state, "focus", [5]);
    expect(boundaryTicks).toBe(0);
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

// "\frac{aaa}{bbb}": numerator slot spans [6, 9], denominator [11, 14].
const FRAC = "\\frac{aaa}{bbb}";

/** A display-math fraction block followed by a paragraph, with a selection
 *  inside the fraction's numerator (anchor..focus, both in block 0). */
function withNumeratorSelection(
  anchorIdx: number,
  focusIdx: number,
): EditorState {
  const math: MathBlock = {
    id: "math-1",
    orderKey: "a0",
    deleted: false,
    type: "math",
    charRuns: [{ peerId: "peer", startCounter: 0, text: FRAC }],
    formats: [],
    displayMode: true,
  };
  const page: Page = {
    id: "page-1",
    title: "Math",
    blocks: [
      math,
      {
        id: "p-1",
        orderKey: "a1",
        deleted: false,
        type: "paragraph",
        charRuns: [{ peerId: "peer", startCounter: 20, text: "after" }],
        formats: [],
      },
    ],
  };
  const state = createInitialState(page);
  return {
    ...state,
    document: {
      ...state.document,
      selection: {
        anchor: { blockIndex: 0, textIndex: anchorIdx },
        focus: { blockIndex: 0, textIndex: focusIdx },
        isForward: true,
        isCollapsed: false,
        lastUpdate: 0,
      },
      cursor: {
        position: { blockIndex: 0, textIndex: focusIdx },
        lastUpdate: 0,
      },
    },
  };
}

/** Viewport-space center of the caret at a math-source offset. */
function mathCaretCenter(
  state: EditorState,
  textIndex: number,
): { x: number; y: number; height: number } {
  const styles = getEditorStyles(state);
  const c = getCursorDocumentCoords(
    { blockIndex: 0, textIndex },
    state,
    viewport,
    styles,
  )!;
  return {
    x: c.x,
    y: c.y - viewport.scrollY + c.height / 2,
    height: c.height,
  };
}

describe("touch selection-handle drag over stacked math rows", () => {
  it("holds the focus in the numerator against finger wobble at the fraction bar", () => {
    // Selection inside the numerator: anchor after `\frac{`, focus after `aa`.
    // Dragging the focus handle toward the fraction bar wobbles across the
    // numerator/denominator midline by less than the row hysteresis; without the
    // prev-hit anchor the raw hit dithers rows, and the construct snapper turns
    // each denominator frame into a whole-fraction selection — the reported
    // magnifier bounce.
    const state = withNumeratorSelection(6, 8);
    const num = mathCaretCenter(state, 8);
    const den = mathCaretCenter(state, 13);
    expect(den.y).toBeGreaterThan(num.y);

    // The exact y where a FRESH drag hit (no hysteresis anchor) first resolves
    // to the denominator — the midline the finger wobbles across.
    let flipY: number | null = null;
    for (let y = num.y; y <= den.y; y += 0.25) {
      const pos = getTextPositionFromViewport(
        num.x,
        y,
        state,
        viewport,
        undefined,
        undefined,
        { drag: true },
      );
      if (pos && pos.textIndex >= 11 && pos.textIndex <= 14) {
        flipY = y;
        break;
      }
    }
    expect(flipY).not.toBeNull();

    const { session, state: grabbed } = grabHandle(state, "focus");
    // Settle in the numerator, then wobble just past the fresh-drag flip point.
    let cur = moveHandle(session, grabbed, { x: num.x, y: num.y });
    cur = moveHandle(session, cur, { x: num.x, y: flipY! + 1.5 });

    // Hysteresis holds the row: the focus stays a numerator caret and the
    // selection never escalates to the whole fraction.
    const sel = cur.document.selection!;
    expect(sel.focus.textIndex).toBeGreaterThanOrEqual(6);
    expect(sel.focus.textIndex).toBeLessThanOrEqual(9);
    expect(sel.anchor.textIndex).toBe(6);

    // A decisive move onto the denominator's own row still switches — the
    // straddling selection then snaps to the whole fraction, as designed.
    cur = moveHandle(session, cur, { x: den.x, y: den.y + den.height / 2 });
    const snapped = cur.document.selection!;
    const lo = Math.min(snapped.anchor.textIndex, snapped.focus.textIndex);
    const hi = Math.max(snapped.anchor.textIndex, snapped.focus.textIndex);
    expect(lo).toBe(0);
    expect(hi).toBe(FRAC.length);
  });
});
