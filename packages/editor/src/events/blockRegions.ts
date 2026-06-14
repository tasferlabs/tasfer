/**
 * Block-content regions — binds behavior to the named hit regions that nodes
 * declare (Node.regions). Nodes stay presentation-only: they expose geometry
 * + a stable id ("todo-checkbox", "image-resize"), and this module supplies
 * the semantic side (CRDT ops, drag state) in the event layer where commands
 * and editor state belong.
 *
 * `hitTestAllRegions` is the full dispatcher entry point: chrome regions
 * (scrollbar, selection handles, …) and the node regions of the block under
 * the point compete purely on priority.
 */

import { toggleTodoChecked } from "../actions/commands";
import { EDGE_SCROLL_THRESHOLD } from "../constants";
import {
  AtomicNode,
  type NodeHitRegion,
  type NodeRegionCtx,
} from "../rendering/nodes";
import { getBlockHeight, imageCache } from "../rendering/renderer";
import { getEditorStyles } from "../styles";
import { withScrollbarInteraction, withStoppedMomentum } from "./chromeRegions";
import {
  cancelImageDrag,
  endImageDrag,
  startImageDrag,
  updateImageDrag,
} from "./eventUtils";
import { startAutoScroll, stopAutoScroll } from "./interaction-session";
import {
  hitTestRegions,
  type PointerType,
  type Region,
  type RegionClaim,
  type RegionCtx,
  type RegionPoint,
} from "./regions";

interface ImageResizeHit {
  blockIndex: number;
  box: { x: number; y: number; width: number; height: number };
  handle: "left" | "right" | "bottom";
}

/** Todo checkbox — tap toggles the checked state (emits a CRDT op). */
function bindTodoCheckbox(hitRegion: NodeHitRegion): Region {
  return {
    id: hitRegion.id,
    priority: 50,
    modes: ["edit", "select"],
    hitTest: (p, pointerType) => hitRegion.hitTest(p, pointerType),
    onTap(hit, _p, _tapCount, ctx) {
      const { blockIndex } = hit as { blockIndex: number };
      const result = toggleTodoChecked(ctx.state, blockIndex);
      return { state: result.state, ops: result.ops };
    },
  };
}

/** Image resize handles — drag to resize, with edge auto-scroll. */
function bindImageResize(hitRegion: NodeHitRegion): Region {
  return {
    id: hitRegion.id,
    priority: 60,
    modes: ["edit", "select"],
    hitTest: (p, pointerType) => hitRegion.hitTest(p, pointerType),
    drag: {
      onStart(hit, p, ctx) {
        const { blockIndex, box } = hit as ImageResizeHit;
        // Tolerance 12 covers both pointer types — the hit test already
        // applied the per-pointer slop, this only re-derives the handle.
        const dragState = startImageDrag(
          ctx.state,
          { blockIndex, ...box },
          p.x,
          p.y,
          12,
        );
        if (!dragState) return null;
        return {
          state: withScrollbarInteraction(withStoppedMomentum(dragState)),
        };
      },
      onMove(p, ctx) {
        const { state, viewport, session } = ctx;
        if (!state.ui.imageDrag) return { state };
        const { blockIndex, handle } = state.ui.imageDrag;
        const block = state.document.page.blocks[blockIndex];
        if (!block || block.deleted) return { state };

        // Bottom handle: once the image is at its natural max height, stop
        // auto-scrolling down (otherwise the drag chases its own scroll).
        let shouldBlockBottomScroll = false;
        const objectFit =
          block.type === "image" ? (block.objectFit ?? "cover") : "cover";
        if (
          handle === "bottom" &&
          objectFit === "cover" &&
          block.type === "image" &&
          block.url
        ) {
          const cachedImage = imageCache.get(block.url);
          if (cachedImage && cachedImage.complete) {
            const imgAspectRatio =
              cachedImage.naturalWidth / cachedImage.naturalHeight;
            const containerWidth =
              typeof block.width === "number" ? block.width : viewport.width;
            const maxHeightForRatio = containerWidth / imgAspectRatio;
            const currentHeight =
              state.ui.imageDrag.startHeight +
              (p.y - state.ui.imageDrag.startY);
            const isAtMaxHeight = currentHeight >= maxHeightForRatio - 1;
            const isNearBottomEdge =
              p.y > viewport.height - EDGE_SCROLL_THRESHOLD ||
              p.y > viewport.height;
            shouldBlockBottomScroll = isAtMaxHeight && isNearBottomEdge;
          }
        }

        // Edge auto-scroll: record the pointer so the frame loop in
        // handleEvents keeps scrolling (and resizing) while the pointer
        // holds still at the edge.
        const isNearTopEdge = p.y < EDGE_SCROLL_THRESHOLD || p.y < 0;
        const isNearBottomEdge =
          p.y > viewport.height - EDGE_SCROLL_THRESHOLD ||
          p.y > viewport.height;
        if (
          (isNearTopEdge || isNearBottomEdge) &&
          !(shouldBlockBottomScroll && isNearBottomEdge)
        ) {
          startAutoScroll(session);
          session.autoScroll.lastPointerX = p.x;
          session.autoScroll.lastPointerY = p.y;
        } else if (session.autoScroll.isActive) {
          stopAutoScroll(session);
        }

        return {
          state: withScrollbarInteraction(
            updateImageDrag(state, viewport, p.x, p.y),
          ),
        };
      },
      onEnd(_p, ctx) {
        stopAutoScroll(ctx.session);
        const result = endImageDrag(ctx.state);
        return {
          state: withScrollbarInteraction(result.state),
          ops: result.ops,
        };
      },
      onCancel(ctx) {
        stopAutoScroll(ctx.session);
        return cancelImageDrag(ctx.state);
      },
    },
  };
}

/** Behavior bindings by node-region id. Unknown ids are inert (no behavior). */
function bindNodeRegion(hitRegion: NodeHitRegion): Region | null {
  switch (hitRegion.id) {
    case "todo-checkbox":
      return bindTodoCheckbox(hitRegion);
    case "image-resize":
      return bindImageResize(hitRegion);
    default:
      return null;
  }
}

/**
 * Collect the bound regions of the block under the point. One walk over the
 * visible blocks (same accumulation as getAtomicBlockAtPoint), honoring an
 * atomic block's interactive box bleeding above its flow box.
 */
function nodeRegionsAtPoint(p: RegionPoint, ctx: RegionCtx): Region[] {
  const { state, viewport } = ctx;
  const styles = getEditorStyles(state);
  let currentY = styles.canvas.paddingTop - viewport.scrollY;
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  const visibleBlocks = state.view.visibleBlocks;
  for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      state.nodes,
      block,
      maxWidth,
      styles,
      visibleIdx === 0,
    );
    const node = state.nodes.get(block.type);
    const layoutCtx = {
      block,
      blockIndex: block.originalIndex,
      maxWidth,
      isFirst: visibleIdx === 0,
      styles,
    };
    const origin = { x: styles.canvas.paddingLeft, y: currentY };

    // The interactive box may bleed above the flow box (first full-width
    // image), so the y-range check starts at whichever is higher.
    const atomicHit =
      node instanceof AtomicNode ? node.hitTestBox(layoutCtx, origin, p) : null;
    const top = atomicHit ? Math.min(currentY, atomicHit.y) : currentY;
    if (p.y >= top && p.y < currentY + blockHeight) {
      if (!node?.regions) return [];
      const c: NodeRegionCtx = { ...layoutCtx, state, viewport, origin };
      return node
        .regions(c)
        .map(bindNodeRegion)
        .filter((r): r is Region => r !== null);
    }

    currentY += blockHeight;
  }
  return [];
}

/**
 * Full region hit test: chrome regions + the node regions of the block under
 * the point, highest priority wins.
 */
export function hitTestAllRegions(
  p: RegionPoint,
  pointerType: PointerType,
  ctx: RegionCtx,
): RegionClaim | null {
  if (ctx.state.ui.mode === "locked") return null;
  return hitTestRegions(p, pointerType, ctx, nodeRegionsAtPoint(p, ctx));
}
