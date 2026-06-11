import {
  selectLineAtPosition,
  selectWordAtPosition,
} from "../actions/commands";
import {
  CURSOR_TOUCH_RADIUS,
  DOUBLE_CLICK_TIME,
  EDGE_SCROLL_THRESHOLD,
  MOVEMENT_THRESHOLD,
  TAP_DISTANCE_THRESHOLD,
  TAP_MAX_DURATION,
} from "../constants";
import { endScrollbarDrag } from "../rendering/scrollbar";
import {
  getCursorDocumentCoords,
  getTextPositionFromViewport,
  isPointWithinSelectionRects,
} from "../selection";
import { moveCursorToPosition } from "../selection";
import { updateCursor } from "../selection";
import { clearSelection, startSelection } from "../selection";
import { type Block } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import {
  closeActiveMenu,
  openContextMenu,
  selectContextMenuItem,
  setActiveMenu,
  updateContextMenuHover,
  updateMode,
} from "../state-utils";
import { getEditorStyles, getTextStyle } from "../styles";
import { isTextualBlock } from "../sync/block-registry";
import type { Operation } from "../sync/sync";
import { hitTestAllRegions } from "./blockRegions";
import { getAtomicBlockAtPoint, isWithinClickDistance } from "./eventUtils";
import { triggerHapticFeedback } from "./haptics";
import {
  beginRegionInteraction,
  type RegionCtx,
  routeCapturedCancel,
  routeCapturedEnd,
  routeCapturedMove,
} from "./regions";
import {
  type InteractionSession,
  startAutoScroll,
  stopAutoScroll,
} from "./session";

// Re-export for hosts that deep-import from this module (apps/web does).
export { triggerHapticFeedback } from "./haptics";

/** Get rendered line height (px) for the block at the given position. */
function getLineHeightAtPosition(
  state: EditorState,
  blockIndex: number,
): number {
  const block = state.document.page.blocks[blockIndex];
  if (!block) return 16 * 1.6;
  if (!isTextualBlock(block)) return 16 * 1.6;
  const styles = getEditorStyles(state);
  const textStyle = getTextStyle(styles, block.type);
  return textStyle.fontSize * textStyle.lineHeight;
}

export function handleTouchStart(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  containerRect: { left: number; top: number },
  documentHeight: number,
  session: InteractionSession,
): EditorState {
  // In locked mode, block touch interactions that might lead to scrolling
  if (state.ui.mode === "locked") {
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
  // In locked mode, block scrolling
  if (state.ui.mode === "locked") {
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
        const prevPosition = state.ui.cursorDrag?.lastPosition;
        // Trigger haptic when cursor crosses a character or line boundary
        if (
          prevPosition &&
          (prevPosition.blockIndex !== newPosition.blockIndex ||
            prevPosition.textIndex !== newPosition.textIndex)
        ) {
          triggerHapticFeedback("light");
        }

        state = updateCursor(state, newPosition);

        // Update cursorDrag state with new touch position and cursor coords
        const cursorCoords = getCursorDocumentCoords(
          newPosition,
          state,
          viewport,
        );

        const touchRadiusY = event.touches[0]?.radiusY ?? 0;
        state = {
          ...state,
          ui: {
            ...state.ui,
            cursorDrag: {
              isActive: true,
              touchX: canvasX,
              touchY: canvasY,
              cursorX: cursorCoords ? cursorCoords.x : canvasX,
              cursorY: cursorCoords
                ? cursorCoords.y - viewport.scrollY
                : canvasY,
              touchRadiusY,
              lineHeight: getLineHeightAtPosition(
                state,
                newPosition.blockIndex,
              ),
              lastPosition: newPosition,
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
      if (
        state.ui.activeMenu.type !== "none" &&
        !session.touch.isTouchingCursor
      ) {
        state = closeActiveMenu(state);
      }
    }

    // Handle long press text selection mode
    // Block long-press text selection in readonly mode
    if (session.touch.isLongPress && state.ui.mode !== "readonly") {
      // If context menu is open, allow drag-and-release interaction
      // Don't start text selection - user might be dragging to menu item
      if (state.ui.activeMenu.type === "contextMenu") {
        session.touch.lastY = canvasY;
        session.touch.lastTime = currentTime;

        // Update hover state based on touch position
        const touch = event.touches[0];
        const element = document.elementFromPoint(touch.clientX, touch.clientY);
        let hoveredItemId: string | null = null;

        if (element) {
          const button = element.closest("button[data-context-menu-item-id]");
          if (button) {
            hoveredItemId = button.getAttribute("data-context-menu-item-id");
          }
        }

        // Update hover state if it changed
        const currentHoveredId = state.ui.activeMenu.hoveredItemId || null;
        if (hoveredItemId !== currentHoveredId) {
          state = updateContextMenuHover(state, hoveredItemId);
        }

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

  // End cursor drag if active
  if (session.touch?.isCursorDrag) {
    const didNotMove = !session.touch.hasMoved;
    const touchX = session.touch.currentTouchX;
    const touchY = session.touch.currentTouchY;
    triggerHapticFeedback("medium");
    session.touch = null;

    let newState: EditorState = {
      ...state,
      ui: {
        ...state.ui,
        cursorDrag: null,
      },
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };

    // If the user held on the cursor without moving, open context menu
    // This matches standard mobile behavior (long-press on cursor = paste menu)
    if (didNotMove) {
      newState = openContextMenu(newState, touchX, touchY);
    }

    return {
      state: newState,
      ops,
    };
  }

  // Handle drag-and-release for context menu (power user feature)
  // Check if context menu is open and user is releasing (possibly over a menu item)
  if (
    state.ui.activeMenu.type === "contextMenu" &&
    session.touch?.isLongPress
  ) {
    // Use the hoveredItemId from the state (already tracked during touchmove)
    const hoveredItemId = state.ui.activeMenu.hoveredItemId;

    if (hoveredItemId) {
      // User released on a menu item - mark it as selected
      // MountedEditor will detect this and execute the action
      state = selectContextMenuItem(state, hoveredItemId);
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
      // User released but not on a menu item - keep menu open for tapping
      // Just clean up touch state and return
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
      // Clear initialBoundary when finishing selection
      if (state.document.selection?.initialBoundary) {
        state = {
          ...state,
          document: {
            ...state.document,
            selection: state.document.selection
              ? {
                  ...state.document.selection,
                  initialBoundary: undefined,
                }
              : null,
          },
        };
      }
      state = updateMode(state, "edit");
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
      state = openContextMenu(
        state,
        session.touch.currentTouchX,
        session.touch.currentTouchY,
      );
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

  // Detect tap: short duration and minimal movement
  const currentTime = Date.now();
  const isTap =
    session.touch &&
    !session.touch.hasMoved &&
    currentTime - session.touch.startTime < TAP_MAX_DURATION;

  if (isTap && session.touch) {
    const tapPosition = { x: session.touch.startX, y: session.touch.startY };

    // Track if image upload was open (we'll use this to prevent reopening on same tap)
    const wasImageUploadOpen = state.ui.activeMenu.type === "imageUpload";
    const wasImageUploadBlockIndex =
      state.ui.activeMenu.type === "imageUpload"
        ? state.ui.activeMenu.blockIndex
        : undefined;

    // Check if tapping in top padding area
    const styles = getEditorStyles(state);
    const isTapInTopPadding =
      tapPosition.y < styles.canvas.paddingTop - viewport.scrollY;

    // If tapping in top padding, clear selection
    if (isTapInTopPadding) {
      state = clearSelection(state);
      state = updateMode(state, "edit");
      // Close any active menu when tapping in padding
      if (state.ui.activeMenu.type === "contextMenu") {
        state = closeActiveMenu(state);
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
        state = clearSelection(state);
        state = updateCursor(state, paddingPosition);
        state = updateMode(state, "edit");
        // Close any active menu when tapping in padding
        if (state.ui.activeMenu.type === "contextMenu") {
          state = closeActiveMenu(state);
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
    }

    // Tap on an interactive region (todo checkbox, …)
    const tapCtx: RegionCtx = { state, viewport, documentHeight, session };
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

    // Get text position for cursor/selection
    const position = getTextPositionFromViewport(
      tapPosition.x,
      tapPosition.y,
      state,
      viewport,
    );

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

    if (position) {
      // If tapping below all blocks, check if last block is an image and select it
      const visibleBlocks = state.view.visibleBlocks;
      const lastVisibleBlockIndex = visibleBlocks.length - 1;
      if (
        lastVisibleBlockIndex >= 0 &&
        position.blockIndex === lastVisibleBlockIndex
      ) {
        const lastBlock = state.document.page.blocks[lastVisibleBlockIndex];

        // Calculate if tap is below the last block's content
        // Use pre-computed viewport.documentHeight instead of iterating through all blocks
        const totalContentHeight =
          viewport.documentHeight + styles.canvas.paddingTop;
        const isTapBelowContent =
          tapPosition.y > totalContentHeight - viewport.scrollY;

        // If tapping below content and last block is an image, create a new paragraph
        // Block in readonly mode
        if (
          isTapBelowContent &&
          lastBlock.type === "image" &&
          state.ui.mode !== "readonly"
        ) {
          const newParagraphId = state.CRDTbinding.nextId();
          const newParagraph: Block = {
            id: newParagraphId,
            afterId: lastBlock.id,
            type: "paragraph",
            charRuns: [],
            formats: [],
          };

          const blockInsertOp: Operation = {
            op: "block_insert",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            afterBlockId: lastBlock.id,
            blockId: newParagraphId,
            blockType: "paragraph",
          };

          const newBlocks = [...state.document.page.blocks, newParagraph];
          const newPage = { ...state.document.page, blocks: newBlocks };

          state = {
            ...state,
            document: { ...state.document, page: newPage },
          };
          state = clearSelection(state);
          state = moveCursorToPosition(state, lastVisibleBlockIndex + 1, 0);

          session.touch = null;
          const finalState = updateMode(state, "edit");
          ops.push(blockInsertOp);
          return {
            state: {
              ...finalState,
              view: {
                ...finalState.view,
                scrollbar: {
                  ...finalState.view.scrollbar,
                  lastInteraction: Date.now(),
                },
              },
            },
            ops,
          };
        }
      }

      // Check if tapped on an image cover block
      const tappedBlock = state.document.page.blocks[position.blockIndex];
      if (!tappedBlock || tappedBlock.deleted) return { state, ops };
      if (tappedBlock && tappedBlock.type === "image") {
        // Verify the tap is actually within the image bounds, not just in the block
        const imageBlock = getAtomicBlockAtPoint(
          tapPosition.x,
          tapPosition.y,
          state,
          viewport,
          "image",
        );
        if (imageBlock) {
          // If it's a placeholder (no URL), open upload menu
          // Block in readonly mode
          if (!tappedBlock.url && state.ui.mode !== "readonly") {
            // If the upload menu was already open for this same block, don't reopen it (let it stay closed)
            // This allows tapping on an open upload menu to close it
            if (
              wasImageUploadOpen &&
              wasImageUploadBlockIndex === position.blockIndex
            ) {
              // Close image upload popover and keep it closed
              session.touch = null;
              const closedState = closeActiveMenu(state);
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

            // Open image upload popover
            session.touch = null;
            const menuState = setActiveMenu(state, {
              type: "imageUpload",
              blockIndex: position.blockIndex,
              x: tapPosition.x,
              y: tapPosition.y,
            });
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

          // If it has an image, select the image block (same behavior as desktop)
          const imagePosition = {
            blockIndex: imageBlock.blockIndex,
            textIndex: 0,
          };

          // Close any active menu when selecting an image
          if (state.ui.activeMenu.type !== "none") {
            state = closeActiveMenu(state);
          }

          // Create a selection that spans the image block (same as arrow key behavior)
          state = moveCursorToPosition(state, imageBlock.blockIndex, 0);
          state = {
            ...state,
            document: {
              ...state.document,
              selection: {
                anchor: imagePosition,
                focus: imagePosition,
                isForward: true,
                isCollapsed: false,
                lastUpdate: Date.now(),
              },
            },
          };
          state = updateMode(state, "edit");

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
          // Tapped on image block area but not on the actual image visual
          // If this is the last block, create a new paragraph below
          const visibleBlocks = state.view.visibleBlocks;
          const lastVisibleBlockIndex =
            visibleBlocks.length > 0
              ? state.document.page.blocks.findIndex(
                  (b) => b.id === visibleBlocks[visibleBlocks.length - 1].id,
                )
              : -1;
          const isLastBlock = position.blockIndex === lastVisibleBlockIndex;
          // Block paragraph creation in readonly mode
          if (isLastBlock && state.ui.mode !== "readonly") {
            const currentBlock =
              state.document.page.blocks[position.blockIndex];
            const newParagraphId = state.CRDTbinding.nextId();
            const newParagraph: Block = {
              id: newParagraphId,
              afterId: currentBlock.id,
              type: "paragraph",
              charRuns: [],
              formats: [],
            };

            const blockInsertOp: Operation = {
              op: "block_insert",
              id: state.CRDTbinding.nextId(),
              clock: state.CRDTbinding.getClock(),
              pageId: state.CRDTbinding.pageId,
              afterBlockId: currentBlock.id,
              blockId: newParagraphId,
              blockType: "paragraph",
            };

            const newBlocks = [...state.document.page.blocks, newParagraph];
            const newPage = { ...state.document.page, blocks: newBlocks };

            state = {
              ...state,
              document: { ...state.document, page: newPage },
            };
            state = clearSelection(state);
            state = moveCursorToPosition(state, position.blockIndex + 1, 0);

            // Broadcast the operation
            ops.push(blockInsertOp);

            session.touch = null;
            const finalState = updateMode(state, "edit");
            return {
              state: {
                ...finalState,
                view: {
                  ...finalState.view,
                  scrollbar: {
                    ...finalState.view.scrollbar,
                    lastInteraction: Date.now(),
                  },
                },
              },
              ops,
            };
          }
        }
      }

      // Check if tapped on a line block
      if (tappedBlock && tappedBlock.type === "line") {
        // Verify the tap is actually within the line block bounds
        const lineBlockResult = getAtomicBlockAtPoint(
          tapPosition.x,
          tapPosition.y,
          state,
          viewport,
          "line",
        );
        if (lineBlockResult) {
          // Select the line block (same behavior as image blocks)
          const linePosition = {
            blockIndex: lineBlockResult.blockIndex,
            textIndex: 0,
          };

          // Close any active menu when selecting a line block
          if (state.ui.activeMenu.type !== "none") {
            state = closeActiveMenu(state);
          }

          // Create a selection that spans the line block
          state = moveCursorToPosition(state, lineBlockResult.blockIndex, 0);
          state = {
            ...state,
            document: {
              ...state.document,
              selection: {
                anchor: linePosition,
                focus: linePosition,
                isForward: true,
                isCollapsed: false,
                lastUpdate: Date.now(),
              },
            },
          };
          state = updateMode(state, "edit");

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

      // Check if we have a visual block (image/line) selected but tapped outside its container
      if (
        tappedBlock?.type !== "image" &&
        tappedBlock?.type !== "line" &&
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
          if (selectedBlock && !isTextualBlock(selectedBlock)) {
            // We have a visual block selected, but tapped outside it - clear the selection
            state = clearSelection(state);
          }
        }
      }

      // Close any active menu when tapping on non-visual blocks
      if (state.ui.activeMenu.type !== "none") {
        state = closeActiveMenu(state);
      }

      // Handle triple-tap: always select line (even inside selection)
      if (isMultiTap && session.tapTracker.count >= 3) {
        state = selectLineAtPosition(state, position);
      }

      // If tapping inside a selection (single or double tap), open context menu (mobile UX)
      // Use pixel-based check to account for text wrapping - only trigger if tap is on actual selection boxes
      else if (
        isPointWithinSelectionRects(
          tapPosition.x,
          tapPosition.y,
          state,
          viewport,
        )
      ) {
        // Keep selection but update cursor position
        state = updateCursor(state, position);
        // Open context menu at tap position (or keep open if already open)
        if (state.ui.activeMenu.type !== "contextMenu") {
          state = openContextMenu(state, tapPosition.x, tapPosition.y);
        }
      }

      // Handle double-tap: select word
      else if (isMultiTap && session.tapTracker.count === 2) {
        state = selectWordAtPosition(state, position);
        // Close any active menu when making new selection
        if (state.ui.activeMenu.type === "contextMenu") {
          state = closeActiveMenu(state);
        }
      }

      // Single tap outside selection: position cursor and close context menu
      else {
        state = clearSelection(state);
        state = updateCursor(state, position);
        state = updateMode(state, "edit");
        // Close any active menu when tapping outside
        if (state.ui.activeMenu.type === "contextMenu") {
          state = closeActiveMenu(state);
        }
      }
    } else {
      // Tapping outside editor area (padding/margins) - clear selection and close menus
      state = clearSelection(state);
      state = updateMode(state, "edit");
      if (state.ui.activeMenu.type === "contextMenu") {
        state = closeActiveMenu(state);
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

  // End cursor drag if active
  if (state.ui.cursorDrag) {
    state = {
      ...state,
      ui: {
        ...state.ui,
        cursorDrag: null,
      },
    };
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
