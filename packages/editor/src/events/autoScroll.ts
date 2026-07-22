/**
 * Shared edge-of-viewport auto-scroll math — the one implementation of the
 * speed/acceleration curve used by every drag interaction (text selection,
 * selection handles, cursor drag, image resize). Previously this curve was
 * copy-pasted per interaction in events.ts.
 */

import {
  EDGE_SCROLL_ACCELERATION_RATE,
  EDGE_SCROLL_MAX_SPEED,
  EDGE_SCROLL_SPEED,
  EDGE_SCROLL_THRESHOLD,
} from "../constants";
import type { ViewportState } from "../state-types";
import type { InteractionSession } from "./interaction-session";

/**
 * Scroll delta (px) for a pointer at viewport-y `y`.
 *
 * Zero when the pointer is inside the viewport and away from both edges.
 * Within EDGE_SCROLL_THRESHOLD of an edge, speed scales with proximity;
 * outside the viewport it scales with overshoot distance. With `accelerate`,
 * the result additionally ramps up the longer the auto-scroll has been
 * running (capped at EDGE_SCROLL_MAX_SPEED). Image resize uses the
 * non-accelerated curve: constant base speed, proximity-scaled at the edge.
 */
export function edgeScrollDelta(
  y: number,
  viewportHeight: number,
  opts: { accelerate: boolean; elapsedMs: number },
): number {
  const timeMultiplier = opts.accelerate
    ? Math.min(
        Math.pow(EDGE_SCROLL_ACCELERATION_RATE, opts.elapsedMs / 1000),
        EDGE_SCROLL_MAX_SPEED / EDGE_SCROLL_SPEED,
      )
    : 1;

  if (y < 0) {
    const distanceBoost = opts.accelerate
      ? 1 + Math.min(Math.abs(y) / 100, 3)
      : 1;
    return -EDGE_SCROLL_SPEED * distanceBoost * timeMultiplier;
  }
  if (y < EDGE_SCROLL_THRESHOLD) {
    const proximity = 1 - y / EDGE_SCROLL_THRESHOLD;
    return -EDGE_SCROLL_SPEED * proximity * timeMultiplier;
  }
  if (y > viewportHeight) {
    const distanceBoost = opts.accelerate
      ? 1 + Math.min((y - viewportHeight) / 100, 3)
      : 1;
    return EDGE_SCROLL_SPEED * distanceBoost * timeMultiplier;
  }
  if (y > viewportHeight - EDGE_SCROLL_THRESHOLD) {
    const proximity =
      (y - (viewportHeight - EDGE_SCROLL_THRESHOLD)) / EDGE_SCROLL_THRESHOLD;
    return EDGE_SCROLL_SPEED * proximity * timeMultiplier;
  }
  return 0;
}

/**
 * Compute the edge-scroll delta for the current frame and apply it via
 * `updateViewportCallback`, clamped to the document bounds.
 *
 * Returns the new scrollY when the viewport actually moved, else null —
 * callers that need to compensate for the scroll (e.g. image resize adjusting
 * its drag origin) branch on the return value.
 */
export function applyEdgeScroll(
  y: number,
  session: InteractionSession,
  viewport: ViewportState,
  documentHeight: number,
  accelerate: boolean,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): number | null {
  const delta = edgeScrollDelta(y, viewport.height, {
    accelerate,
    elapsedMs: Date.now() - session.autoScroll.startTime,
  });
  if (delta === 0 || !updateViewportCallback) return null;

  const maxScroll = documentHeight - viewport.height;
  const newScrollY = Math.max(0, Math.min(maxScroll, viewport.scrollY + delta));
  if (newScrollY === viewport.scrollY) return null;

  updateViewportCallback({ scrollY: newScrollY });
  return newScrollY;
}
