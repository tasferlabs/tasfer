/**
 * Sideways scroll for blocks wider than the page.
 *
 * The page itself only scrolls up and down. A block whose content can be wider
 * than the page — a table with many columns — keeps its own sideways offset
 * and declares it through `Node.canScrollSideways` / `scrollSideways` /
 * `revealSideways`. This module routes the gestures to whichever block is
 * under the pointer, without knowing what that block is:
 *
 *   - a sideways trackpad swipe, or Shift + mouse wheel;
 *   - a finger drag that starts out mostly sideways, and the fling after it;
 *   - the local caret moving somewhere the block has scrolled out of sight.
 */

import type { Node, NodeScrollCtx } from "../rendering/nodes";
import type { EditorState, ViewportState } from "../state-types";
import type { ContentPoint } from "../structured-selection";
import { getEditorStyles } from "../styles";
import { blockAtPoint } from "./blockRegions";
import type { InteractionSession } from "./interaction-session";
import type { RegionCtx, RegionPoint } from "./regions";

/** Below this (px/ms) a released sideways drag does not coast. */
const MIN_FLING_VELOCITY = 0.1;
/** Same throw as the page's own touch momentum. */
const FLING_MULTIPLIER = 1.2;
/** Per-16ms friction, matching the page's momentum (`applyMomentum`). */
const FLING_FRICTION = 0.95;

/** Pixels per wheel "line", for mice that report `deltaMode` 1. */
const WHEEL_LINE_HEIGHT = 16;

/**
 * The sideways part of a wheel event in px, or `null` when the event is an
 * up-and-down one. A trackpad reports both axes at once, so the larger one
 * decides; Shift turns a plain wheel sideways where the browser has not
 * already done so.
 */
export function wheelSidewaysDelta(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">,
  viewportWidth: number,
): number | null {
  let delta: number;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    delta = event.deltaX;
  } else if (event.shiftKey && event.deltaX === 0 && event.deltaY !== 0) {
    delta = event.deltaY;
  } else {
    return null;
  }
  if (event.deltaMode === 1) return delta * WHEEL_LINE_HEIGHT;
  if (event.deltaMode === 2) return delta * viewportWidth;
  return delta;
}

/** Whether the block under `p` has content past its sides. */
export function canScrollSidewaysAt(p: RegionPoint, ctx: RegionCtx): boolean {
  const hit = blockAtPoint(p, ctx);
  return Boolean(hit?.node?.canScrollSideways?.(hit.c));
}

/**
 * Scroll the block under `p` sideways. Returns the next state, or `null` when
 * there is no such block or it has no room that way.
 */
export function scrollSidewaysAt(
  p: RegionPoint,
  deltaX: number,
  ctx: RegionCtx,
): EditorState | null {
  const hit = blockAtPoint(p, ctx);
  if (!hit?.node?.scrollSideways) return null;
  return hit.node.scrollSideways(hit.c, deltaX);
}

/** The block's node and its scroll context, found by id. */
function scrollTarget(
  state: EditorState,
  viewport: ViewportState,
  blockId: string,
): { node: Node; c: NodeScrollCtx } | null {
  const visibleBlocks = state.view.visibleBlocks;
  const visibleIndex = visibleBlocks.findIndex((block) => block.id === blockId);
  if (visibleIndex < 0) return null;
  const block = visibleBlocks[visibleIndex];
  const node = state.nodes.get(block.type);
  if (!node) return null;
  const styles = getEditorStyles(state);
  return {
    node,
    c: {
      block,
      blockIndex: block.originalIndex,
      maxWidth:
        viewport.width -
        (styles.canvas.paddingLeft + styles.canvas.paddingRight),
      isFirst: visibleIndex === 0,
      styles,
      marks: state.marks,
      state,
    },
  };
}

/**
 * Start a fling when a sideways drag is released fast enough. Returns whether
 * it did, so the caller does not also start the page's own momentum.
 */
export function startSidewaysFling(
  p: RegionPoint,
  velocity: number,
  ctx: RegionCtx,
): boolean {
  if (Math.abs(velocity) <= MIN_FLING_VELOCITY) return false;
  const hit = blockAtPoint(p, ctx);
  if (!hit?.node?.scrollSideways) return false;
  ctx.session.sidewaysFling = {
    blockId: hit.c.block.id,
    velocity: velocity * FLING_MULTIPLIER,
    lastTime: Date.now(),
  };
  return true;
}

/**
 * Step a coasting fling by one frame. Stops (and clears the fling) once it is
 * too slow to see or the block runs out of room.
 */
export function stepSidewaysFling(
  state: EditorState,
  viewport: ViewportState,
  session: InteractionSession,
): EditorState {
  const fling = session.sidewaysFling;
  if (!fling) return state;
  const now = Date.now();
  const elapsed = now - fling.lastTime;
  if (elapsed <= 0) return state;
  const velocity = fling.velocity * Math.pow(FLING_FRICTION, elapsed / 16);
  const target = scrollTarget(state, viewport, fling.blockId);
  const next =
    target && Math.abs(velocity) >= 0.01
      ? target.node.scrollSideways?.(target.c, velocity * elapsed)
      : null;
  if (!next) {
    session.sidewaysFling = null;
    return state;
  }
  session.sidewaysFling = { ...fling, velocity, lastTime: now };
  return next;
}

/** Track a sideways drag's velocity (px/ms), for the fling on release. */
export function sidewaysDragVelocity(
  previous: { lastX: number; lastTime: number; velocity: number },
  x: number,
  now: number,
): number {
  const elapsed = now - previous.lastTime;
  if (elapsed <= 0) return previous.velocity;
  const instant = (previous.lastX - x) / elapsed;
  // Lean on the newest sample without letting one jittery frame decide it.
  return previous.velocity * 0.2 + instant * 0.8;
}

/**
 * Let the block that holds a caret at `point` scroll it into sight. Called
 * after the local caret moves, and when a peer's indicator is tapped to jump
 * to them; a no-op when it is not in a block that scrolls sideways.
 */
export function revealCaretSideways(
  state: EditorState,
  viewport: ViewportState,
  point: ContentPoint,
): EditorState {
  const target = scrollTarget(state, viewport, point.blockId);
  if (!target?.node.revealSideways) return state;
  return target.node.revealSideways(target.c, point) ?? state;
}
