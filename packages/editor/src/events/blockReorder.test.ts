/**
 * Block reorder (gutter drag handle). The handle is a chrome region whose
 * hitTest claims the left-gutter band over a block — or, when the selection
 * spans several lines, over that whole run from one handle on its first line.
 * Its drag stashes a `ui.blockDrag` (the moved blocks + the drop insertion
 * index) and, on release, repositions them via the `MOVE_BLOCKS` action — one
 * `block_set` of `orderKey` each. These tests pin the geometry
 * (`dropIndexAtPoint`), the band hit-test, and the start/move/end/cancel drag
 * transitions. CRDT convergence of the emitted ops is covered separately by
 * `sync/block-move.test.ts`.
 */

import { AtomicNode } from "../rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "../rendering/nodes/Node";
import { NodeRegistry } from "../rendering/nodes/Node";
import { dropIndexAtPoint } from "../selection";
import type { Block, Page } from "../serlization/loadPage";
import type { BlockBounds, EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { sortBlocksByOrder } from "../sync/crdt-utils";
import { generateNKeysBetween } from "../sync/fractional-index";
import { createChromeRegionRegistry } from "./chromeRegions";
import { createInteractionSession } from "./interaction-session";
import type { Region, RegionCtx } from "./regions";
import { beforeEach, describe, expect, it } from "vitest";

// Fixed-height block so on-screen block tops are exact: with paddingTop 4 and
// scrollY 0, block i occupies [4 + i*40, 4 + (i+1)*40).
const BLOCK_HEIGHT = 40;
const PADDING_TOP = 4;

interface TestBlock extends BlockRuntimeState {
  type: "para";
}

class FixedHeightNode extends AtomicNode<TestBlock> {
  readonly type = "para" as const;
  protected intrinsicHeight(_c: NodeLayoutCtx): number {
    return BLOCK_HEIGHT;
  }
  protected draw(_box: BlockBounds, _c: NodePaintCtx): void {}
}

function topOf(index: number): number {
  return PADDING_TOP + index * BLOCK_HEIGHT;
}

const VIEWPORT: ViewportState = {
  width: 600,
  height: 800,
  scrollY: 0,
  documentHeight: 1000,
};

/** Build a page of `ids.length` fixed-height blocks with ascending orderKeys. */
function pageOf(ids: string[]): Page {
  const keys = generateNKeysBetween(null, null, ids.length);
  const blocks = ids.map(
    (id, i) =>
      ({
        id,
        orderKey: keys[i],
        type: "para",
        charRuns: [],
        formats: [],
      }) as unknown as Block,
  );
  return { id: "page", title: "", blocks };
}

function stateOf(ids: string[]): EditorState {
  return createInitialState(pageOf(ids), {
    nodes: new NodeRegistry().register(new FixedHeightNode()),
  });
}

function ctxOf(state: EditorState): RegionCtx {
  return {
    state,
    viewport: VIEWPORT,
    documentHeight: VIEWPORT.documentHeight,
    session: createInteractionSession(createChromeRegionRegistry()),
    updateViewport: () => {},
  };
}

/** Visible (non-deleted) block ids in document order, from a result state. */
function order(state: EditorState): string[] {
  return sortBlocksByOrder(state.document.page.blocks)
    .filter((b) => !b.deleted)
    .map((b) => b.id);
}

/**
 * `state` with a text selection running from block `from` to block `to`. The
 * focus offset decides whether the trailing block counts as selected: offset 0
 * highlights nothing in it.
 */
function withSelection(
  state: EditorState,
  from: number,
  to: number,
  focusTextIndex = 1,
): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      selection: {
        anchor: { blockIndex: from, textIndex: 0 },
        focus: { blockIndex: to, textIndex: focusTextIndex },
        isForward: true,
        isCollapsed: false,
      },
    },
  };
}

function dragHandle(): Region {
  const region = createChromeRegionRegistry()
    .all()
    .find((r) => r.id === "block-drag-handle");
  if (!region) throw new Error("block-drag-handle region not registered");
  return region;
}

describe("dropIndexAtPoint", () => {
  const state = stateOf(["A", "B", "C", "D"]);

  it("maps a y above the first midpoint to the head (0)", () => {
    expect(dropIndexAtPoint(topOf(0) + 5, state, VIEWPORT)).toBe(0);
  });

  it("maps each band past a block's midpoint to the next gap", () => {
    // Midpoint of block i is at topOf(i) + 20.
    expect(dropIndexAtPoint(topOf(0) + 25, state, VIEWPORT)).toBe(1);
    expect(dropIndexAtPoint(topOf(1) + 25, state, VIEWPORT)).toBe(2);
    expect(dropIndexAtPoint(topOf(2) + 25, state, VIEWPORT)).toBe(3);
  });

  it("maps a y past the last midpoint to the tail (N)", () => {
    expect(dropIndexAtPoint(topOf(3) + 25, state, VIEWPORT)).toBe(4);
  });

  // Regression: off-screen blocks above the fold carry *estimated* heights in
  // the height index, so the content paint reports where blocks actually landed
  // via the `visibility` snapshot (`start`/`startY`). The drop math must anchor
  // to that snapshot, not re-walk the exact flow from block 0 — otherwise the
  // insertion gap is computed against positions that don't match the pixels and
  // lands under the wrong (usually preceding) block.
  it("anchors the gap walk at the visibility snapshot, not block 0", () => {
    const scrolled = stateOf(["A", "B", "C", "D", "E"]);
    // Paint reports block C (index 2) drawn at y=200; D at 240, E at 280.
    const visibility = { start: 2, end: 4, startY: 200 };

    // y=250 is past C's midpoint (220) but short of D's (260) → gap before D.
    expect(
      dropIndexAtPoint(250, scrolled, VIEWPORT, undefined, visibility),
    ).toBe(3);

    // Without the snapshot the naive flow from block 0 (paddingTop, scrollY 0)
    // puts every block far above y=250 and wrongly reports the tail.
    expect(dropIndexAtPoint(250, scrolled, VIEWPORT)).toBe(5);
  });
});

describe("block-drag-handle region hitTest", () => {
  const region = dragHandle();
  const ctx = ctxOf(stateOf(["A", "B", "C", "D"]));

  it("claims the gutter band over a block, returning its id", () => {
    // paddingLeft is 40; the band is [12, 40). x=20 is inside.
    expect(region.hitTest({ x: 20, y: topOf(0) + 10 }, "mouse", ctx)).toEqual({
      blockId: "A",
      originalIndex: 0,
      blockIds: ["A"],
    });
    expect(region.hitTest({ x: 20, y: topOf(1) + 10 }, "mouse", ctx)).toEqual({
      blockId: "B",
      originalIndex: 1,
      blockIds: ["B"],
    });
  });

  it("declines outside the gutter band (too far left or in the content)", () => {
    expect(region.hitTest({ x: 4, y: topOf(0) + 10 }, "mouse", ctx)).toBeNull();
    expect(
      region.hitTest({ x: 50, y: topOf(0) + 10 }, "mouse", ctx),
    ).toBeNull();
  });

  it("declines above the first block and below the last", () => {
    expect(region.hitTest({ x: 20, y: 0 }, "mouse", ctx)).toBeNull();
    expect(region.hitTest({ x: 20, y: 5000 }, "mouse", ctx)).toBeNull();
  });

  it("declines for touch (mouse-only gesture)", () => {
    expect(
      region.hitTest({ x: 20, y: topOf(0) + 10 }, "touch", ctx),
    ).toBeNull();
  });

  // A selection spanning several lines gets ONE handle, on its first line —
  // anywhere in the run's gutter grabs the whole run. Hover and drag share this
  // hit test, so the grip is painted on that first line too.
  describe("with a multi-line selection", () => {
    const selected = ctxOf(withSelection(stateOf(["A", "B", "C", "D"]), 1, 2));
    const run = { blockId: "B", originalIndex: 1, blockIds: ["B", "C"] };

    it("resolves anywhere in the run to the first selected block", () => {
      expect(region.hitTest({ x: 20, y: topOf(1) + 10 }, "mouse", selected)) //
        .toEqual(run);
      expect(region.hitTest({ x: 20, y: topOf(2) + 10 }, "mouse", selected)) //
        .toEqual(run);
    });

    it("leaves a block outside the run as its own single handle", () => {
      expect(
        region.hitTest({ x: 20, y: topOf(3) + 10 }, "mouse", selected),
      ).toEqual({ blockId: "D", originalIndex: 3, blockIds: ["D"] });
    });

    it("excludes a trailing block the selection only touches at offset 0", () => {
      // Selecting into C's offset 0 highlights nothing in C, so the run is B
      // alone and the handle stays per-block.
      const ctx0 = ctxOf(withSelection(stateOf(["A", "B", "C", "D"]), 1, 2, 0));
      expect(
        region.hitTest({ x: 20, y: topOf(1) + 10 }, "mouse", ctx0),
      ).toEqual({ blockId: "B", originalIndex: 1, blockIds: ["B"] });
    });
  });
});

describe("block-drag-handle drag lifecycle", () => {
  let region: Region;
  beforeEach(() => {
    region = dragHandle();
  });

  it("onStart stashes blockDrag with the drop index under the pointer", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const state = stateOf(["A", "B", "C", "D"]);
    const res = drag.onStart(
      { blockId: "B", originalIndex: 1, blockIds: ["B"] },
      { x: 20, y: topOf(1) + 30 },
      ctxOf(state),
    );
    expect(res?.state.ui.blockDrag).toEqual({
      blockIds: ["B"],
      pointerY: topOf(1) + 30,
      dropIndex: 2, // past B's midpoint (y=20) → gap after B
    });
  });

  it("onCancel clears blockDrag without emitting ops", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const state = {
      ...stateOf(["A", "B", "C"]),
    } as EditorState;
    const dragging: EditorState = {
      ...state,
      ui: {
        ...state.ui,
        blockDrag: { blockIds: ["B"], pointerY: 0, dropIndex: 0 },
      },
    };
    expect(drag.onCancel(ctxOf(dragging)).ui.blockDrag).toBeNull();
  });

  it("onEnd moves the block to the head when dropIndex is 0", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const state = stateOf(["A", "B", "C", "D"]);
    const dragging: EditorState = {
      ...state,
      ui: {
        ...state.ui,
        blockDrag: { blockIds: ["C"], pointerY: 0, dropIndex: 0 },
      },
    };
    const res = drag.onEnd(null, ctxOf(dragging));
    expect(res?.ops).toHaveLength(1);
    expect(res?.ops?.[0].op).toBe("block_set");
    expect(order(res!.state)).toEqual(["C", "A", "B", "D"]);
    expect(res?.state.ui.blockDrag).toBeNull();
  });

  it("onEnd repositions after the block at dropIndex-1", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const state = stateOf(["A", "B", "C", "D"]);
    // Drop A into the gap after C (gap index 3 → afterBlockId = C).
    const dragging: EditorState = {
      ...state,
      ui: {
        ...state.ui,
        blockDrag: { blockIds: ["A"], pointerY: 0, dropIndex: 3 },
      },
    };
    const res = drag.onEnd(null, ctxOf(dragging));
    expect(order(res!.state)).toEqual(["B", "C", "A", "D"]);
  });

  it("onEnd is a no-op when the block lands in its own gap", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const state = stateOf(["A", "B", "C", "D"]);
    // B already follows A; dropping into the gap after A (index 1) changes nothing.
    const dragging: EditorState = {
      ...state,
      ui: {
        ...state.ui,
        blockDrag: { blockIds: ["B"], pointerY: 0, dropIndex: 1 },
      },
    };
    const res = drag.onEnd(null, ctxOf(dragging));
    expect(res?.ops).toHaveLength(0);
    expect(order(res!.state)).toEqual(["A", "B", "C", "D"]);
  });

  it("onEnd moves a whole run, keeping its internal order", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const state = stateOf(["A", "B", "C", "D"]);
    // Drop [A,B] at the tail — one block_set per moved block.
    const dragging: EditorState = {
      ...state,
      ui: {
        ...state.ui,
        blockDrag: { blockIds: ["A", "B"], pointerY: 0, dropIndex: 4 },
      },
    };
    const res = drag.onEnd(null, ctxOf(dragging));
    expect(res?.ops).toHaveLength(2);
    expect(order(res!.state)).toEqual(["C", "D", "A", "B"]);
  });

  it("onEnd is a no-op when a run lands in a gap inside itself", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const state = stateOf(["A", "B", "C", "D"]);
    // Gap index 2 sits between B and C — both are being dragged.
    const dragging: EditorState = {
      ...state,
      ui: {
        ...state.ui,
        blockDrag: { blockIds: ["B", "C"], pointerY: 0, dropIndex: 2 },
      },
    };
    const res = drag.onEnd(null, ctxOf(dragging));
    expect(res?.ops).toHaveLength(0);
    expect(order(res!.state)).toEqual(["A", "B", "C", "D"]);
  });

  // The move re-sorts page.blocks, and the selection addresses blocks by array
  // index — left alone it would stay behind, highlighting whichever lines slid
  // into the vacated slots instead of the ones the user just dragged.
  it("onEnd keeps the selection on the blocks it moved", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const state = withSelection(stateOf(["A", "B", "C", "D"]), 0, 1);
    const dragging: EditorState = {
      ...state,
      ui: {
        ...state.ui,
        blockDrag: { blockIds: ["A", "B"], pointerY: 0, dropIndex: 4 },
      },
    };
    const res = drag.onEnd(null, ctxOf(dragging));
    expect(order(res!.state)).toEqual(["C", "D", "A", "B"]);
    const selection = res!.state.document.selection;
    expect([selection?.anchor.blockIndex, selection?.focus.blockIndex]).toEqual(
      [2, 3],
    );
  });
});

// A block reorder must edge-scroll like the image-resize drag: dragging toward
// a viewport edge scrolls the page so off-screen blocks become reachable drop
// targets. The region opts in by activating auto-scroll from onMove and by
// exposing the onAutoScrollTick/onAutoScrollScrolled hooks the frame loop drives.
describe("block-drag-handle edge auto-scroll", () => {
  let region: Region;
  beforeEach(() => {
    region = dragHandle();
  });

  // VIEWPORT.height is 800; EDGE_SCROLL_THRESHOLD is 80, so y > 720 is the
  // bottom edge band and y < 80 the top band.
  function draggingCtx(): RegionCtx {
    const state = stateOf(["A", "B", "C", "D"]);
    return ctxOf({
      ...state,
      ui: {
        ...state.ui,
        blockDrag: { blockIds: ["A"], pointerY: 0, dropIndex: 0 },
      },
    });
  }

  it("onMove near an edge activates auto-scroll and records the pointer", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const ctx = draggingCtx();
    drag.onMove({ x: 20, y: 760 }, ctx);
    expect(ctx.session.autoScroll.isActive).toBe(true);
    expect(ctx.session.autoScroll.lastPointerX).toBe(20);
    expect(ctx.session.autoScroll.lastPointerY).toBe(760);
  });

  // A fast drag flicks the pointer from mid-canvas straight past the bottom in
  // one step — the canvas never sees an in-band mousemove, only a window-level
  // move at a y BEYOND the viewport (the host forwards it because a region drag
  // owns the pointer). Auto-scroll must still activate from that past-edge y, or
  // the reorder can't reach off-screen blocks. VIEWPORT.height is 800.
  it("onMove past the bottom edge (y > viewport height) activates auto-scroll", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const ctx = draggingCtx();
    drag.onMove({ x: 20, y: 900 }, ctx);
    expect(ctx.session.autoScroll.isActive).toBe(true);
    expect(ctx.session.autoScroll.lastPointerY).toBe(900);
  });

  it("onMove away from the edges stops an active auto-scroll", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const ctx = draggingCtx();
    drag.onMove({ x: 20, y: 760 }, ctx); // activate at the bottom edge
    drag.onMove({ x: 20, y: 400 }, ctx); // move back into the middle
    expect(ctx.session.autoScroll.isActive).toBe(false);
  });

  it("onEnd and onCancel stop auto-scroll", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    const endCtx = draggingCtx();
    drag.onMove({ x: 20, y: 760 }, endCtx);
    drag.onEnd(null, endCtx);
    expect(endCtx.session.autoScroll.isActive).toBe(false);

    const cancelCtx = draggingCtx();
    drag.onMove({ x: 20, y: 760 }, cancelCtx);
    drag.onCancel(cancelCtx);
    expect(cancelCtx.session.autoScroll.isActive).toBe(false);
  });

  it("onAutoScrollTick never blocks scrolling (unlike a maxed image resize)", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    expect(drag.onAutoScrollTick?.({ x: 20, y: 760 }, draggingCtx())).toEqual({
      blockScroll: false,
    });
  });

  it("onAutoScrollScrolled re-resolves the drop gap under a stationary pointer", () => {
    const drag = region.drag;
    if (!drag) throw new Error("expected a drag spec");
    // A doc taller than the viewport so y=760 lands mid-document, not past the
    // tail. The pointer holds at y=760 (bottom edge); after the viewport scrolls
    // down 100px the same screen-y sits over a later block, so the gap advances.
    const ids = Array.from({ length: 30 }, (_, i) => `b${i}`);
    const state = stateOf(ids);
    const before = dropIndexAtPoint(760, state, VIEWPORT);
    const scrolled: ViewportState = { ...VIEWPORT, scrollY: 100 };
    const ctx: RegionCtx = {
      ...ctxOf({
        ...state,
        ui: {
          ...state.ui,
          blockDrag: { blockIds: ["b0"], pointerY: 760, dropIndex: before },
        },
      }),
      viewport: scrolled,
    };
    const next = drag.onAutoScrollScrolled?.({ x: 20, y: 760 }, 100, ctx);
    expect(next?.ui.blockDrag?.dropIndex).toBe(
      dropIndexAtPoint(760, state, scrolled),
    );
    expect(next?.ui.blockDrag?.dropIndex).toBeGreaterThan(before);
  });
});
