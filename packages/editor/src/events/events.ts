import {
  CURSOR_DRAG_MOVE,
  CURSOR_DRAG_START,
  OPEN_CONTEXT_MENU,
} from "../action-bus";
import { getSelectionRange } from "../actions/actions";
import {
  CONTEXT_MENU_DURATION,
  CURSOR_DRAG_ACTIVATION_DELAY,
} from "../constants";
import {
  applyMomentum,
  getScrollbarStyles,
  updateScrollbarFadeOpacity,
} from "../rendering/scrollbar";
import {
  getContentSelectionFromViewport,
  getTextPositionFromViewport,
} from "../selection";
import { hasActiveSelectionHighlight } from "../selection";
import { snapSelectionToConstructs, updateCursor } from "../selection";
import type {
  EditorEvent,
  EditorState,
  MouseEvent,
  Position,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import type { Operation } from "../state-types";
import { closeActiveMenu } from "../state-utils";
import { updateContentSelection } from "../structured-selection";
import { applyEdgeScroll } from "./autoScroll";
import {
  handleCompositionEnd,
  handleCompositionStart,
  handleCompositionUpdate,
} from "./compositionEvents";
import { isTouchDevice } from "./eventUtils";
import { handlePaste } from "./genericEvents";
import { type InteractionSession, stopAutoScroll } from "./interaction-session";
import { handleContextMenu, handleKeyDown } from "./keysEvents";
import {
  extendDragSelectionToPoint,
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
  handlePointerCancel,
  handleWheel,
} from "./mouseEvents";
import { tickPendingCapture } from "./regions";
import {
  handleTouchCancel,
  handleTouchEnd,
  handleTouchMove,
  handleTouchStart,
} from "./touchEvents";

/**
 * True when a canvas `mouseleave` is the pointer crossing *onto* host-rendered
 * editor chrome rather than genuinely leaving the editor surface. The host marks
 * its overlay layer with `data-editor-overlay`; an interactive overlay (the image
 * hover toolbar, the link tooltip) is DOM the pointer can only reach by crossing
 * the canvas boundary, so the hover state backing it must survive the traversal —
 * clearing it here would unmount the overlay before the cursor lands on it.
 *
 * Duck-typed against the raw DOM event so the headless test harness — which
 * dispatches bare `{ type }` objects with no `relatedTarget` — reads as "not
 * entering an overlay", and the normal hover-chrome clear still runs.
 */
function isEnteringEditorOverlay(event: EditorEvent): boolean {
  const related = (event as { relatedTarget?: unknown }).relatedTarget as {
    closest?: (selector: string) => unknown;
  } | null;
  return (
    related != null &&
    typeof related.closest === "function" &&
    related.closest("[data-editor-overlay]") != null
  );
}

export function handleEvents(
  state: EditorState,
  viewport: ViewportState,
  visibility: VisibleBlockRange,
  events: Event[],
  documentHeight: number,
  containerRect: { left: number; top: number },
  session: InteractionSession,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  clipboardData?: { html: string; text: string; imageFile: File | null } | null,
  scrollPositionIntoView?: (position: Position) => void,
): { state: EditorState; ops: Operation[]; pastedImageBlockIndex?: number } {
  // Collect operations from actions
  let collectedOps: Operation[] = [];
  let pastedImageBlockIndex: number | undefined;

  // The visibility snapshot is produced by the last paint. If the scroll has
  // advanced since then without an intervening repaint — e.g. a programmatic
  // scroll-into-view committed via scheduleRender, or a scroll restored by the
  // host — its `startY` no longer matches the live viewport. Every handler below
  // hit-tests pointer coordinates by walking from `visibility.startY`, so a
  // stale anchor maps the pointer to the wrong block/line and a click or drag
  // lands its selection anchor on the wrong row. Re-base the snapshot onto the
  // current scroll before anyone reads it. (`startY` is `paddingTop - scrollY +
  // offset`, so it shifts by the scroll delta.)
  if (
    visibility.scrollY !== undefined &&
    visibility.scrollY !== viewport.scrollY
  ) {
    visibility = {
      ...visibility,
      startY: visibility.startY + (visibility.scrollY - viewport.scrollY),
      scrollY: viewport.scrollY,
    };
  }

  // Edge auto-scroll advances the scroll position through
  // `updateViewportCallback`, which swaps the host's viewport for a new object —
  // our local `viewport` still points at the pre-scroll snapshot. Re-point it at
  // the freshly scrolled position so every drag position resolved below (and the
  // queued pointer events processed later this frame) sees the same scrollY the
  // next paint will use. Without this the selection focus is resolved one
  // frame's scroll delta behind the paint, so the selection visibly shrinks and
  // grows while auto-scrolling.
  const autoScroll = (pointerY: number, accelerate: boolean): void => {
    const newScrollY = applyEdgeScroll(
      pointerY,
      session,
      viewport,
      documentHeight,
      accelerate,
      updateViewportCallback,
    );
    if (newScrollY !== null) {
      const delta = newScrollY - viewport.scrollY;
      viewport = { ...viewport, scrollY: newScrollY };
      // The painted-visibility snapshot anchors the from-`startY` position walk
      // used by queued pointer moves this frame (handleMouseMove). Shift it by
      // the same delta (and advance its stamped scroll) so that path agrees with
      // the from-top auto-scroll path and with the scroll the next paint will
      // use — `startY` is `paddingTop - scrollY`, so a downward scroll lowers it.
      visibility = {
        ...visibility,
        startY: visibility.startY - delta,
        scrollY:
          visibility.scrollY !== undefined
            ? visibility.scrollY + delta
            : visibility.scrollY,
      };
    }
  };
  // Promote a pending hold-to-drag capture once its hold time has elapsed
  // (e.g. iOS-style scrollbar hold). Runs every frame, independent of events.
  const promoted = tickPendingCapture({
    state,
    viewport,
    documentHeight,
    session,
    updateViewport: updateViewportCallback,
  });
  if (promoted) {
    state = promoted;
  }

  // Fast magnifier: the touch started right on the caret (isTouchingCursor), so
  // grab it after a short 200ms hold — unambiguous, no need to wait out the
  // long-press window. A hold that starts *away* from the caret brings up the
  // same magnifier at the 600ms mark below (after snapping the caret to the
  // hold point).
  if (
    session.touch &&
    session.touch.isTouchingCursor &&
    !session.touch.isCursorDrag &&
    !session.touch.isLongPress &&
    !session.touch.hasMoved &&
    !session.captured &&
    !session.pendingCapture &&
    !state.ui.selectionHandleDrag
  ) {
    const timeSinceStart = Date.now() - session.touch.startTime;
    if (timeSinceStart >= CURSOR_DRAG_ACTIVATION_DELAY) {
      session.touch.isCursorDrag = true;
      state.actionBus.dispatch(CURSOR_DRAG_START, {
        touchX: session.touch.currentTouchX,
        touchY: session.touch.currentTouchY,
        touchRadiusX: session.touch.touchRadiusX,
        touchRadiusY: session.touch.touchRadiusY,
      });
    }
  }

  // Long-hold trigger (independent of touchmove events). What it does depends on
  // what's under the finger:
  //  - on an existing selection → open the context menu immediately;
  //  - on non-selected content (editable) → snap the caret to the hit-tested
  //    point and bring up the magnifier (cursor-drag), so the loupe is reachable
  //    from anywhere a tap is — including a line edge/end where no caret sits —
  //    not only when the finger starts on the caret. Releasing without a drag
  //    opens the context menu (handleTouchEnd's isCursorDrag branch).
  //  - readonly, or no resolvable position → plain long-press, context menu on
  //    release.
  if (
    session.touch &&
    !session.touch.isLongPress &&
    !session.touch.isCursorDrag && // Don't re-trigger once a cursor drag is active
    !session.touch.hasMoved &&
    !session.captured && // Not while a region drag owns the pointer (image resize, …)
    !session.pendingCapture && // ... or is waiting on its hold timer
    !state.ui.selectionHandleDrag // Don't take over while dragging a selection handle
  ) {
    const timeSinceStart = Date.now() - session.touch.startTime;
    if (timeSinceStart >= CONTEXT_MENU_DURATION) {
      const position = getTextPositionFromViewport(
        session.touch.currentTouchX,
        session.touch.currentTouchY,
        state,
        viewport,
        undefined,
        visibility,
      );
      const contentSelection = getContentSelectionFromViewport(
        session.touch.currentTouchX,
        session.touch.currentTouchY,
        state,
        viewport,
        "touch",
        undefined,
        visibility,
      );

      if (session.touch.isTouchingSelection) {
        // On selected text: show the context menu immediately.
        session.touch.isLongPress = true;
        if (
          position &&
          !state.document.selection &&
          !state.document.contentSelection
        ) {
          state = updateCursor(state, position);
        }

        // Clear link hover tooltip and slash menu when opening context menu
        state = closeActiveMenu({
          ...state,
          ui: {
            ...state.ui,
            isHoveringLinkWithModifier: false,
          },
        });

        // Headless: signal the host to show its menu (canvas coords; the host
        // adds its container rect). The engine flips its own capture flag off
        // this action, which the touch FSM reads to route the drag/release.
        state.actionBus.dispatch(OPEN_CONTEXT_MENU, {
          x: session.touch.currentTouchX,
          y: session.touch.currentTouchY,
          hasSelection: !!getSelectionRange(state),
        });
      } else if (
        state.ui.mode !== "readonly" &&
        position &&
        !hasActiveSelectionHighlight(state)
      ) {
        // On non-selected content with only a caret in play: snap the caret here
        // and enter the magnifier cursor-drag. Suppressed while a selection is up
        // (a range, or a visual/atomic block) — the loupe only moves a caret, so
        // a hold there falls through to the plain context-menu long-press below.
        // The drag-move / hold-to-menu-on-release behavior is then owned by the
        // shared isCursorDrag branches (handleTouchMove/End).
        const nested = contentSelection
          ? updateContentSelection(state, contentSelection)
          : state;
        state = nested.document.contentSelection
          ? nested
          : updateCursor(state, position);
        state = closeActiveMenu({
          ...state,
          ui: {
            ...state.ui,
            isHoveringLinkWithModifier: false,
          },
        });
        session.touch.isCursorDrag = true;
        state.actionBus.dispatch(CURSOR_DRAG_START, {
          touchX: session.touch.currentTouchX,
          touchY: session.touch.currentTouchY,
          touchRadiusX: session.touch.touchRadiusX,
          touchRadiusY: session.touch.touchRadiusY,
        });
      } else {
        // Readonly (no caret editing) or no resolvable position: fall back to a
        // plain long-press that opens the context menu on release.
        session.touch.isLongPress = true;
        if (position) {
          state = updateCursor(state, position);
        }
        state = closeActiveMenu({
          ...state,
          ui: {
            ...state.ui,
            isHoveringLinkWithModifier: false,
          },
        });
      }
    }
  }

  // Drive the magnifier loupe over a dragged selection handle. A handle drag is a
  // captured region (no session.touch), so its loupe lives here: once the handle
  // has been held past the activation delay, show the loupe and keep it tracking
  // the latest handle pointer (kept current by the drag's onMove / the edge
  // auto-scroll below). The matching CURSOR_DRAG_END is emitted by the handle
  // drag's onEnd/onCancel.
  if (session.handleDragLoupe && state.ui.selectionHandleDrag) {
    const loupe = session.handleDragLoupe;
    const dragPayload = {
      touchX: loupe.x,
      touchY: loupe.y,
      touchRadiusX: 0,
      touchRadiusY: 0,
    };
    if (!loupe.shown) {
      if (Date.now() - loupe.startTime >= CURSOR_DRAG_ACTIVATION_DELAY) {
        loupe.shown = true;
        state.actionBus.dispatch(CURSOR_DRAG_START, dragPayload);
      }
    } else {
      state.actionBus.dispatch(CURSOR_DRAG_MOVE, dragPayload);
    }
  }

  // Apply edge auto-scroll while a drag holds at the viewport edge, re-resolving
  // whatever the active gesture tracks (selection focus, handle, or caret).
  if (session.autoScroll.isActive && state.ui.mode === "select") {
    // Apply auto-scroll for mouse selection
    autoScroll(session.autoScroll.lastPointerY, true);

    // Update selection based on new scroll position
    // Resolve against the re-pointed `viewport` (autoScroll already advanced its
    // scrollY this frame), whose default `paddingTop - scrollY` anchor is the
    // post-scroll painted top. Model-aware: a drag inside structured content
    // (tree math) extends its nested contentSelection — flat re-resolution here
    // would destroy it on every edge frame (see extendDragSelectionToPoint).
    state =
      extendDragSelectionToPoint(
        state,
        session.autoScroll.lastPointerX,
        session.autoScroll.lastPointerY,
        viewport,
      ) ?? state;
  } else if (session.autoScroll.isActive && state.ui.selectionHandleDrag) {
    // Apply auto-scroll for selection handle drag (touch)
    autoScroll(session.autoScroll.lastPointerY, true);

    // Keep the loupe tracking the held-at-edge finger while content scrolls.
    if (session.handleDragLoupe) {
      session.handleDragLoupe.x = session.autoScroll.lastPointerX;
      session.handleDragLoupe.y = session.autoScroll.lastPointerY;
    }

    // Update selection based on new scroll position
    // Resolve against the re-pointed `viewport` (autoScroll already advanced its
    // scrollY this frame), whose default `paddingTop - scrollY` anchor is the
    // post-scroll painted top.
    //
    // Same drag resolution + hysteresis anchor as the handle region's onMove —
    // this tick runs EVERY frame while the finger is within the edge zone, so a
    // tap-path resolution here silently overwrites the drag path's result each
    // frame; over stacked math rows the two disagree and the focus (and loupe)
    // flicker between them.
    const position = getTextPositionFromViewport(
      session.autoScroll.lastPointerX,
      session.autoScroll.lastPointerY,
      state,
      viewport,
      undefined,
      undefined,
      { drag: true, prev: session.handleDragPrevHit },
    );
    if (position) session.handleDragPrevHit = position;

    if (position && state.document.selection) {
      // The dragged handle is always the focus (set up in the handle region's
      // onStart); the anchor is the opposite, fixed endpoint. Snap through the
      // same construct snapper as the region's onMove (same direction latch),
      // so an edge-held drag agrees with the move path about construct
      // coverage instead of flickering raw↔snapped.
      const { anchor: rawAnchor } = state.document.selection;
      const { anchor, focus: newFocus } = snapSelectionToConstructs(
        state,
        rawAnchor,
        position,
        session.handleDragPrevRawFocus ?? undefined,
      );
      if (
        newFocus.blockIndex === position.blockIndex &&
        newFocus.textIndex === position.textIndex
      ) {
        session.handleDragPrevRawFocus = position;
      }

      const isForward =
        anchor.blockIndex < newFocus.blockIndex ||
        (anchor.blockIndex === newFocus.blockIndex &&
          anchor.textIndex <= newFocus.textIndex);

      const isCollapsed =
        anchor.blockIndex === newFocus.blockIndex &&
        anchor.textIndex === newFocus.textIndex;

      state = {
        ...state,
        document: {
          ...state.document,
          selection: {
            anchor,
            focus: newFocus,
            isForward,
            isCollapsed,
            lastUpdate: Date.now(),
          },
          cursor: {
            position: newFocus,
            lastUpdate: Date.now(),
          },
        },
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }
  } else if (session.autoScroll.isActive && session.touch?.isCursorDrag) {
    // Apply auto-scroll for cursor drag (touch)
    autoScroll(session.autoScroll.lastPointerY, true);

    // Update cursor position based on new scroll position
    // Resolve against the re-pointed `viewport` (autoScroll already advanced its
    // scrollY this frame), whose default `paddingTop - scrollY` anchor is the
    // post-scroll painted top.
    //
    // Same drag resolution + hysteresis anchor as the touchmove caret drag —
    // this tick runs EVERY frame while the finger is within the edge zone
    // (even when the scroll is clamped at the document ends), so a tap-path
    // resolution here silently overwrites the drag path's caret each frame;
    // over stacked math rows the two disagree and the caret (and magnifier)
    // bounce between rows — the reported jitter.
    const position = getTextPositionFromViewport(
      session.autoScroll.lastPointerX,
      session.autoScroll.lastPointerY,
      state,
      viewport,
      undefined,
      undefined,
      { drag: true, prev: state.document.cursor?.position ?? null },
    );

    if (position) {
      state = updateCursor(state, position);

      state.actionBus.dispatch(CURSOR_DRAG_MOVE, {
        touchX: session.touch.currentTouchX,
        touchY: session.touch.currentTouchY,
        touchRadiusX: session.touch.touchRadiusX,
        touchRadiusY: session.touch.touchRadiusY,
      });
    }
  } else if (
    session.autoScroll.isActive &&
    session.captured?.region.drag?.onAutoScrollTick
  ) {
    // A region drag (e.g. image resize) owns the pointer and participates in edge
    // auto-scroll. The drag owns the *decision* (whether to keep scrolling, and
    // how to re-apply itself once scrolled); the event layer keeps the scroll
    // *mechanics*. No block type named here.
    const drag = session.captured.region.drag;
    const onAutoScrollTick = session.captured.region.drag.onAutoScrollTick;
    const p = {
      x: session.autoScroll.lastPointerX,
      y: session.autoScroll.lastPointerY,
    };
    const ctx = {
      state,
      viewport,
      documentHeight,
      visibility,
      session,
      updateViewport: updateViewportCallback,
    };
    const { blockScroll } = onAutoScrollTick(p, ctx);
    if (blockScroll) {
      stopAutoScroll(session);
    } else {
      // Constant speed (no acceleration for region drags)
      const newScrollY = applyEdgeScroll(
        p.y,
        session,
        viewport,
        documentHeight,
        false,
        updateViewportCallback,
      );
      if (newScrollY !== null && drag.onAutoScrollScrolled) {
        state = drag.onAutoScrollScrolled(
          p,
          newScrollY - viewport.scrollY,
          ctx,
        );
      }
    }
  }

  // Apply momentum scrolling if active (even when no events)
  // But not in suspended mode
  if (state.view.momentum.isActive && state.ui.mode !== "suspended") {
    const momentumResult = applyMomentum(
      viewport.scrollY,
      state.view.momentum,
      documentHeight,
      viewport.height,
    );

    if (updateViewportCallback && momentumResult.scrollY !== viewport.scrollY) {
      updateViewportCallback({ scrollY: momentumResult.scrollY });
    }

    state = {
      ...state,
      view: {
        ...state.view,
        momentum: momentumResult.momentumState,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
      ui: {
        ...state.ui,
        isHoveringLinkWithModifier: false,
        imageHover: null,
        linkHover: null,
        inlineMathHover: null,
        hoveredMathBlockIndex: null,
      },
    };
  }

  if (events.length === 0) {
    // Update scrollbar fade opacity even when no events
    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: updateScrollbarFadeOpacity(
          state.view.scrollbar,
          getScrollbarStyles(state),
        ),
      },
    };

    return { state, ops: collectedOps };
  }

  while (events.length > 0) {
    const event = events[0];
    switch (event.type) {
      case "contextmenu":
        state = handleContextMenu(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect,
          session,
        );
        break;
      case "mouseleave":
        if (isTouchDevice()) {
          break;
        }
        // The pointer is crossing onto a host-rendered interactive overlay (the
        // image hover toolbar, the link tooltip), not actually leaving the editor.
        // Tearing down hover chrome now would unmount the very thing the cursor is
        // reaching — leave the state untouched and let the overlay own its own
        // dismissal. See `isEnteringEditorOverlay`.
        if (isEnteringEditorOverlay(event)) {
          break;
        }
        // A genuine canvas exit. Non-interactive hover chrome (image resize
        // handles, math highlights) is only ever cleared by a *subsequent*
        // mousemove over a non-matching block — which never arrives once the
        // cursor is gone — so it would otherwise stay painted (e.g. image
        // handles stuck visible). Drop those here. A selected image keeps its
        // handles via the selection gate, not this state.
        //
        // `imageHover` backs the hover toolbar too, but that overlay is handled
        // by the early return above: a real exit (the cursor heading off to the
        // sidebar, not onto the toolbar) should both hide the handles and dismiss
        // the toolbar, so it clears here like the other hover chrome.
        //
        // `linkHover` is deliberately NOT cleared even on a real exit: the link
        // tooltip lingers via the host's own pointer-leave and the off-link
        // hysteresis in `computeLinkHover`, matching the old behavior.
        state = {
          ...state,
          ui: {
            ...state.ui,
            isHoveringLinkWithModifier: false,
            imageHover: null,
            inlineMathHover: null,
            hoveredMathBlockIndex: null,
          },
        };
        break;
      case "mousedown":
        if (isTouchDevice()) {
          break;
        }
        const mouseDownResult = handleMouseDown(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect,
          documentHeight,
          session,
          visibility,
          updateViewportCallback,
          scrollPositionIntoView,
        );
        state = mouseDownResult.state;
        collectedOps.push(...mouseDownResult.ops);
        break;
      case "mousemove":
        if (isTouchDevice()) {
          break;
        }
        state = handleMouseMove(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect,
          documentHeight,
          session,
          visibility,
          updateViewportCallback,
        );
        break;
      case "mouseup":
        if (isTouchDevice()) {
          break;
        }
        const mouseUpResult = handleMouseUp(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility,
          documentHeight,
          session,
        );
        state = mouseUpResult.state;
        collectedOps.push(...mouseUpResult.ops);
        break;
      case "pointercancel":
        // Only cancel on pointercancel (not on leave)
        state = handlePointerCancel(state, viewport, documentHeight, session);
        break;
      case "keydown":
        const keyResult = handleKeyDown(
          state,
          viewport,
          event,
          updateViewportCallback,
          visibility,
        );
        state = keyResult.state;
        collectedOps.push(...keyResult.ops);
        break;
      case "paste":
        const pasteResult = handlePaste(
          state,
          event as ClipboardEvent,
          viewport,
          updateViewportCallback,
          clipboardData,
        );
        state = pasteResult.state;
        collectedOps.push(...pasteResult.ops);
        if (pasteResult.pastedImageBlockIndex !== undefined) {
          pastedImageBlockIndex = pasteResult.pastedImageBlockIndex;
        }
        break;
      case "wheel":
        if (isTouchDevice()) {
          break;
        }
        state = handleWheel(
          state,
          viewport,
          event as WheelEvent,
          documentHeight,
          updateViewportCallback,
        );
        break;
      case "touchstart":
        state = handleTouchStart(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight,
          session,
          visibility,
        );
        break;
      case "touchmove":
        state = handleTouchMove(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight,
          session,
          updateViewportCallback,
          visibility,
        );
        break;
      case "touchend":
        const touchEndResult = handleTouchEnd(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight,
          session,
          updateViewportCallback,
          scrollPositionIntoView,
          visibility,
        );
        state = touchEndResult.state;
        collectedOps.push(...touchEndResult.ops);
        break;
      case "touchcancel":
        // Cancel touch interaction
        state = handleTouchCancel(state, viewport, documentHeight, session);
        break;
      case "compositionstart":
        const compStartResult = handleCompositionStart(
          state,
          event as CompositionEvent,
        );
        state = compStartResult.state;
        collectedOps.push(...compStartResult.ops);
        break;
      case "compositionupdate":
        const compUpdateResult = handleCompositionUpdate(
          state,
          event as CompositionEvent,
        );
        state = compUpdateResult.state;
        collectedOps.push(...compUpdateResult.ops);
        break;
      case "compositionend":
        const compResult = handleCompositionEnd(
          state,
          event as CompositionEvent,
          viewport,
          updateViewportCallback,
        );
        state = compResult.state;
        collectedOps.push(...compResult.ops);
        break;
    }

    events.shift();
  }

  // Update scrollbar fade opacity
  state = {
    ...state,
    view: {
      ...state.view,
      scrollbar: updateScrollbarFadeOpacity(
        state.view.scrollbar,
        getScrollbarStyles(state),
      ),
    },
  };

  return { state, ops: collectedOps, pastedImageBlockIndex };
}
