import {
  CLOSE_CONTEXT_MENU,
  CONTEXT_MENU_POINTER_MOVE,
  CONTEXT_MENU_RELEASE,
  CURSOR_DRAG_BOUNDARY,
  CURSOR_DRAG_END,
  CURSOR_DRAG_MOVE,
} from "../action-bus";
import {
  createParagraphAboveOnClick,
  createParagraphBelowOnClick,
} from "../actions/edit-actions";
import { TEXT_CLICK } from "../actions/pointer-actions";
import {
  CLOSE_NODE_OVERLAY,
  FINISH_SELECT_MODE,
  isVisualBlockSelection,
  OPEN_CONTEXT_MENU_AT,
  OPEN_NODE_OVERLAY,
  TAP_CLEAR_VISUAL_BLOCK_SELECTION,
  TAP_OUTSIDE_CONTENT,
  TAP_PLACE_CURSOR,
  TAP_SELECT_LINE,
  TAP_SELECT_VISUAL_BLOCK,
  TAP_SELECT_WORD,
  TAP_SIDE_PADDING,
  TAP_TOP_PADDING,
} from "../actions/touch-actions";
import {
  CURSOR_TOUCH_RADIUS,
  DOUBLE_CLICK_TIME,
  EDGE_SCROLL_THRESHOLD,
  MOVEMENT_THRESHOLD,
  TAP_DISTANCE_THRESHOLD,
  TAP_MAX_DURATION,
  TAP_MOVE_TOLERANCE,
} from "../constants";
import { endScrollbarDrag } from "../rendering/scrollbar";
import {
  getCursorDocumentCoords,
  getTextPositionFromViewport,
  isPointWithinSelectionRects,
} from "../selection";
import { updateCursor } from "../selection";
import { startSelection } from "../selection";
import type { EditorState, Position, ViewportState } from "../state-types";
import { closeActiveMenu, updateMode } from "../state-utils";
import { getEditorStyles } from "../styles";
import { isTextualBlock } from "../sync/block-registry";
import type { Operation } from "../sync/sync";
import { hitTestAllRegions } from "./blockRegions";
import { getAtomicBlockAtPoint, isWithinClickDistance } from "./eventUtils";
import {
  type InteractionSession,
  startAutoScroll,
  stopAutoScroll,
} from "./interaction-session";
import {
  beginRegionInteraction,
  type RegionCtx,
  routeCapturedCancel,
  routeCapturedEnd,
  routeCapturedMove,
} from "./regions";

export function handleTouchStart(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  containerRect: { left: number; top: number },
  documentHeight: number,
  session: InteractionSession,
): EditorState {
  // In suspended mode, block touch interactions that might lead to scrolling
  if (state.ui.mode === "suspended") {
    return state;
  }

  // Handle two-finger scroll
  if (event.touches.length === 2) {
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();

    // Calculate average position of both fingers
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;

    session.touch = {
      startY: avgY,
      startScrollY: viewport.scrollY,
      lastY: avgY,
      lastTime: currentTime,
      velocityY: 0,
      velocityHistory: [],
      startX: (touch1.clientX + touch2.clientX) / 2 - containerRect.left,
      startTime: currentTime,
      isLongPress: false,
      hasMoved: false,
      currentTouchX: (touch1.clientX + touch2.clientX) / 2 - containerRect.left,
      currentTouchY: avgY,
      isTouchingSelection: false,
      isTouchingCursor: false,
      isCursorDrag: false,
      touchRadiusX: 0,
      touchRadiusY: 0,
      isTwoFingerScroll: true,
    };

    // Stop any ongoing momentum
    return {
      ...state,
      view: {
        ...state.view,
        momentum: {
          velocity: 0,
          lastTime: Date.now(),
          isActive: false,
        },
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };
  }

  if (event.touches.length === 1) {
    const touch = event.touches[0];
    const currentTime = Date.now();
    const canvasX = touch.clientX - containerRect.left;
    const canvasY = touch.clientY - containerRect.top;

    // Interactive regions (scrollbar thumb, selection handles, image resize
    // handles) — highest-priority hit wins. A hold-gated drag (scrollbar
    // thumb) returns "pending": the touch keeps behaving as a normal
    // scroll/tap until tickPendingCapture promotes it after the hold delay.
    const regionCtx: RegionCtx = { state, viewport, documentHeight, session };
    const point = { x: canvasX, y: canvasY };
    const claim = hitTestAllRegions(point, "touch", regionCtx);
    let holdPending = false;
    if (claim) {
      const begin = beginRegionInteraction(claim, point, "touch", regionCtx);
      if (begin === "pending") {
        holdPending = true;
      } else if (begin) {
        return begin.state;
      }
    }

    // Check if touching within existing selection (use pixel-based check for accuracy)
    const isTouchingSelection = isPointWithinSelectionRects(
      canvasX,
      canvasY,
      state,
      viewport,
    );

    // While a hold-gated chrome drag is pending, the touch still scrolls and
    // taps normally — but must not engage cursor drag on top of the hold.
    if (holdPending) {
      // Set up minimal touch state while the hold timer runs
      session.touch = {
        startY: canvasY,
        startScrollY: viewport.scrollY,
        lastY: canvasY,
        lastTime: currentTime,
        velocityY: 0,
        velocityHistory: [],
        startX: canvasX,
        startTime: currentTime,
        isLongPress: false,
        hasMoved: false,
        currentTouchX: canvasX,
        currentTouchY: canvasY,
        isTouchingSelection: false,
        isTouchingCursor: false,
        isCursorDrag: false,
        touchRadiusX: touch.radiusX ?? 0,
        touchRadiusY: touch.radiusY ?? 0,
      };
    } else {
      // Regular touch (not on scrollbar)
      // Check if touch is near the cursor for cursor drag mode
      let isTouchingCursor = false;
      if (
        state.document.cursor &&
        !isTouchingSelection &&
        (!state.document.selection || state.document.selection.isCollapsed) &&
        state.ui.mode !== "readonly"
      ) {
        const cursorCoords = getCursorDocumentCoords(
          state.document.cursor.position,
          state,
          viewport,
        );
        if (cursorCoords) {
          // Convert document coords to viewport coords
          const cursorScreenX = cursorCoords.x;
          const cursorScreenY = cursorCoords.y - viewport.scrollY;
          const dx = canvasX - cursorScreenX;
          const dy = canvasY - (cursorScreenY + cursorCoords.height / 2);
          const dist = Math.sqrt(dx * dx + dy * dy);
          isTouchingCursor = dist <= CURSOR_TOUCH_RADIUS;
        }
      }

      session.touch = {
        startY: canvasY,
        startScrollY: viewport.scrollY,
        lastY: canvasY,
        lastTime: currentTime,
        velocityY: 0,
        velocityHistory: [],
        startX: canvasX,
        startTime: currentTime,
        isLongPress: false,
        hasMoved: false,
        currentTouchX: canvasX,
        currentTouchY: canvasY,
        isTouchingSelection,
        isTouchingCursor,
        isCursorDrag: false,
        touchRadiusX: touch.radiusX ?? 0,
        touchRadiusY: touch.radiusY ?? 0,
      };
    }

    // Stop any ongoing momentum
    state = {
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

export function handleTouchMove(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  containerRect: { left: number; top: number },
  documentHeight: number,
  session: InteractionSession,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): EditorState {
  // In suspended mode, block scrolling
  if (state.ui.mode === "suspended") {
    return state;
  }

  // A captured region drag (scrollbar thumb, selection handle) owns the
  // pointer — route every move to it until release.
  if (session.captured && event.touches.length > 0) {
    event.preventDefault();
    const touch = event.touches[0];
    const result = routeCapturedMove(
      {
        x: touch.clientX - containerRect.left,
        y: touch.clientY - containerRect.top,
      },
      {
        state,
        viewport,
        documentHeight,
        session,
        updateViewport: updateViewportCallback,
      },
    );
    return result ? result.state : state;
  }

  // Handle transition from two-finger to single-finger (user lifted one finger)
  if (event.touches.length === 1 && session.touch?.isTwoFingerScroll) {
    // User lifted one finger during two-finger scroll - end the scroll with momentum
    const avgVelocity = session.touch.velocityY;
    const minMomentumVelocity = 0.1; // pixels per ms

    // Apply momentum if velocity is significant
    if (Math.abs(avgVelocity) > minMomentumVelocity) {
      const momentumMultiplier = 1.2;
      state = {
        ...state,
        view: {
          ...state.view,
          momentum: {
            velocity: avgVelocity * momentumMultiplier,
            lastTime: Date.now(),
            isActive: true,
          },
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }

    session.touch = null;
    return state;
  }

  // Handle transition from single to two-finger scroll
  if (
    event.touches.length === 2 &&
    session.touch &&
    !session.touch.isTwoFingerScroll
  ) {
    // User added a second finger - switch to two-finger scroll mode
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;

    session.touch = {
      ...session.touch,
      isTwoFingerScroll: true,
      startY: avgY,
      startScrollY: viewport.scrollY,
      lastY: avgY,
      lastTime: currentTime,
      velocityHistory: [], // Reset velocity history
      isLongPress: false, // Cancel long press
      hasMoved: true, // Mark as moved to prevent tap detection
    };

    // Stop any auto-scroll
    stopAutoScroll(session);
  }

  // Handle two-finger scroll
  if (event.touches.length === 2 && session.touch?.isTwoFingerScroll) {
    event.preventDefault();
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();
    const deltaTime = currentTime - session.touch.lastTime;

    // Skip if no time has passed
    if (deltaTime === 0) return state;

    // Calculate average position of both fingers
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;

    // Calculate scroll delta
    const scrollDeltaY = session.touch.lastY - avgY;

    // Calculate instantaneous velocity (pixels per millisecond)
    const instantVelocity = scrollDeltaY / deltaTime;

    // Track velocity for momentum
    if (Math.abs(instantVelocity) > 0.01) {
      session.touch.velocityHistory.push({
        velocity: instantVelocity,
        time: currentTime,
      });
    }

    // Keep only last 150ms of velocity history
    session.touch.velocityHistory = session.touch.velocityHistory.filter(
      (v) => currentTime - v.time < 150,
    );

    // Update velocity for momentum
    if (session.touch.velocityHistory.length > 0) {
      const totalVelocity = session.touch.velocityHistory.reduce(
        (sum, v) => sum + v.velocity,
        0,
      );
      session.touch.velocityY =
        totalVelocity / session.touch.velocityHistory.length;
    }

    // Apply scroll with multiplier for responsive feel
    const touchScrollMultiplier = 1.5;
    const scrollDelta = (session.touch.startY - avgY) * touchScrollMultiplier;

    // Update scroll position with boundaries
    const maxScroll = documentHeight - viewport.height;
    const newScrollY = Math.max(
      0,
      Math.min(maxScroll, session.touch.startScrollY + scrollDelta),
    );

    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }

    session.touch.lastY = avgY;
    session.touch.lastTime = currentTime;

    // Clear any menus when scrolling
    return {
      ...state,
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
      ui: {
        ...state.ui,
        activeMenu: { type: "none" },
        isHoveringLinkWithModifier: false,
        imageHover: null,
      },
    };
  }

  if (event.touches.length === 1 && session.touch) {
    event.preventDefault();
    const touch = event.touches[0];
    const currentTime = Date.now();
    const deltaTime = currentTime - session.touch.lastTime;
    const canvasX = touch.clientX - containerRect.left;
    const canvasY = touch.clientY - containerRect.top;

    // Skip if no time has passed
    if (deltaTime === 0) return state;

    // Handle cursor drag mode (mobile cursor repositioning with magnifier)
    if (session.touch.isCursorDrag) {
      session.touch.lastY = canvasY;
      session.touch.lastTime = currentTime;
      session.touch.currentTouchX = canvasX;
      session.touch.currentTouchY = canvasY;
      session.touch.touchRadiusX = touch.radiusX ?? session.touch.touchRadiusX;
      session.touch.touchRadiusY = touch.radiusY ?? session.touch.touchRadiusY;

      // Check for edge scrolling during cursor drag
      const isNearEdge =
        canvasY < EDGE_SCROLL_THRESHOLD ||
        canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
        canvasY < 0 ||
        canvasY > viewport.height;

      if (isNearEdge) {
        if (!session.autoScroll.isActive) {
          startAutoScroll(session);
        }
        session.autoScroll.lastPointerX = canvasX;
        session.autoScroll.lastPointerY = canvasY;
      } else {
        if (session.autoScroll.isActive) {
          stopAutoScroll(session);
        }
      }

      // Get the new cursor position based on touch location
      const newPosition = getTextPositionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
      );

      if (newPosition) {
        const prevPosition = state.document.cursor?.position;
        // Trigger haptic when cursor crosses a character or line boundary
        if (
          prevPosition &&
          (prevPosition.blockIndex !== newPosition.blockIndex ||
            prevPosition.textIndex !== newPosition.textIndex)
        ) {
          state.actionBus.dispatch(CURSOR_DRAG_BOUNDARY);
        }

        state = updateCursor(state, newPosition);

        state.actionBus.dispatch(CURSOR_DRAG_MOVE, {
          touchX: canvasX,
          touchY: canvasY,
          touchRadiusX: event.touches[0]?.radiusX ?? 0,
          touchRadiusY: event.touches[0]?.radiusY ?? 0,
        });
      }

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

    // Check if we've moved significantly from start position
    const deltaX = Math.abs(canvasX - session.touch.startX);
    const deltaY = Math.abs(canvasY - session.touch.startY);
    const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Update current touch position for auto-scroll
    session.touch.currentTouchX = canvasX;
    session.touch.currentTouchY = canvasY;

    // If moved beyond threshold, mark as moved (cancels potential long press)
    if (!session.touch.hasMoved && totalMovement > MOVEMENT_THRESHOLD) {
      session.touch.hasMoved = true;

      // Cancel any pending hold-to-drag capture (user is scrolling, not holding)
      session.pendingCapture = null;

      // Close all menus on movement - scrolling has priority
      // But don't close menus if we're about to enter cursor drag mode
      if (!session.touch.isTouchingCursor) {
        if (state.ui.activeMenu.type !== "none") {
          state = closeActiveMenu(state);
        }
        // The context menu is host-owned now — signal it to close too (the host
        // clears `hostMenuCapturing` synchronously, so the long-press branch
        // below falls through to selection/scrolling, as before).
        if (session.hostMenuCapturing) {
          state.actionBus.dispatch(CLOSE_CONTEXT_MENU);
        }
      }
    }

    // Handle long press text selection mode
    // Block long-press text selection in readonly mode
    if (session.touch.isLongPress && state.ui.mode !== "readonly") {
      // If a host context menu is capturing the pointer, allow drag-and-release
      // interaction — don't start text selection (the user might be dragging to
      // a menu item). The host owns the menu, so forward the raw client point
      // and let it hit-test its own items / update its hover highlight.
      if (session.hostMenuCapturing) {
        session.touch.lastY = canvasY;
        session.touch.lastTime = currentTime;

        const touch = event.touches[0];
        state.actionBus.dispatch(CONTEXT_MENU_POINTER_MOVE, {
          clientX: touch.clientX,
          clientY: touch.clientY,
        });

        return state;
      }

      // Long pressed on non-selected text: enable drag selection
      if (!session.touch.isTouchingSelection) {
        // Start selection mode if not already in it
        if (state.ui.mode !== "select") {
          const position = getTextPositionFromViewport(
            session.touch.startX,
            session.touch.startY,
            state,
            viewport,
          );

          if (position) {
            state = startSelection(state, position);
            state = updateMode(state, "select");
          }
        }

        if (!session.autoScroll.isActive) {
          startAutoScroll(session);
        }

        session.touch.lastY = canvasY;
        session.touch.lastTime = currentTime;

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
      } else {
        // Long pressing on selection - don't start auto-scroll, just wait for touchend
        session.touch.lastY = canvasY;
        session.touch.lastTime = currentTime;
        return state;
      }
    }

    // Default: Handle scrolling
    const scrollDeltaY = session.touch.lastY - canvasY;

    // Calculate instantaneous velocity (pixels per millisecond)
    const instantVelocity = scrollDeltaY / deltaTime;

    // Only track velocity if there's actual movement (avoid diluting with zeros)
    // This prevents touchmove events with no vertical movement from adding 0-velocity entries
    if (Math.abs(instantVelocity) > 0.01) {
      session.touch.velocityHistory.push({
        velocity: instantVelocity,
        time: currentTime,
      });
    }

    // Keep only last 150ms of velocity history (increased from 100ms to be more reliable)
    session.touch.velocityHistory = session.touch.velocityHistory.filter(
      (v) => currentTime - v.time < 150,
    );

    // Always update velocity for momentum (use average if history exists)
    if (session.touch.velocityHistory.length > 0) {
      const totalVelocity = session.touch.velocityHistory.reduce(
        (sum, v) => sum + v.velocity,
        0,
      );
      session.touch.velocityY =
        totalVelocity / session.touch.velocityHistory.length;
      // console.log("session.touch.velocityY", session.touch.velocityY);
    }
    // Apply scroll speed multiplier for more responsive feel on mobile
    // 1.5x makes scrolling feel more direct and responsive
    const touchScrollMultiplier = 1.5;
    const scrollDelta =
      (session.touch.startY - canvasY) * touchScrollMultiplier;

    // Update scroll position with hard boundaries
    const maxScroll = documentHeight - viewport.height;
    const newScrollY = Math.max(
      0,
      Math.min(maxScroll, session.touch.startScrollY + scrollDelta),
    );

    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }

    session.touch.lastY = canvasY;
    session.touch.lastTime = currentTime;
  }

  // Clear link hover overlay when scrolling
  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: {
        ...state.view.scrollbar,
        lastInteraction: Date.now(),
      },
    },
    ui: {
      ...state.ui,
      activeMenu: { type: "none" },
      isHoveringLinkWithModifier: false,
    },
  };
}
export function handleTouchEnd(
  state: EditorState,
  viewport: ViewportState,
  _event: TouchEvent,
  _containerRect: { left: number; top: number },
  documentHeight: number,
  session: InteractionSession,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  scrollPositionIntoView?: (position: Position) => void,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  stopAutoScroll(session);

  // A pending hold that never activated is just a tap/scroll — drop it.
  session.pendingCapture = null;

  // Release a captured region drag (scrollbar thumb, selection handle).
  if (session.captured) {
    session.touch = null;
    const endResult = routeCapturedEnd(null, {
      state,
      viewport,
      documentHeight,
      session,
    });
    return {
      state: endResult ? endResult.state : state,
      ops: endResult?.ops ?? [],
    };
  }

  // Handle two-finger scroll end with momentum
  if (session.touch?.isTwoFingerScroll) {
    const avgVelocity = session.touch.velocityY;
    const minMomentumVelocity = 0.1; // pixels per ms

    // Apply momentum if velocity is significant
    if (Math.abs(avgVelocity) > minMomentumVelocity) {
      const momentumMultiplier = 1.2;
      state = {
        ...state,
        view: {
          ...state.view,
          momentum: {
            velocity: avgVelocity * momentumMultiplier,
            lastTime: Date.now(),
            isActive: true,
          },
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }

    session.touch = null;
    return { state, ops };
  }

  // End cursor drag if active. The cursor drag is the magnifier (loupe)
  // gesture: hold on the caret to bring it up, then slide to reposition.
  //
  // If the finger never moved, this was a plain hold-on-cursor — open the
  // context menu (standard mobile paste menu). But if the user actually dragged
  // the caret with the magnifier, lifting just commits the new caret position;
  // popping a menu there is surprising. The `isCursorDrag` branch in
  // handleTouchMove returns before the shared `hasMoved` flag is set, so it
  // never reflects cursor-drag travel; compute net movement here instead.
  if (session.touch?.isCursorDrag) {
    const touchX = session.touch.currentTouchX;
    const touchY = session.touch.currentTouchY;
    const netMovement = Math.sqrt(
      (touchX - session.touch.startX) ** 2 +
        (touchY - session.touch.startY) ** 2,
    );
    const didNotMove = netMovement <= TAP_MOVE_TOLERANCE;
    state.actionBus.dispatch(CURSOR_DRAG_END);
    session.touch = null;

    let newState: EditorState = {
      ...state,
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };

    // Held on the cursor without dragging → open context menu.
    if (didNotMove) {
      newState = newState.actionBus.dispatchState(
        OPEN_CONTEXT_MENU_AT,
        newState,
        { point: { x: touchX, y: touchY } },
      ).state;
    }

    return {
      state: newState,
      ops,
    };
  }

  // Drag-and-release for the host context menu (power-user feature). If a host
  // menu is capturing the pointer and the user lifts during a long press, hand
  // the release point to the host: it hit-tests its own items and either runs
  // the one under the finger (closing the menu) or keeps the menu open for
  // tapping. The engine no longer owns the menu, so it just forwards the event.
  if (session.hostMenuCapturing && session.touch?.isLongPress) {
    const releaseTouch = _event.changedTouches[0];
    if (releaseTouch) {
      state.actionBus.dispatch(CONTEXT_MENU_RELEASE, {
        clientX: releaseTouch.clientX,
        clientY: releaseTouch.clientY,
      });
    }
    session.touch = null;
    return {
      state: {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      },
      ops,
    };
  }

  // If we were in long press mode
  if (session.touch?.isLongPress) {
    if (session.touch.isTouchingSelection) {
      // Long pressed on existing selection - context menu already shown, just cleanup
      session.touch = null;
      return {
        state: {
          ...state,
          view: {
            ...state.view,
            scrollbar: {
              ...state.view.scrollbar,
              lastInteraction: Date.now(),
            },
          },
        },
        ops,
      };
    } else if (state.ui.mode === "select") {
      // Long press created a new selection (user dragged) - exit select mode
      state = state.actionBus.dispatchState(FINISH_SELECT_MODE, state).state;
      session.touch = null;

      return {
        state: {
          ...state,
          view: {
            ...state.view,
            scrollbar: {
              ...state.view.scrollbar,
              lastInteraction: Date.now(),
            },
          },
        },
        ops,
      };
    } else {
      // Long press on non-selected text but user didn't drag - show context menu now
      state = state.actionBus.dispatchState(OPEN_CONTEXT_MENU_AT, state, {
        point: {
          x: session.touch.currentTouchX,
          y: session.touch.currentTouchY,
        },
      }).state;
      session.touch = null;
      return {
        state: {
          ...state,
          view: {
            ...state.view,
            scrollbar: {
              ...state.view.scrollbar,
              lastInteraction: Date.now(),
            },
          },
        },
        ops,
      };
    }
  }

  // Detect tap: short duration and minimal *net* movement. Using net travel
  // (start → release) rather than the sticky `hasMoved` flag means a transient
  // jitter spike that crossed MOVEMENT_THRESHOLD but settled back near the
  // origin still counts as a tap — without this, slightly imprecise taps on
  // Android (which smooths touch coordinates less than iOS) silently fail to
  // register, breaking double-tap-to-select. `hasMoved` still governs scroll,
  // menu-close, and long-press/cursor-drag decisions.
  const currentTime = Date.now();
  const netTapMovement = session.touch
    ? Math.sqrt(
        (session.touch.currentTouchX - session.touch.startX) ** 2 +
          (session.touch.currentTouchY - session.touch.startY) ** 2,
      )
    : Infinity;
  const isTap =
    session.touch &&
    netTapMovement <= TAP_MOVE_TOLERANCE &&
    currentTime - session.touch.startTime < TAP_MAX_DURATION;

  if (isTap && session.touch) {
    const tapPosition = { x: session.touch.startX, y: session.touch.startY };

    // Track if a host overlay was open (used to prevent reopening on same tap)
    const wasOverlayOpen = state.ui.activeMenu.type === "overlay";
    const wasOverlayBlockId =
      state.ui.activeMenu.type === "overlay"
        ? state.ui.activeMenu.blockId
        : undefined;

    // Tap on an interactive region (todo checkbox, out-of-view peer indicator,
    // …). Checked before the padding/text fallbacks so chrome wins the tap,
    // matching the mouse path (which hit-tests regions first). A peer indicator
    // pill sits in the gutter and would otherwise be swallowed by the
    // left-padding branch below.
    const tapCtx: RegionCtx = {
      state,
      viewport,
      documentHeight,
      session,
      updateViewport: updateViewportCallback,
      scrollPositionIntoView,
    };
    const tapClaim = hitTestAllRegions(
      { x: tapPosition.x, y: tapPosition.y },
      "touch",
      tapCtx,
    );
    if (tapClaim?.region.onTap) {
      const tapResult = tapClaim.region.onTap(
        tapClaim.hit,
        { x: tapPosition.x, y: tapPosition.y },
        1,
        tapCtx,
      );
      if (tapResult) {
        session.touch = null;
        return { state: tapResult.state, ops: tapResult.ops ?? [] };
      }
    }

    // Check if tapping in top padding area
    const styles = getEditorStyles(state);
    const isTapInTopPadding =
      tapPosition.y < styles.canvas.paddingTop - viewport.scrollY;

    // If tapping in top padding, start a fresh paragraph above a leading
    // self-contained block (code/math/quote); otherwise clear selection.
    if (isTapInTopPadding) {
      const edge =
        state.ui.mode !== "readonly"
          ? createParagraphAboveOnClick(state, tapPosition.y, viewport)
          : { kind: "fallthrough" as const };
      if (edge.kind === "break") {
        state = edge.state;
        ops.push(...edge.ops);
      } else {
        state = state.actionBus.dispatchState(TAP_TOP_PADDING, state).state;
      }

      session.touch = null;
      return {
        state: {
          ...state,
          view: {
            ...state.view,
            scrollbar: {
              ...state.view.scrollbar,
              lastInteraction: Date.now(),
            },
          },
        },
        ops,
      };
    }

    // Check if tapping in left/right padding area
    const maxWidth =
      viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
    const isTapInLeftPadding = tapPosition.x < styles.canvas.paddingLeft;
    const isTapInRightPadding =
      tapPosition.x > styles.canvas.paddingLeft + maxWidth;

    // If tapping in left/right padding, position cursor at start/end of line and clear selection
    if (isTapInLeftPadding || isTapInRightPadding) {
      const paddingPosition = getTextPositionFromViewport(
        tapPosition.x,
        tapPosition.y,
        state,
        viewport,
      );

      if (paddingPosition) {
        state = state.actionBus.dispatchState(TAP_SIDE_PADDING, state, {
          position: paddingPosition,
        }).state;

        session.touch = null;
        return {
          state: {
            ...state,
            view: {
              ...state.view,
              scrollbar: {
                ...state.view.scrollbar,
                lastInteraction: Date.now(),
              },
            },
          },
          ops,
        };
      }
    }

    // Get text position for cursor/selection
    const position = getTextPositionFromViewport(
      tapPosition.x,
      tapPosition.y,
      state,
      viewport,
    );

    // Where the *previous* tap resolved, captured before we overwrite it below.
    // A multi-tap (word/line select) anchors here rather than re-resolving the
    // current tap's screen point: on Android the keyboard raised by the first
    // tap reflows the canvas between taps, so the same finger location maps to a
    // different — often empty — document position by the second tap.
    const prevTapDocPosition = session.tapTracker.lastTapDocPosition;

    // Check for multi-tap (double/triple) - use larger threshold for touch
    let isMultiTap = false;
    if (
      session.tapTracker.lastTapPosition &&
      currentTime - session.tapTracker.lastTapTime <= DOUBLE_CLICK_TIME &&
      isWithinClickDistance(
        tapPosition,
        session.tapTracker.lastTapPosition,
        TAP_DISTANCE_THRESHOLD,
      )
    ) {
      session.tapTracker.count++;
      isMultiTap = true;
    } else {
      session.tapTracker.count = 1;
    }

    session.tapTracker.lastTapTime = currentTime;
    session.tapTracker.lastTapPosition = tapPosition;
    session.tapTracker.lastTapDocPosition = position;

    if (position) {
      // Check if tapped on an image cover block
      const tappedBlock = state.document.page.blocks[position.blockIndex];
      if (!tappedBlock || tappedBlock.deleted) return { state, ops };
      if (!isTextualBlock(tappedBlock)) {
        // Tapped an atomic block (image/line/math/custom void). One
        // type-agnostic path mirroring the desktop click handler: confirm the
        // tap landed on the block's visual, then let the node's `activate` hook
        // decide whether to open an overlay; otherwise select the block.
        const atomicHit = getAtomicBlockAtPoint(
          tapPosition.x,
          tapPosition.y,
          state,
          viewport,
        );
        if (atomicHit) {
          // Ask the node whether activation opens a host overlay (a placeholder
          // image opens its upload popover; a math block opens its editor).
          // Blocked in readonly mode. A node with no overlay (a divider)
          // returns nothing and falls through to selection.
          const activation =
            state.ui.mode !== "readonly"
              ? state.nodes.get(tappedBlock.type)?.activate?.({
                  state,
                  block: tappedBlock,
                  blockIndex: position.blockIndex,
                })
              : null;
          if (activation) {
            // If an overlay was already open for this same block, don't reopen it
            // (let it stay closed) — tapping an open popover closes it.
            if (wasOverlayOpen && wasOverlayBlockId === tappedBlock.id) {
              // Close the popover and keep it closed
              session.touch = null;
              const closedState = state.actionBus.dispatchState(
                CLOSE_NODE_OVERLAY,
                state,
              ).state;
              return {
                state: {
                  ...closedState,
                  view: {
                    ...closedState.view,
                    scrollbar: {
                      ...closedState.view.scrollbar,
                      lastInteraction: Date.now(),
                    },
                  },
                },
                ops,
              };
            }

            // Open the host overlay
            session.touch = null;
            const menuState = state.actionBus.dispatchState(
              OPEN_NODE_OVERLAY,
              state,
              {
                key: activation.key,
                blockId: tappedBlock.id,
                point: { x: tapPosition.x, y: tapPosition.y },
                data: activation.data,
              },
            ).state;
            return {
              state: {
                ...menuState,
                view: {
                  ...menuState.view,
                  scrollbar: {
                    ...menuState.view.scrollbar,
                    lastInteraction: Date.now(),
                  },
                },
              },
              ops,
            };
          }

          // No activation: select the visual block (same behavior as desktop)
          state = state.actionBus.dispatchState(
            TAP_SELECT_VISUAL_BLOCK,
            state,
            {
              position: { blockIndex: atomicHit.blockIndex, textIndex: 0 },
            },
          ).state;

          session.touch = null;
          return {
            state: {
              ...state,
              view: {
                ...state.view,
                scrollbar: {
                  ...state.view.scrollbar,
                  lastInteraction: Date.now(),
                },
              },
            },
            ops,
          };
        } else {
          // Tapped within an atomic block's flow area but not on its visual
          // (e.g. below a trailing image). Give nodes a chance to claim the tap
          // generically — ImageNode appends a paragraph below a trailing image
          // via its TEXT_CLICK handler. The engine names no block type; if no
          // handler claims it, fall through to the normal tap handling below.
          const clicked = state.actionBus.dispatchState(TEXT_CLICK, state, {
            canvasX: tapPosition.x,
            canvasY: tapPosition.y,
            position,
            previousMenu: state.ui.activeMenu,
            viewport,
            modifiers: { ctrlOrMeta: false, shift: false },
          });
          if (clicked.claimed) {
            ops.push(...clicked.ops);
            session.touch = null;
            return {
              state: {
                ...clicked.state,
                view: {
                  ...clicked.state.view,
                  scrollbar: {
                    ...clicked.state.view.scrollbar,
                    lastInteraction: Date.now(),
                  },
                },
              },
              ops,
            };
          }
        }
      }

      // Tapped a textual block (not an atomic visual block) while a visual
      // block was selected → clear that selection.
      if (
        isTextualBlock(tappedBlock) &&
        state.document.selection &&
        !state.document.selection.isCollapsed
      ) {
        const { anchor, focus } = state.document.selection;
        // Check if this is a visual block selection (anchor and focus at same position on an image/line block)
        if (
          anchor.blockIndex === focus.blockIndex &&
          anchor.textIndex === focus.textIndex
        ) {
          const selectedBlock = state.document.page.blocks[anchor.blockIndex];
          if (!selectedBlock || selectedBlock.deleted) return { state, ops };
          if (isVisualBlockSelection(selectedBlock)) {
            // We have a visual block selected, but tapped outside it - clear the selection
            state = state.actionBus.dispatchState(
              TAP_CLEAR_VISUAL_BLOCK_SELECTION,
              state,
            ).state;
          }
        }
      }

      // Close any active menu when tapping on non-visual blocks
      if (state.ui.activeMenu.type !== "none") {
        state = closeActiveMenu(state);
      }

      // A multi-tap selects at the first tap's resolved position (stable across
      // an Android keyboard reflow); a fresh tap uses its own resolved position.
      const anchorPosition =
        isMultiTap && prevTapDocPosition ? prevTapDocPosition : position;

      // Handle triple-tap: always select line (even inside selection)
      if (isMultiTap && session.tapTracker.count >= 3) {
        state = state.actionBus.dispatchState(TAP_SELECT_LINE, state, {
          position: anchorPosition,
        }).state;
      }

      // Handle double-tap: select word (fires even inside an existing
      // selection, mirroring native editors where double-tap re-selects).
      else if (isMultiTap && session.tapTracker.count === 2) {
        state = state.actionBus.dispatchState(TAP_SELECT_WORD, state, {
          position: anchorPosition,
        }).state;
      }

      // Single tap landing inside an existing selection: open the context menu
      // at the tap point and keep the selection, matching iOS where tapping
      // selected text surfaces the edit menu (cut/copy/format) instead of
      // dismissing it. Deselect stays a one-tap gesture — a tap *outside* the
      // selection falls through to the caret-placement branch below, which
      // collapses it. Allowed in readonly too (copy is still valid there).
      else if (
        session.touch.isTouchingSelection &&
        state.document.selection &&
        !state.document.selection.isCollapsed
      ) {
        state = state.actionBus.dispatchState(OPEN_CONTEXT_MENU_AT, state, {
          point: { x: tapPosition.x, y: tapPosition.y },
        }).state;
      }

      // Single tap: collapse any selection, position the caret, and close the
      // context menu. A tap in the empty area below a trailing self-contained
      // block (code/math/quote) starts a fresh paragraph there instead.
      else {
        const edge =
          state.ui.mode !== "readonly"
            ? createParagraphBelowOnClick(state, tapPosition.y, viewport)
            : { kind: "fallthrough" as const };
        if (edge.kind === "break") {
          state = edge.state;
          ops.push(...edge.ops);
        } else {
          state = state.actionBus.dispatchState(TAP_PLACE_CURSOR, state, {
            position,
          }).state;
        }
      }
    } else {
      // Tapping outside editor area (padding/margins) - clear selection and close menus
      state = state.actionBus.dispatchState(TAP_OUTSIDE_CONTENT, state).state;
    }

    session.touch = null;
    return {
      state: {
        ...state,
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      },
      ops,
    };
  }

  // Implement momentum scrolling with the tracked velocity
  // Only apply momentum if NOT dragging scrollbar and NOT in long press mode
  if (session.touch && !session.touch.isLongPress) {
    // Use the average velocity from recent history
    const avgVelocity = session.touch.velocityY;

    // Only apply momentum if velocity is significant
    const minMomentumVelocity = 0.1; // pixels per ms
    if (Math.abs(avgVelocity) > minMomentumVelocity) {
      // Apply momentum multiplier for more natural feel
      // Higher values = more "throw" distance
      const momentumMultiplier = 1.2;
      state = {
        ...state,
        view: {
          ...state.view,
          momentum: {
            velocity: avgVelocity * momentumMultiplier,
            lastTime: Date.now(),
            isActive: true,
          },
        },
      };
    }
  }

  session.touch = null;

  return {
    state: {
      ...state,
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    },
    ops,
  };
}
export function handleTouchCancel(
  state: EditorState,
  viewport: ViewportState,
  documentHeight: number,
  session: InteractionSession,
): EditorState {
  stopAutoScroll(session);
  session.pendingCapture = null;

  // Cancel a captured region drag (scrollbar thumb, selection handle)
  const cancelled = routeCapturedCancel({
    state,
    viewport,
    documentHeight,
    session,
  });
  if (cancelled) {
    state = cancelled;
  }

  // End scrollbar drag if active
  if (state.view.scrollbar.isDragging) {
    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: endScrollbarDrag(state.view.scrollbar),
      },
    };
  }

  // End selection handle drag if active
  if (state.ui.selectionHandleDrag) {
    state = {
      ...state,
      ui: {
        ...state.ui,
        selectionHandleDrag: null,
      },
    };
  }

  // End cursor drag if active — let observers (e.g. a host magnifier) tear down.
  if (session.touch?.isCursorDrag) {
    state.actionBus.dispatch(CURSOR_DRAG_END);
  }

  // If we were in long press text selection mode, exit select mode
  if (session.touch?.isLongPress && state.ui.mode === "select") {
    state = updateMode(state, "edit");
  }

  // Clear touch state
  session.touch = null;

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
