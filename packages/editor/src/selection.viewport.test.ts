import { AtomicNode } from "./rendering/nodes/AtomicNode";
import type {
  BlockRuntimeState,
  NodeLayoutCtx,
  NodePaintCtx,
} from "./rendering/nodes/Node";
import { NodeRegistry } from "./rendering/nodes/Node";
import {
  getTextPositionFromViewport,
  scrollToMakeCursorVisible,
} from "./selection";
import type { Block, Page } from "./serlization/loadPage";
import type { BlockBounds } from "./state-types";
import { createInitialState } from "./state-utils";
import { describe, expect, it } from "vitest";

interface TestBlock extends BlockRuntimeState {
  type: "viewport-test";
}

describe("viewport pointer lookup", () => {
  it("starts from the latest painted visible range", () => {
    let heightCalls = 0;
    class TestNode extends AtomicNode<TestBlock> {
      readonly type = "viewport-test" as const;
      protected intrinsicHeight(_c: NodeLayoutCtx): number {
        heightCalls++;
        return 40;
      }
      protected draw(_box: BlockBounds, _c: NodePaintCtx): void {}
    }

    const blocks = Array.from({ length: 1000 }, (_, index) => ({
      id: `b${index}`,
      type: "viewport-test",
    })) as unknown as Block[];
    const page: Page = { id: "page", title: "", blocks };
    const state = createInitialState(page, {
      nodes: new NodeRegistry().register(new TestNode()),
    });
    const viewport = {
      width: 600,
      height: 800,
      scrollY: 36_000,
      documentHeight: 40_000,
    };

    const position = getTextPositionFromViewport(
      100,
      20,
      state,
      viewport,
      undefined,
      { start: 900, end: 920, startY: 0 },
    );

    expect(position).toEqual({ blockIndex: 900, textIndex: 0 });
    expect(heightCalls).toBe(1);
  });

  it("clamps a point below the viewport to the fold, not the document end", () => {
    // Regression: dragging a selection (or holding it for edge auto-scroll) past
    // the bottom edge of a long, mid-scrolled document must not jump the focus to
    // the very end of the document and select everything below the fold at once.
    class TestNode extends AtomicNode<TestBlock> {
      readonly type = "viewport-test" as const;
      protected intrinsicHeight(_c: NodeLayoutCtx): number {
        return 40;
      }
      protected draw(_box: BlockBounds, _c: NodePaintCtx): void {}
    }

    const blocks = Array.from({ length: 1000 }, (_, index) => ({
      id: `b${index}`,
      type: "viewport-test",
    })) as unknown as Block[];
    const page: Page = { id: "page", title: "", blocks };
    const state = createInitialState(page, {
      nodes: new NodeRegistry().register(new TestNode()),
    });
    const viewport = {
      width: 600,
      height: 800,
      scrollY: 4_000,
      documentHeight: 40_000,
    };

    // Painted window: block 100 at canvas-y 0, 40px blocks. The walk passes the
    // viewport bottom (800) at block 121 (top 840). A pointer at y = 900 is below
    // the viewport with content continuing below the fold.
    const position = getTextPositionFromViewport(
      100,
      900,
      state,
      viewport,
      undefined,
      {
        start: 100,
        end: 120,
        startY: 0,
      },
    );

    // Clamped to the fold (block 121), not the document's final block (999).
    expect(position).toEqual({ blockIndex: 121, textIndex: 0 });
  });

  it("clamps gutter points to the same edges as the text column", () => {
    // Regression: a drag that leaves the text column sideways (x in the
    // left/right padding) and keeps going up or down took a separate walk that
    // resolved BOTH cases to the document's last block — dragging up into the
    // top corner jumped the focus to the end of the document, and holding at
    // the bottom edge swallowed everything below the fold in one step.
    class TestNode extends AtomicNode<TestBlock> {
      readonly type = "viewport-test" as const;
      protected intrinsicHeight(_c: NodeLayoutCtx): number {
        return 40;
      }
      protected draw(_box: BlockBounds, _c: NodePaintCtx): void {}
    }

    const blocks = Array.from({ length: 1000 }, (_, index) => ({
      id: `b${index}`,
      type: "viewport-test",
    })) as unknown as Block[];
    const page: Page = { id: "page", title: "", blocks };
    const state = createInitialState(page, {
      nodes: new NodeRegistry().register(new TestNode()),
    });
    const viewport = {
      width: 600,
      height: 800,
      scrollY: 4_000,
      documentHeight: 40_000,
    };
    // Painted window: block 100 at canvas-y 20, 40px blocks.
    const visibility = { start: 100, end: 120, startY: 20 };
    const gutterX = 10; // inside the 40px left padding

    // Above the first painted block → its start, not the document's end.
    expect(
      getTextPositionFromViewport(
        gutterX,
        5,
        state,
        viewport,
        undefined,
        visibility,
      ),
    ).toEqual({ blockIndex: 100, textIndex: 0 });

    // Below the viewport with content past the fold → clamped to the fold.
    expect(
      getTextPositionFromViewport(
        gutterX,
        900,
        state,
        viewport,
        undefined,
        visibility,
      ),
    ).toEqual({ blockIndex: 120, textIndex: 0 });
  });

  it("keeps typing scroll checks in the latest painted coordinate space", () => {
    const blocks = Array.from({ length: 1000 }, (_, index) => ({
      id: `p${index}`,
      type: "paragraph",
      charRuns: [],
      formats: [],
    })) as Block[];
    const page: Page = { id: "page", title: "", blocks };
    const state = createInitialState(page);
    const viewport = {
      width: 600,
      height: 800,
      scrollY: 10_000,
      documentHeight: 40_000,
    };
    const position = { blockIndex: 900, textIndex: 0 };
    const visibility = { start: 900, end: 920, startY: 100 };

    expect(
      scrollToMakeCursorVisible(
        position,
        state,
        viewport,
        undefined,
        visibility,
      ),
    ).toBeNull();

    // The old block-zero walk mixes exact document geometry with the estimated
    // scrollbar position and requests a large jump (block 900 sits ~28k deep at
    // the default 32px empty-paragraph height — far past the 10k scroll).
    expect(
      scrollToMakeCursorVisible(position, state, viewport),
    ).toBeGreaterThan(25_000);
  });
});
