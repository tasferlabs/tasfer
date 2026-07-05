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

import type { EditorState, Position } from "../state-types";
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
  touchRadiusX: number;
  touchRadiusY: number;
  isTwoFingerScroll?: boolean;
}

/** Double/triple tap detection for touch (the mouse counterpart lives on state.view.clickTracker). */
export interface TouchTapTracker {
  lastTapTime: number;
  lastTapPosition: { x: number; y: number } | null;
  /**
   * Document position the previous tap resolved to. A multi-tap (word/line
   * select) anchors to this instead of re-resolving the current tap's screen
   * point: on Android the soft keyboard raised by the first tap reflows the
   * canvas, so by the second tap the same finger location maps to a different —
   * often empty — document position. Anchoring to where the first tap actually
   * landed keeps the target stable across that reflow.
   */
  lastTapDocPosition: Position | null;
  count: number;
}

/**
 * Click target for an off-screen peer indicator pill. Recomputed by the
 * renderer every cursor-layer paint (the geometry depends on this instance's
 * viewport/layout) and read back at click time by the peer-indicator region.
 * Per-instance, since two editors paint different indicators.
 */
export interface IndicatorHitArea {
  x: number;
  y: number;
  width: number;
  height: number;
  blockIndex: number;
  textIndex: number;
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
  /**
   * Click targets for off-screen peer-indicator pills, rewritten by the
   * renderer on every cursor-layer paint and read by the peer-indicator region
   * at click time. Per-instance so two editors don't clobber each other.
   */
  outOfViewIndicatorHitAreas: IndicatorHitArea[];
  /**
   * A host pointer-capturing menu (the context menu) is open. Content-free — the
   * engine never knows it's a context menu; it only needs the flag to arbitrate
   * focus (don't blur the editor while it's up) and touch (route drag/release to
   * the host instead of scrolling/selecting). The engine maintains it off the
   * menu's OPEN_CONTEXT_MENU / CLOSE_CONTEXT_MENU lifecycle actions — the host
   * never writes it directly, it just dispatches CLOSE_CONTEXT_MENU to dismiss.
   */
  hostMenuCapturing: boolean;
  /**
   * Magnifier loupe over a dragged selection handle. Set when a handle drag
   * begins; `shown` flips true once the hold outlives CURSOR_DRAG_ACTIVATION_DELAY
   * (so a quick adjust never flashes it) and gates the single CURSOR_DRAG_START.
   * `x`/`y` are the latest handle pointer (canvas coords), re-read every frame by
   * the loupe tick in handleEvents. Cleared (with a matching CURSOR_DRAG_END) when
   * the drag ends.
   */
  handleDragLoupe: {
    startTime: number;
    shown: boolean;
    x: number;
    y: number;
  } | null;
  /**
   * The RAW (pre-snap) focus position resolved on the previous frame of a
   * selection-handle drag. The construct snapper reads the finger's travel
   * DIRECTION to decide whether to take a math construct in or drop it; that
   * direction must come from the raw finger motion, not the snapped focus it
   * writes back — feeding the snapped focus back makes it oscillate between a
   * construct's two edges when the finger holds still near one, flickering the
   * selection between expand and shrink. Null between drags and on the first
   * frame (no travel history yet). Per-instance so two editors don't clobber.
   */
  handleDragPrevRawFocus: Position | null;
  /**
   * The raw hit-test position resolved on the PREVIOUS onMove frame of a
   * selection-handle drag — the row-hysteresis anchor fed back into the next
   * frame's drag hit-test ({@link ViewportHitOptions.prev}), exactly like the
   * single-caret magnifier drag anchors on the current caret. Unlike
   * `handleDragPrevRawFocus` (the snap-direction latch, pinned while the finger
   * is interior to a construct), this updates EVERY frame: hysteresis must
   * anchor on the row the finger's stop actually sits on, or a finger hovering
   * a fraction bar dithers between numerator and denominator — the snapper
   * turns that into a focus that flips between a slot-interior caret and the
   * whole construct's edge, bouncing the loupe. Null between drags.
   */
  handleDragPrevHit: Position | null;
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
      lastTapDocPosition: null,
      count: 0,
    },
    regions,
    captured: null,
    pendingCapture: null,
    outOfViewIndicatorHitAreas: [],
    hostMenuCapturing: false,
    handleDragLoupe: null,
    handleDragPrevRawFocus: null,
    handleDragPrevHit: null,
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

/**
 * Mark the scrollbar as freshly interacted-with so it stays visible. Applied by
 * drag interactions (scrollbar thumb, image resize) that should keep the
 * scrollbar awake. A pure `view` transform — lives here, alongside the other
 * interaction helpers, so node-layer drag handlers can reuse it without pulling
 * in the chrome-region module (which would cycle through `rendering/nodes`).
 */
export function withScrollbarInteraction(state: EditorState): EditorState {
  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: {
        ...state.view.scrollbar,
        lastInteraction: Date.now(),
      },
    },
  };
}

/** Kill any in-flight scroll momentum (e.g. when a drag interaction begins). */
export function withStoppedMomentum(state: EditorState): EditorState {
  return {
    ...state,
    view: {
      ...state.view,
      momentum: {
        velocity: 0,
        lastTime: Date.now(),
        isActive: false,
      },
    },
  };
}
