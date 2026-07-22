/**
 * collectOverlays — the engine half of the overlay-slot contract.
 *
 * Proves the framework-free path end-to-end without a canvas or a host: a
 * registered node declares overlays from its layout context, and
 * `collectOverlays` walks the visible blocks and returns the descriptors at the
 * blocks' on-screen rects (the host then maps `key` → component). Uses an
 * atomic test node so the height walk stays pure (no text measurement).
 */

import type { Block } from "../serlization/loadPage";
import type { EditorState, NodeOverlay, ViewportState } from "../state-types";
import { defaultStyles } from "../styles";
import { BlockHeightIndex } from "./block-height-index";
import type { MarkStyle } from "./marks";
import { Mark, type MarkOverlayCtx, MarkRegistry } from "./marks";
import { AtomicNode } from "./nodes/AtomicNode";
import type { NodeRegionCtx } from "./nodes/Node";
import { NodeRegistry } from "./nodes/Node";
import { collectOverlays, getEstimatedBlockHeight } from "./renderer";
import { describe, expect, it } from "vitest";

/** A minimal custom atomic node that declares one overlay at its block rect. */
class OverlayTestNode extends AtomicNode {
  readonly type = "overlay-test" as const;
  protected intrinsicHeight(): number {
    return 100;
  }
  protected draw(): void {}
  overlays(c: NodeRegionCtx): readonly NodeOverlay[] {
    return [
      {
        key: "overlay-test-ui",
        blockId: (c.block as Block).id,
        rect: { x: c.origin.x, y: c.origin.y, width: c.maxWidth, height: 80 },
        data: { fromBlock: (c.block as Block).id },
      },
    ];
  }
}

/** A node with NO overlays() — must contribute nothing to the collection. */
class SilentNode extends AtomicNode {
  readonly type = "silent" as const;
  protected intrinsicHeight(): number {
    return 100;
  }
  protected draw(): void {}
}

/** A mark that declares one overlay unconditionally (the block-free path). */
class OverlayTestMark extends Mark {
  readonly type = "overlay-test-mark";
  style(): MarkStyle {
    return {};
  }
  overlays(c: MarkOverlayCtx): readonly NodeOverlay[] {
    // Omit width/height — collectOverlays must default them to 1.
    return [
      {
        key: "mark-overlay-ui",
        blockId: "b-mark",
        rect: { x: c.viewport.scrollY, y: 7 },
      },
    ];
  }
}

function blockOf(type: string, id: string, originalIndex: number) {
  return { type, id, originalIndex } as unknown as Block & {
    originalIndex: number;
  };
}

/** Build a throwaway EditorState carrying just what collectOverlays reads. */
function stateWith(
  registry: NodeRegistry,
  visibleBlocks: (Block & { originalIndex: number })[],
  marks: MarkRegistry = new MarkRegistry(),
): EditorState {
  return {
    nodes: registry,
    marks,
    view: { visibleBlocks },
  } as unknown as EditorState;
}

const viewport: ViewportState = {
  width: 500,
  height: 1000,
  scrollY: 0,
  documentHeight: 0,
};

describe("collectOverlays", () => {
  it("delegates estimates to the registered custom node", () => {
    let exactLayoutCalls = 0;
    class EstimatedNode extends OverlayTestNode {
      estimateHeight(): number {
        return 73;
      }
      protected intrinsicHeight(): number {
        exactLayoutCalls++;
        return 100;
      }
    }

    const registry = new NodeRegistry().register(new EstimatedNode());
    const marks = new MarkRegistry();
    const block = blockOf("overlay-test", "b1", 0);
    const estimated = getEstimatedBlockHeight(
      registry,
      marks,
      block,
      0,
      400,
      defaultStyles,
      true,
    );

    expect(estimated).toBe(73);
    expect(exactLayoutCalls).toBe(0);
  });

  it("returns a node's declared overlay at the block's on-screen rect", () => {
    const registry = new NodeRegistry().register(new OverlayTestNode());
    const state = stateWith(registry, [blockOf("overlay-test", "b1", 0)]);

    const overlays = collectOverlays(state, viewport, defaultStyles);

    const { paddingLeft, paddingRight, paddingTop } = defaultStyles.canvas;
    expect(overlays).toEqual([
      {
        key: "overlay-test-ui",
        blockId: "b1",
        rect: {
          x: paddingLeft,
          y: paddingTop, // scrollY 0
          width: viewport.width - paddingLeft - paddingRight,
          height: 80,
        },
        data: { fromBlock: "b1" },
      },
    ]);
  });

  it("offsets later blocks by the flow height of earlier ones", () => {
    const registry = new NodeRegistry().register(new OverlayTestNode());
    const state = stateWith(registry, [
      blockOf("overlay-test", "b1", 0),
      blockOf("overlay-test", "b2", 1),
    ]);

    const overlays = collectOverlays(state, viewport, defaultStyles);

    expect(overlays.map((o) => o.rect.y)).toEqual([
      defaultStyles.canvas.paddingTop,
      defaultStyles.canvas.paddingTop + 100, // first block is 100 tall
    ]);
  });

  it("ignores nodes that declare no overlays", () => {
    const registry = new NodeRegistry().register(new SilentNode());
    const state = stateWith(registry, [blockOf("silent", "b1", 0)]);

    expect(collectOverlays(state, viewport, defaultStyles)).toEqual([]);
  });

  it("skips blocks scrolled out of the viewport", () => {
    const registry = new NodeRegistry().register(new OverlayTestNode());
    const state = stateWith(registry, [blockOf("overlay-test", "b1", 0)]);

    // Scroll the single 100px block far above the viewport top.
    const scrolled: ViewportState = { ...viewport, scrollY: 2000 };
    expect(collectOverlays(state, scrolled, defaultStyles)).toEqual([]);
  });

  it("uses the height index to skip layout for blocks before the viewport", () => {
    let layoutCalls = 0;
    class CountingNode extends OverlayTestNode {
      protected intrinsicHeight(): number {
        layoutCalls++;
        return 100;
      }
    }

    const registry = new NodeRegistry().register(new CountingNode());
    const visibleBlocks = Array.from({ length: 1000 }, (_, index) =>
      blockOf("overlay-test", `b${index}`, index),
    );
    const state = stateWith(registry, visibleBlocks);
    const heightIndex = new BlockHeightIndex();
    heightIndex.rebuild(visibleBlocks, () => 100);
    const target = 900;
    const scrolled = {
      ...viewport,
      scrollY:
        defaultStyles.canvas.paddingTop +
        heightIndex.offsetOfVisibleIndex(target),
    };

    const overlays = collectOverlays(
      state,
      scrolled,
      defaultStyles,
      heightIndex,
    );

    const firstIndex = Number(overlays[0]?.blockId.slice(1));
    expect(firstIndex).toBeGreaterThanOrEqual(target - 2);
    expect(layoutCalls).toBeLessThan(20);
  });

  it("collects overlays declared by registered marks", () => {
    const marks = new MarkRegistry().register(new OverlayTestMark());
    // No visible blocks: mark overlays are block-free, so they still appear.
    const state = stateWith(new NodeRegistry(), [], marks);

    expect(collectOverlays(state, viewport, defaultStyles)).toEqual([
      {
        key: "mark-overlay-ui",
        blockId: "b-mark",
        rect: { x: viewport.scrollY, y: 7, width: 1, height: 1 },
      },
    ]);
  });
});
