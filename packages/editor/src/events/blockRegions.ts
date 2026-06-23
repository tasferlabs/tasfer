/**
 * Block-content regions — binds behavior to the named hit regions that nodes
 * declare (Node.regions). Nodes stay presentation-only: they expose geometry
 * + a stable id ("todo-checkbox", "image-resize"), and this module supplies
 * the semantic side (CRDT ops, drag state) in the event layer where actions
 * and editor state belong.
 *
 * `hitTestAllRegions` is the full dispatcher entry point: chrome regions
 * (scrollbar, selection handles, …) and the node regions of the block under
 * the point compete purely on priority.
 */

import {
  AtomicNode,
  type NodeHitRegion,
  type NodeRegionCtx,
  TOGGLE_TODO_CHECKED,
} from "../rendering/nodes";
import { getBlockHeight } from "../rendering/renderer";
import { getEditorStyles } from "../styles";
import {
  hitTestRegions,
  type PointerType,
  type Region,
  type RegionClaim,
  type RegionCtx,
  type RegionPoint,
} from "./regions";

/** Todo checkbox — tap toggles the checked state (emits a CRDT op). */
function bindTodoCheckbox(hitRegion: NodeHitRegion): Region {
  return {
    id: hitRegion.id,
    priority: 50,
    modes: ["edit", "select"],
    hitTest: (p, pointerType) => hitRegion.hitTest(p, pointerType),
    onTap(hit, _p, _tapCount, ctx) {
      const { blockIndex } = hit as { blockIndex: number };
      const result = ctx.state.actionBus.dispatchState(
        TOGGLE_TODO_CHECKED,
        ctx.state,
        { blockIndex },
      );
      return { state: result.state, ops: result.ops };
    },
  };
}

/**
 * Adapt a node hit region to an event-layer Region. A region that carries its
 * own behavior (`onTap`/`drag` — e.g. ImageNode's resize handle) is bound
 * directly; a geometry-only region is bound by id (the todo checkbox is the
 * remaining built-in case). Unknown geometry-only ids are inert (no behavior).
 */
function bindNodeRegion(hitRegion: NodeHitRegion): Region | null {
  if (hitRegion.onTap || hitRegion.drag) {
    return {
      id: hitRegion.id,
      priority: hitRegion.priority ?? 0,
      modes: hitRegion.modes,
      hitTest: (p, pointerType) => hitRegion.hitTest(p, pointerType),
      onTap: hitRegion.onTap,
      drag: hitRegion.drag,
    };
  }
  switch (hitRegion.id) {
    case "todo-checkbox":
      return bindTodoCheckbox(hitRegion);
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
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);

  const visibleBlocks = state.view.visibleBlocks;
  const startIndex = ctx.visibility?.start ?? 0;
  let currentY =
    ctx.visibility?.startY ?? styles.canvas.paddingTop - viewport.scrollY;
  for (
    let visibleIdx = startIndex;
    visibleIdx < visibleBlocks.length;
    visibleIdx++
  ) {
    const block = visibleBlocks[visibleIdx];
    const blockHeight = getBlockHeight(
      state.nodes,
      state.marks,
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
      marks: state.marks,
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
  if (ctx.state.ui.mode === "suspended") return null;
  return hitTestRegions(p, pointerType, ctx, nodeRegionsAtPoint(p, ctx));
}
