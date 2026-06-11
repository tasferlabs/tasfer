/**
 * InteractionSession — per-editor-instance pointer interaction state.
 *
 * Everything in here used to be module-level mutable state (the former
 * events/eventsState.ts, plus `touchState`/`touchTapTracker` in
 * touchEvents.ts). Module globals are shared across every editor on the page,
 * so two mounted editors would clobber each other's in-flight gestures. The
 * session is created once per editor (entries/editor.ts) and threaded through
 * handleEvents into the mouse/touch handlers.
 *
 * The session is deliberately mutable: it tracks an in-flight gesture between
 * events/frames. It is not part of EditorState — it never participates in
 * undo, rendering diffs, or subscriber notifications.
 */

import type { Region, RegionRegistry } from "./regions";

/** Edge-of-viewport auto-scroll engaged during a drag (selection, image resize, …). */
export interface AutoScrollState {
  isActive: boolean;
  /** When auto-scroll engaged — drives the time-based acceleration curve. */
  startTime: number;
  /** Last pointer position (canvas coords), re-applied every frame while scrolling. */
  lastPointerX: number;
  lastPointerY: number;
}

/** Live single/two-finger touch gesture. Null when no touch is down. */
export interface TouchState {
  startY: number;
  startScrollY: number;
  lastY: number;
  lastTime: number;
  velocityY: number;
  velocityHistory: Array<{ velocity: number; time: number }>;
  startX: number;
  startTime: number;
  isLongPress: boolean;
  hasMoved: boolean;
  currentTouchX: number;
  currentTouchY: number;
  isTouchingSelection: boolean;
  isTouchingCursor: boolean;
  isCursorDrag: boolean;
  touchRadiusY: number;
  isTwoFingerScroll?: boolean;
}

/** Double/triple tap detection for touch (the mouse counterpart lives on state.view.clickTracker). */
export interface TouchTapTracker {
  lastTapTime: number;
  lastTapPosition: { x: number; y: number } | null;
  count: number;
}

export interface InteractionSession {
  autoScroll: AutoScrollState;
  touch: TouchState | null;
  tapTracker: TouchTapTracker;
  /** This editor's interactive regions (chrome + future custom regions). */
  readonly regions: RegionRegistry;
  /** Region that owns the live pointer — all moves/ups route here until release. */
  captured: { region: Region; hit: unknown } | null;
  /**
   * Drag waiting on its touch hold timer (e.g. iOS-style scrollbar hold).
   * Promoted to `captured` by tickPendingCapture; cancelled by movement
   * past the threshold or pointer release.
   */
  pendingCapture: {
    region: Region;
    hit: unknown;
    startTime: number;
    x: number;
    y: number;
  } | null;
}

export function createInteractionSession(
  regions: RegionRegistry,
): InteractionSession {
  return {
    autoScroll: {
      isActive: false,
      startTime: 0,
      lastPointerX: 0,
      lastPointerY: 0,
    },
    touch: null,
    tapTracker: {
      lastTapTime: 0,
      lastTapPosition: null,
      count: 0,
    },
    regions,
    captured: null,
    pendingCapture: null,
  };
}

export function startAutoScroll(session: InteractionSession): void {
  if (!session.autoScroll.isActive) {
    session.autoScroll.isActive = true;
    session.autoScroll.startTime = Date.now();
  }
}

export function stopAutoScroll(session: InteractionSession): void {
  session.autoScroll.isActive = false;
  session.autoScroll.startTime = 0;
}

export function isInLongPressMode(session: InteractionSession): boolean {
  return session.touch?.isLongPress === true;
}
