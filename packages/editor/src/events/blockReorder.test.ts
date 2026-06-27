/**
 * Block reorder (gutter drag handle). The handle is a chrome region whose
 * hitTest claims the left-gutter band over a block; its drag stashes a
 * `ui.blockDrag` (with the drop insertion index) and, on release, repositions
 * the block via the `MOVE_BLOCK` action — a single `block_set` of `orderKey`.
 * These tests pin the geometry (`dropIndexAtPoint`), the band hit-test, and the
 * start/move/end/cancel drag transitions. CRDT convergence of the emitted op is
 * covered separately by `sync/block-move.test.ts`.
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
});

describe("block-drag-handle region hitTest", () => {
  const region = dragHandle();
  const ctx = ctxOf(stateOf(["A", "B", "C", "D"]));

  it("claims the gutter band over a block, returning its id", () => {
    // paddingLeft is 40; the band is [12, 40). x=20 is inside.
    expect(region.hitTest({ x: 20, y: topOf(0) + 10 }, "mouse", ctx)).toEqual({
      blockId: "A",
      originalIndex: 0,
    });
    expect(region.hitTest({ x: 20, y: topOf(1) + 10 }, "mouse", ctx)).toEqual({
      blockId: "B",
      originalIndex: 1,
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
      { blockId: "B" },
      { x: 20, y: topOf(1) + 30 },
      ctxOf(state),
    );
    expect(res?.state.ui.blockDrag).toEqual({
      blockId: "B",
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
        blockDrag: { blockId: "B", pointerY: 0, dropIndex: 0 },
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
        blockDrag: { blockId: "C", pointerY: 0, dropIndex: 0 },
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
        blockDrag: { blockId: "A", pointerY: 0, dropIndex: 3 },
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
        blockDrag: { blockId: "B", pointerY: 0, dropIndex: 1 },
      },
    };
    const res = drag.onEnd(null, ctxOf(dragging));
    expect(res?.ops).toHaveLength(0);
    expect(order(res!.state)).toEqual(["A", "B", "C", "D"]);
  });
});
