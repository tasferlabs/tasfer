/**
 * Regression: drag-selection focus must track edge auto-scroll.
 *
 * When a downward drag parks the pointer in the bottom edge zone, each frame
 * `handleEvents` advances the scroll *and* re-resolves the selection focus to
 * the position now under the (stationary) pointer. The scroll is applied through
 * `updateViewportCallback`, which the host implements by swapping its viewport
 * for a new object — so the `viewport` value `handleEvents` still holds is the
 * pre-scroll snapshot. The focus must be resolved against the *post-scroll*
 * position the next paint will use; otherwise it lags the paint by one frame's
 * scroll delta and the selection visibly shrinks/grows while auto-scrolling.
 */

import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { NodeRegistry } from "../rendering/nodes/Node";
import { startSelection } from "../selection";
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
  startAutoScroll,
} from "./interaction-session";
import { describe, expect, it } from "vitest";

const BLOCK_HEIGHT = 40;
const PADDING_TOP = 4;
const VIEWPORT_HEIGHT = 800;

interface TestBlock extends BlockRuntimeState {
  type: "para";
}

// Fixed-height, non-textual blocks: a hit-test resolves to the block under the
// pointer (textIndex 0), so the focus *block index* is an exact readout of the
// scroll geometry the resolution used.
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

function selectingState(count: number): EditorState {
  let state = createInitialState(pageOf(count), {
    nodes: new NodeRegistry().register(new FixedHeightNode()),
  });
  // Anchor the selection at the first block and enter select mode, as a live
  // mouse drag would have before reaching the edge.
  state = startSelection(state, { blockIndex: 0, textIndex: 0 });
  return { ...state, ui: { ...state.ui, mode: "select" } };
}

// Block whose vertical band contains canvas-y `pointerY` at scroll `scrollY`.
// Mirrors getTextPositionFromViewport's walk: block i spans
// [paddingTop - scrollY + i*h, ... + h).
function blockUnderPointer(pointerY: number, scrollY: number): number {
  return Math.floor((pointerY - PADDING_TOP + scrollY) / BLOCK_HEIGHT);
}

describe("edge auto-scroll selection focus", () => {
  it("resolves the focus against the scroll applied this frame", () => {
    const state = selectingState(200);
    const documentHeight = PADDING_TOP + 200 * BLOCK_HEIGHT + PADDING_TOP; // well past one viewport

    // Pointer parked 1px below a block boundary in the bottom edge zone
    // (threshold is 80, so y in [720, 800) auto-scrolls). At scrollY 0 it sits
    // in block 18; any positive scroll delta pushes it into block 19+.
    const pointerY = PADDING_TOP + 19 * BLOCK_HEIGHT - 1; // 763
    expect(blockUnderPointer(pointerY, 0)).toBe(18);

    const session = createInteractionSession(createChromeRegionRegistry());
    startAutoScroll(session);
    session.autoScroll.lastPointerX = 50; // inside the text column
    session.autoScroll.lastPointerY = pointerY;

    // Host viewport: the callback swaps it for a new object, exactly like the
    // real editor (so handleEvents' captured `viewport` is always pre-scroll).
    let viewport: ViewportState = {
      width: 600,
      height: VIEWPORT_HEIGHT,
      scrollY: 0,
      documentHeight,
    };
    const updateViewport = (patch: Partial<ViewportState>) => {
      viewport = { ...viewport, ...patch };
    };
    const visibility: VisibleBlockRange = {
      start: 0,
      end: 0,
      startY: PADDING_TOP,
    };

    let current = state;
    let lastFocusBlock = 0;
    let everScrolled = false;

    for (let frame = 0; frame < 8; frame++) {
      const scrollBefore = viewport.scrollY;
      const result = handleEvents(
        current,
        viewport,
        visibility,
        [], // no queued pointer events: isolate the stationary-at-edge tick
        documentHeight,
        { left: 0, top: 0 },
        session,
        updateViewport,
      );
      current = result.state;

      const appliedScrollY = viewport.scrollY;
      if (appliedScrollY > scrollBefore) everScrolled = true;

      const focusBlock = current.document.selection?.focus.blockIndex;
      // Focus must match the block under the pointer at the *applied* scroll,
      // not the pre-scroll scroll. Pre-fix this lagged by `appliedScrollY`'s
      // worth of blocks.
      expect(focusBlock).toBe(blockUnderPointer(pointerY, appliedScrollY));
      // And it must never jump backward toward the anchor while scrolling down.
      expect(focusBlock).toBeGreaterThanOrEqual(lastFocusBlock);
      lastFocusBlock = focusBlock ?? 0;
    }

    expect(everScrolled).toBe(true);
    // Over several frames the scroll has carried the focus well past where it
    // started — the selection grew rather than collapsing.
    expect(lastFocusBlock).toBeGreaterThan(18);
  });
});
