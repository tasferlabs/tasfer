/**
 * Hit regions — the contract for interactive areas on the canvas.
 *
 * A region owns its own hit detection and its semantic handlers (tap, drag),
 * decoupled from the hardware event source: the same region works for mouse
 * and touch, with per-pointer-type hit slop inside its own `hitTest`. Editor
 * chrome (scrollbar, selection handles, peer indicators) registers regions in
 * a per-instance {@link RegionRegistry}; block content contributes regions via
 * the node layer.
 *
 * Handlers follow the same functional contract as the rest of the event
 * layer: they receive a {@link RegionCtx} and return new state (+ CRDT ops),
 * never mutating EditorState. Returning `null` declines the interaction and
 * the pointer falls through to the next region / the document fallback
 * (text selection, scrolling).
 *
 * Capture model: when a region's drag starts, it is recorded on
 * `session.captured` and every subsequent move/up/cancel routes to it until
 * release — drags can't be stolen mid-gesture. A drag with `touchHoldMs` (the
 * iOS-style scrollbar hold) first sits on `session.pendingCapture`; while
 * pending, events still flow to the fallback (so the document keeps
 * scrolling), and {@link tickPendingCapture} promotes it to a real capture
 * once the pointer has been held still long enough.
 */

import { REGION_DRAG_START } from "../action-bus";
import type { EditorState, ViewportState } from "../state-types";
import type { Operation } from "../sync/sync";
import type { InteractionSession } from "./interaction-session";

export type PointerType = "mouse" | "touch";

/** A pointer position in canvas coordinates. */
export interface RegionPoint {
  x: number;
  y: number;
}

export interface RegionCtx {
  readonly state: EditorState;
  readonly viewport: ViewportState;
  readonly documentHeight: number;
  readonly session: InteractionSession;
  readonly updateViewport?: (viewport: Partial<ViewportState>) => void;
}

/** `null` declines — the pointer falls through to whatever is underneath. */
export type RegionResult = {
  state: EditorState;
  ops?: Operation[];
} | null;

export interface RegionDragSpec {
  /**
   * Touch only: the pointer must be held still this long (ms) before the drag
   * activates. While pending, the touch behaves normally (scroll/tap); moving
   * past the movement threshold cancels the hold.
   */
  touchHoldMs?: number;
  /**
   * Interaction-salience hint forwarded as `REGION_DRAG_START.intensity` when a
   * `touchHoldMs` hold promotes to a drag. A host maps it to haptics/sound/etc.
   * — the engine no longer fires haptics itself.
   */
  activationIntensity?: "light" | "medium" | "heavy";
  /** Return null to decline — the pointer falls through uncaptured. */
  onStart(hit: unknown, p: RegionPoint, ctx: RegionCtx): RegionResult;
  onMove(p: RegionPoint, ctx: RegionCtx): RegionResult;
  /** `p` is null when the release position is unknown (e.g. window-level mouseup). */
  onEnd(p: RegionPoint | null, ctx: RegionCtx): RegionResult;
  onCancel(ctx: RegionCtx): EditorState;
  /**
   * Optional: while this drag owns the pointer and edge auto-scroll is active,
   * the frame loop calls this each tick (before scrolling) to ask whether the
   * drag wants to block further scrolling — e.g. an image resize stops scrolling
   * down once the image is at its natural max height. Keeps the auto-scroll
   * *mechanics* (applyEdgeScroll) in the event layer while the drag owns the
   * *decision*. `p` is the last pointer position (canvas coords).
   */
  onAutoScrollTick?(p: RegionPoint, ctx: RegionCtx): { blockScroll: boolean };
  /**
   * Optional: called after the frame loop actually scrolled by `scrollDelta`
   * (px), so the drag can re-apply itself against the new scroll position
   * (an image resize re-derives its dimensions). Returns the updated state.
   */
  onAutoScrollScrolled?(
    p: RegionPoint,
    scrollDelta: number,
    ctx: RegionCtx,
  ): EditorState;
}

export interface Region {
  id: string;
  /** Higher wins when several regions contain the point. */
  priority: number;
  /**
   * Editor modes this region is active in. Defaults to ["edit", "select"];
   * include "readonly" for regions that must work in read-only documents
   * (e.g. scrolling). Suspended mode disables all regions.
   */
  modes?: readonly ("edit" | "select" | "readonly")[];
  /**
   * Lazy hit test against CURRENT layout/state. Returns arbitrary hit data
   * (passed back into handlers) or null. Apply pointer-type hit slop here.
   */
  hitTest(
    p: RegionPoint,
    pointerType: PointerType,
    ctx: RegionCtx,
  ): unknown | null;
  onTap?(
    hit: unknown,
    p: RegionPoint,
    tapCount: number,
    ctx: RegionCtx,
  ): RegionResult;
  drag?: RegionDragSpec;
}

const DEFAULT_MODES: readonly string[] = ["edit", "select"];

/**
 * Per-editor-instance set of interactive regions, ordered by priority.
 * Mirrors NodeRegistry: each editor owns its own registry so hosts can
 * compose custom region sets without affecting other editors on the page.
 */
export class RegionRegistry {
  private readonly regions: Region[] = [];

  register(region: Region): this {
    this.regions.push(region);
    // Stable sort: equal priorities keep registration order.
    this.regions.sort((a, b) => b.priority - a.priority);
    return this;
  }

  all(): readonly Region[] {
    return this.regions;
  }
}

export interface RegionClaim {
  region: Region;
  hit: unknown;
}

/**
 * Find the highest-priority region containing the point, if any.
 * `extraRegions` lets callers merge in lazily-discovered regions (the block
 * content's node regions) — they compete with chrome purely on priority.
 */
export function hitTestRegions(
  p: RegionPoint,
  pointerType: PointerType,
  ctx: RegionCtx,
  extraRegions: readonly Region[] = [],
): RegionClaim | null {
  const mode = ctx.state.ui.mode;
  if (mode === "suspended") return null;
  const candidates = extraRegions.length
    ? [...ctx.session.regions.all(), ...extraRegions].sort(
        (a, b) => b.priority - a.priority,
      )
    : ctx.session.regions.all();
  for (const region of candidates) {
    const modes = region.modes ?? DEFAULT_MODES;
    if (!modes.includes(mode)) continue;
    const hit = region.hitTest(p, pointerType, ctx);
    if (hit !== null && hit !== undefined && hit !== false) {
      return { region, hit };
    }
  }
  return null;
}

/**
 * Begin an interaction with the claimed region on pointer-down.
 *
 * - Drag with a touch hold requirement → records a pending capture and
 *   returns "pending"; the caller proceeds as if unclaimed until
 *   {@link tickPendingCapture} promotes it.
 * - Drag → onStart; on success the pointer is captured.
 * - Tap-only region → onTap fires immediately (mouse acts on down; touch taps
 *   are delivered by the touch handler on release).
 * - A `null` result means the region declined — fall through.
 */
export function beginRegionInteraction(
  claim: RegionClaim,
  p: RegionPoint,
  pointerType: PointerType,
  ctx: RegionCtx,
): RegionResult | "pending" {
  const { region, hit } = claim;
  if (region.drag) {
    if (pointerType === "touch" && region.drag.touchHoldMs) {
      ctx.session.pendingCapture = {
        region,
        hit,
        startTime: Date.now(),
        x: p.x,
        y: p.y,
      };
      return "pending";
    }
    const result = region.drag.onStart(hit, p, ctx);
    if (result) {
      ctx.session.captured = { region, hit };
    }
    return result;
  }
  if (region.onTap) {
    return region.onTap(hit, p, 1, ctx);
  }
  return null;
}

/**
 * Promote a pending hold capture to an active drag once its hold time has
 * elapsed. Called every frame from handleEvents (which runs even without
 * events). Returns the new state when activation happened, else null.
 */
export function tickPendingCapture(ctx: RegionCtx): EditorState | null {
  const pending = ctx.session.pendingCapture;
  if (!pending?.region.drag) return null;
  const holdMs = pending.region.drag.touchHoldMs ?? 0;
  if (Date.now() - pending.startTime < holdMs) return null;

  ctx.session.pendingCapture = null;
  if (pending.region.drag.activationIntensity) {
    ctx.state.actionBus.dispatch(REGION_DRAG_START, {
      regionId: pending.region.id,
      intensity: pending.region.drag.activationIntensity,
    });
  }
  const result = pending.region.drag.onStart(
    pending.hit,
    { x: pending.x, y: pending.y },
    ctx,
  );
  if (result) {
    ctx.session.captured = { region: pending.region, hit: pending.hit };
    return result.state;
  }
  return null;
}

/** Route a pointer move to the capturing region's drag, if any. */
export function routeCapturedMove(
  p: RegionPoint,
  ctx: RegionCtx,
): RegionResult {
  const captured = ctx.session.captured;
  if (!captured?.region.drag) return null;
  return captured.region.drag.onMove(p, ctx);
}

/** Route pointer release to the capturing region and release the capture. */
export function routeCapturedEnd(
  p: RegionPoint | null,
  ctx: RegionCtx,
): RegionResult {
  const captured = ctx.session.captured;
  ctx.session.captured = null;
  ctx.session.pendingCapture = null;
  if (!captured?.region.drag) return null;
  return captured.region.drag.onEnd(p, ctx);
}

/** Route pointer cancel to the capturing region and release the capture. */
export function routeCapturedCancel(ctx: RegionCtx): EditorState | null {
  const captured = ctx.session.captured;
  ctx.session.captured = null;
  ctx.session.pendingCapture = null;
  if (!captured?.region.drag) return null;
  return captured.region.drag.onCancel(ctx);
}
