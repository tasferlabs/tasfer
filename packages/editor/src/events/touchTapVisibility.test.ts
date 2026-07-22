/**
 * Regression: a touch tap must resolve against the *painted* block flow.
 *
 * The content paint anchors the on-screen window at the `visibility` snapshot
 * (`start`/`startY`), whose `startY` is derived from the prefix-height index —
 * which carries cheap *estimates* for the off-screen blocks above the fold. When
 * a block's estimated height ≠ its exact height (e.g. a wrapped list/todo item),
 * a hit-test that re-walks exact heights from block 0 lands on a different block
 * than the one painted under the finger: checkbox/list taps miss and selection
 * handles sit away from the text.
 *
 * The mouse path already threads `visibility` into every hit-test; the touch
 * path did not. These tests pin the touch tap to the `visibility` anchor by
 * injecting a snapshot that deliberately disagrees with the from-block-0 walk
 * (standing in for the estimate drift) and asserting the tap follows the paint.
 */

import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { NodeRegistry } from "../rendering/nodes/Node";
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
import {
  createInteractionSession,
  type InteractionSession,
  type TouchState,
} from "./interaction-session";
import { handleTouchEnd } from "./touchEvents";
import { describe, expect, it } from "vitest";

// handleTouchEnd's region hit-test consults the scrollbar chrome, whose iOS
// safe-area probe appends a measuring node to document.body. The shared headless
// `document` stub omits `body`; supply a no-op one so the full tap path runs.
const doc = globalThis.document as unknown as { body?: unknown };
if (!doc.body) {
  doc.body = { appendChild: () => {}, removeChild: () => {} };
}

const BLOCK_HEIGHT = 40;
const PADDING_TOP = 4;
const VIEWPORT_HEIGHT = 800;

interface TestBlock extends BlockRuntimeState {
  type: "para";
}

// Fixed-height, non-textual blocks. A tap resolves to the block under the finger
// and selects it (textIndex 0), so the resulting selection's block index is an
// exact readout of the geometry the tap hit-test used.
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

function baseState(count: number): EditorState {
  return createInitialState(pageOf(count), {
    nodes: new NodeRegistry().register(new FixedHeightNode()),
  });
}

// A completed single tap parked at (x, y) in the content column: short duration,
// no net movement, no long-press / cursor-drag.
function tapAt(x: number, y: number): TouchState {
  return {
    startY: y,
    startScrollY: 0,
    lastY: y,
    lastTime: Date.now(),
    velocityY: 0,
    velocityHistory: [],
    startX: x,
    startTime: Date.now(),
    isLongPress: false,
    hasMoved: false,
    currentTouchX: x,
    currentTouchY: y,
    isTouchingSelection: false,
    isTouchingCursor: false,
    isCursorDrag: false,
    touchRadiusX: 8,
    touchRadiusY: 8,
  };
}

function tapEnd(
  state: EditorState,
  session: InteractionSession,
  viewport: ViewportState,
  documentHeight: number,
  visibility?: VisibleBlockRange,
): EditorState {
  return handleTouchEnd(
    state,
    viewport,
    { changedTouches: [] } as unknown as TouchEvent,
    { left: 0, top: 0 },
    documentHeight,
    session,
    undefined,
    undefined,
    visibility,
  ).state;
}

describe("touch tap resolves against the painted visibility snapshot", () => {
  // Scrolled far down; the document is much taller than one viewport.
  const COUNT = 40;
  const documentHeight = PADDING_TOP + COUNT * BLOCK_HEIGHT + PADDING_TOP;
  const viewport: ViewportState = {
    width: 600,
    height: VIEWPORT_HEIGHT,
    scrollY: 800,
    documentHeight,
  };
  const tapX = 300; // inside the content column (clear of left/right padding)
  const tapY = 400;

  // The painted window: block 18 was painted at canvas-y = PADDING_TOP. This
  // disagrees with the exact walk from block 0 at this scroll — exactly the
  // drift an estimate-vs-exact height mismatch produces above the fold.
  const visibility: VisibleBlockRange = {
    start: 18,
    end: 18,
    startY: PADDING_TOP,
  };

  // Block under the finger, anchored at the paint snapshot: block 18 spans
  // [4, 44), so 18 + floor((400 - 4) / 40) = 27.
  const PAINTED_BLOCK = 27;
  // Block under the finger if we (wrongly) walk exact heights from block 0:
  // floor((400 - (4 - 800)) / 40) = 29.
  const FROM_ZERO_BLOCK = 29;

  it("follows the paint snapshot, not an exact walk from block 0", () => {
    const session = createInteractionSession(createChromeRegionRegistry());
    session.touch = tapAt(tapX, tapY);

    const next = tapEnd(
      baseState(COUNT),
      session,
      viewport,
      documentHeight,
      visibility,
    );

    expect(next.document.selection?.anchor.blockIndex).toBe(PAINTED_BLOCK);
  });

  it("would land on the wrong block without the visibility anchor", () => {
    // Guard the test's own premise: the two anchors genuinely disagree, so the
    // assertion above is meaningful rather than vacuously true.
    expect(PAINTED_BLOCK).not.toBe(FROM_ZERO_BLOCK);

    const session = createInteractionSession(createChromeRegionRegistry());
    session.touch = tapAt(tapX, tapY);

    // No visibility passed → the legacy from-block-0 walk, which drifts.
    const next = tapEnd(baseState(COUNT), session, viewport, documentHeight);

    expect(next.document.selection?.anchor.blockIndex).toBe(FROM_ZERO_BLOCK);
  });
});
