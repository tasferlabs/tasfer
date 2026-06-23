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
    // scrollbar position and requests a large jump.
    expect(
      scrollToMakeCursorVisible(position, state, viewport),
    ).toBeGreaterThan(30_000);
  });
});
