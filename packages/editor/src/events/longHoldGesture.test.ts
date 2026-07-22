/**
 * Long-hold gesture routing (touch).
 *
 * A long-hold that lands on *non-selected* content snaps the caret to the
 * hit-tested point and enters the magnifier cursor-drag — reachable from
 * anywhere a tap is, not only when the finger starts on the caret. A hold on an
 * existing selection still opens the context menu (isLongPress), and a hold in
 * readonly mode falls back to the plain context-menu-on-release long-press.
 *
 * These exercise the frame-tick branch of `handleEvents` directly (no queued
 * events): with `session.touch.startTime` pushed past CONTEXT_MENU_DURATION, one
 * tick promotes the hold.
 */

import { CONTEXT_MENU_DURATION } from "../constants";
import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { NodeRegistry } from "../rendering/nodes/Node";
import { startSelection, updateSelectionFocus } from "../selection";
import type { Block, Page } from "../serlization/loadPage";
import type {
  BlockBounds,
  EditorState,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { createInitialState } from "../state-utils";
import { generateNKeysBetween } from "../sync/fractional-index";
import { createChromeRegionRegistry } from "./chromeRegions";
import { handleEvents } from "./events";
import {
  createInteractionSession,
  type InteractionSession,
  type TouchState,
} from "./interaction-session";
import { describe, expect, it } from "vitest";

const BLOCK_HEIGHT = 40;
const PADDING_TOP = 4;
const VIEWPORT_HEIGHT = 800;

interface TestBlock extends BlockRuntimeState {
  type: "para";
}

// Fixed-height, non-textual blocks: a hit-test resolves to the block under the
// pointer (textIndex 0), so the resolved caret block is an exact readout of the
// pointer geometry — enough to assert which branch the hold took.
class FixedHeightNode extends AtomicNode<TestBlock> {
  readonly type = "para" as const;
  protected intrinsicHeight(_c: NodeLayoutCtx): number {
    return BLOCK_HEIGHT;
  }
  protected draw(_box: BlockBounds, _c: NodePaintCtx): void {}
}

function pageOf(count: number): Page {
  const keys = generateNKeysBetween(null, null, count);
  const blocks = Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `b${i}`,
        orderKey: keys[i],
        type: "para",
        charRuns: [],
        formats: [],
      }) as unknown as Block,
  );
  return { id: "page", title: "", blocks };
}

function baseState(): EditorState {
  return createInitialState(pageOf(20), {
    nodes: new NodeRegistry().register(new FixedHeightNode()),
  });
}

// Canvas-y at the vertical middle of block `i` (scroll 0).
function midOfBlock(i: number): number {
  return PADDING_TOP + i * BLOCK_HEIGHT + BLOCK_HEIGHT / 2;
}

// A stationary single-finger touch whose hold has already outlived the
// long-press window, parked over block `blockIndex` in the text column.
function heldTouch(
  blockIndex: number,
  over: Partial<TouchState> = {},
): TouchState {
  const x = 50; // inside the content column (past the left padding)
  const y = midOfBlock(blockIndex);
  return {
    startY: y,
    startScrollY: 0,
    lastY: y,
    lastTime: Date.now(),
    velocityY: 0,
    velocityHistory: [],
    startX: x,
    startTime: Date.now() - (CONTEXT_MENU_DURATION + 200),
    isLongPress: false,
    hasMoved: false,
    currentTouchX: x,
    currentTouchY: y,
    isTouchingSelection: false,
    isTouchingCursor: false,
    isCursorDrag: false,
    touchRadiusX: 8,
    touchRadiusY: 8,
    ...over,
  };
}

function tick(state: EditorState, session: InteractionSession): EditorState {
  const viewport: ViewportState = {
    width: 600,
    height: VIEWPORT_HEIGHT,
    scrollY: 0,
    documentHeight: PADDING_TOP + 20 * BLOCK_HEIGHT + PADDING_TOP,
  };
  const visibility: VisibleBlockRange = {
    start: 0,
    end: 0,
    startY: PADDING_TOP,
  };
  return handleEvents(
    state,
    viewport,
    visibility,
    [], // no queued events — isolate the long-hold promotion tick
    viewport.documentHeight,
    { left: 0, top: 0 },
    session,
  ).state;
}

describe("long-hold gesture routing", () => {
  it("a hold on non-selected content enters cursor-drag and snaps the caret there", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    session.touch = heldTouch(3);

    const next = tick(baseState(), session);

    // Magnifier cursor-drag — not the old drag-select.
    expect(session.touch?.isCursorDrag).toBe(true);
    expect(session.touch?.isLongPress).toBe(false);
    expect(next.ui.mode).not.toBe("select");
    // Caret snapped to the hit-tested block under the finger.
    expect(next.document.cursor?.position.blockIndex).toBe(3);
  });

  it("a hold on an existing selection opens the context menu, not cursor-drag", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    session.touch = heldTouch(3, { isTouchingSelection: true });

    // Give it a live, non-collapsed selection so it's a real selection hold.
    let state = baseState();
    state = startSelection(state, { blockIndex: 2, textIndex: 0 });
    state = updateSelectionFocus(state, { blockIndex: 4, textIndex: 0 });

    const next = tick(state, session);

    expect(session.touch?.isLongPress).toBe(true);
    expect(session.touch?.isCursorDrag).toBe(false);
    // The selection survives the hold (the menu acts on it).
    expect(next.document.selection?.isCollapsed).toBe(false);
  });

  it("a hold outside an active text selection does not enter cursor-drag", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    // Hold over block 1, away from a selection spanning blocks 5–7.
    session.touch = heldTouch(1);

    let state = baseState();
    state = startSelection(state, { blockIndex: 5, textIndex: 0 });
    state = updateSelectionFocus(state, { blockIndex: 7, textIndex: 0 });

    tick(state, session);

    // The loupe only moves a caret, so a hold while a range is up must not pop
    // it — it falls through to the plain long-press instead.
    expect(session.touch?.isCursorDrag).toBe(false);
    expect(session.touch?.isLongPress).toBe(true);
  });

  it("a hold with a visual/atomic block selected does not enter cursor-drag", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    session.touch = heldTouch(1);

    // A collapsed selection on a non-textual block = a visual block selection
    // (e.g. a selected image). isCollapsed is true, so the gate must look past it.
    const base = baseState();
    const state: EditorState = {
      ...base,
      document: {
        ...base.document,
        selection: {
          anchor: { blockIndex: 3, textIndex: 0 },
          focus: { blockIndex: 3, textIndex: 0 },
          isForward: true,
          isCollapsed: true,
          lastUpdate: 0,
        },
      },
    };

    tick(state, session);

    expect(session.touch?.isCursorDrag).toBe(false);
    expect(session.touch?.isLongPress).toBe(true);
  });

  it("a hold in readonly mode falls back to a plain long-press (no cursor-drag)", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    session.touch = heldTouch(3);

    const state = {
      ...baseState(),
      ui: { ...baseState().ui, mode: "readonly" as const },
    };
    const next = tick(state, session);

    expect(session.touch?.isLongPress).toBe(true);
    expect(session.touch?.isCursorDrag).toBe(false);
    expect(next.ui.mode).toBe("readonly");
  });
});

describe("selection-handle drag magnifier", () => {
  const GRAB_X = 50;
  const GRAB_Y = midOfBlock(3);

  function draggingHandleState(): EditorState {
    const base = baseState();
    return {
      ...base,
      document: {
        ...base.document,
        selection: {
          anchor: { blockIndex: 2, textIndex: 0 },
          focus: { blockIndex: 3, textIndex: 0 },
          isForward: true,
          isCollapsed: false,
          lastUpdate: 0,
        },
      },
      ui: {
        ...base.ui,
        selectionHandleDrag: { startX: GRAB_X, startY: GRAB_Y },
      },
    };
  }

  it("shows the loupe once the handle has been held past the activation delay", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    session.handleDragLoupe = {
      startTime: Date.now() - 1000, // well past the activation delay
      shown: false,
      x: GRAB_X,
      y: GRAB_Y,
    };

    tick(draggingHandleState(), session);

    expect(session.handleDragLoupe?.shown).toBe(true);
  });

  it("does not show the loupe before the activation delay (a quick adjust)", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    session.handleDragLoupe = {
      startTime: Date.now(), // just grabbed
      shown: false,
      x: GRAB_X,
      y: GRAB_Y,
    };

    tick(draggingHandleState(), session);

    expect(session.handleDragLoupe?.shown).toBe(false);
  });

  it("cancels the loupe if the finger drags away before it shows (direct drag)", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    session.handleDragLoupe = {
      startTime: Date.now(), // still within the delay
      shown: false,
      x: GRAB_X,
      y: GRAB_Y,
    };
    const handleRegion = session.regions
      .all()
      .find((r) => r.id === "selection-handle");

    // A move past the threshold before the loupe shows = "dragging directly".
    handleRegion?.drag?.onMove(
      { x: GRAB_X + 60, y: GRAB_Y },
      {
        state: draggingHandleState(),
        viewport: {
          width: 600,
          height: VIEWPORT_HEIGHT,
          scrollY: 0,
          documentHeight: PADDING_TOP + 20 * BLOCK_HEIGHT + PADDING_TOP,
        },
        documentHeight: PADDING_TOP + 20 * BLOCK_HEIGHT + PADDING_TOP,
        session,
      },
    );

    expect(session.handleDragLoupe).toBeNull();
  });
});
