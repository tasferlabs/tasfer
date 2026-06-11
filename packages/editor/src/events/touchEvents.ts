import {
  selectLineAtPosition,
  selectWordAtPosition,
} from "../actions/commands";
import {
  CURSOR_TOUCH_RADIUS,
  DOUBLE_CLICK_TIME,
  EDGE_SCROLL_THRESHOLD,
  MOVEMENT_THRESHOLD,
  SCROLLBAR_TOUCH_BUFFER,
  TAP_DISTANCE_THRESHOLD,
  TAP_MAX_DURATION,
} from "../constants";
import { imageCache } from "../rendering/renderer";
import {
  endScrollbarDrag,
  isPointInThumb,
  updateScrollFromThumbDrag,
} from "../rendering/scrollbar";
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
import {
  activateScroll,
  autoScrollState,
  clearScrollPress,
  scrollbarPressState,
} from "./eventsState";
import {
  endImageDrag,
  getAtomicBlockAtPoint,
  getSelectionHandleAtPoint,
  isWithinClickDistance,
  startImageDrag,
  updateImageDrag,
} from "./eventUtils";
import { handleTodoCheckboxClick } from "./mouseEvents";

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

// Touch state storage (needs to be outside functions to persist between events)
export let touchState: {
  startY: number;
  startScrollY: number;
  lastY: number;
  lastTime: number;
  velocityY: number;
  velocityHistory: Array<{ velocity: number; time: number }>;
  isScrollbarDrag: boolean;
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
} | null = null;
// Touch tap tracking for double/triple tap detection (similar to clickTracker)
export let touchTapTracker: {
  lastTapTime: number;
  lastTapPosition: { x: number; y: number } | null;
  count: number;
} = {
  lastTapTime: 0,
  lastTapPosition: null,
  count: 0,
};

/**
 * Trigger haptic feedback through native bridges
 */
export function triggerHapticFeedback(
  style: "light" | "medium" | "heavy" = "heavy",
): void {
  try {
    // Native bridge (iOS / Android)
    if (window.CypherBridge) {
      window.CypherBridge.haptic.trigger(style);
      return;
    }

    // Fallback: Standard Vibration API (works on Android Chrome web, not in WebView usually)
    if ("vibrate" in navigator) {
      const duration = style === "light" ? 10 : style === "medium" ? 20 : 50;
      navigator.vibrate(duration);
    }
  } catch (e) {
    // Silently fail if haptics not supported
    console.debug("Haptic feedback not supported:", e);
  }
}
export function startAutoScroll() {
  if (!autoScrollState.isActive) {
    autoScrollState.isActive = true;
    autoScrollState.startTime = Date.now();
    autoScrollState.currentSpeedMultiplier = 1;
  }
}
export function stopAutoScroll() {
  autoScrollState.isActive = false;
  autoScrollState.startTime = 0;
  autoScrollState.currentSpeedMultiplier = 1;
}

export function isInLongPressMode(): boolean {
  return touchState?.isLongPress === true;
}
export function handleTouchStart(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  containerRect: { left: number; top: number },
  documentHeight: number,
): EditorState {
  // In locked mode, block touch interactions that might lead to scrolling
  if (state.ui.mode === "locked") {
    return state;
  }

  // In readonly mode, only allow scrolling (no selection handle drag or image drag)
  const isReadonly = state.ui.mode === "readonly";

  // Handle two-finger scroll
  if (event.touches.length === 2) {
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();

    // Calculate average position of both fingers
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;

    touchState = {
      startY: avgY,
      startScrollY: viewport.scrollY,
      lastY: avgY,
      lastTime: currentTime,
      velocityY: 0,
      velocityHistory: [],
      isScrollbarDrag: false,
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

    // iOS-style: Check if touching scrollbar thumb (requires hold to activate)
    // Use a larger buffer area for easier touch detection on mobile
    const isScrollbarThumbTouch = isPointInThumb(
      canvasX,
      canvasY,
      viewport,
      documentHeight,
      state.view.scrollbar,
      undefined, // Use default styles
      SCROLLBAR_TOUCH_BUFFER,
    );

    // Check if touching a selection handle for mobile selection dragging
    // Block selection handle drag in readonly mode
    const selectionHandle = !isReadonly
      ? getSelectionHandleAtPoint(canvasX, canvasY, state, viewport)
      : null;
    if (selectionHandle && !isScrollbarThumbTouch) {
      // Start selection handle drag
      touchState = {
        startY: canvasY,
        startScrollY: viewport.scrollY,
        lastY: canvasY,
        lastTime: currentTime,
        velocityY: 0,
        velocityHistory: [],
        isScrollbarDrag: false,
        startX: canvasX,
        startTime: currentTime,
        isLongPress: false,
        hasMoved: false,
        currentTouchX: canvasX,
        currentTouchY: canvasY,
        isTouchingSelection: true, // We're on a selection
        isTouchingCursor: false,
        isCursorDrag: false,
        touchRadiusY: touch.radiusY ?? 0,
      };

      return {
        ...state,
        ui: {
          ...state.ui,
          selectionHandleDrag: {
            handleType: selectionHandle,
            startX: canvasX,
            startY: canvasY,
          },
        },
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
          momentum: {
            velocity: 0,
            lastTime: Date.now(),
            isActive: false,
          },
        },
      };
    }

    // Check if touching an image drag handle (with larger tolerance for touch)
    // Block image drag in readonly mode
    const imageBlock = getAtomicBlockAtPoint(
      canvasX,
      canvasY,
      state,
      viewport,
      "image",
    );
    const TOUCH_TOLERANCE = 12; // Larger tolerance for touch devices
    if (imageBlock && !isScrollbarThumbTouch && !isReadonly) {
      const dragState = startImageDrag(
        state,
        imageBlock,
        canvasX,
        canvasY,
        TOUCH_TOLERANCE,
      );
      if (dragState) {
        // Start image drag - initialize touch state but don't treat as scroll
        touchState = {
          startY: canvasY,
          startScrollY: viewport.scrollY,
          lastY: canvasY,
          lastTime: currentTime,
          velocityY: 0,
          velocityHistory: [],
          isScrollbarDrag: false,
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

        return {
          ...dragState,
          view: {
            ...dragState.view,
            scrollbar: {
              ...dragState.view.scrollbar,
              lastInteraction: Date.now(),
            },
            momentum: {
              velocity: 0,
              lastTime: Date.now(),
              isActive: false,
            },
          },
        };
      }
    }

    // Check if touching within existing selection (use pixel-based check for accuracy)
    const isTouchingSelection = isPointWithinSelectionRects(
      canvasX,
      canvasY,
      state,
      viewport,
    );

    // iOS-style: If touching scrollbar thumb, start hold timer (don't activate immediately)
    if (isScrollbarThumbTouch) {
      activateScroll(currentTime, canvasX, canvasY);

      // Set up minimal touch state for scrollbar interaction
      touchState = {
        startY: canvasY,
        startScrollY: viewport.scrollY,
        lastY: canvasY,
        lastTime: currentTime,
        velocityY: 0,
        velocityHistory: [],
        isScrollbarDrag: false, // Not dragging yet, waiting for hold
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

      touchState = {
        startY: canvasY,
        startScrollY: viewport.scrollY,
        lastY: canvasY,
        lastTime: currentTime,
        velocityY: 0,
        velocityHistory: [],
        isScrollbarDrag: false,
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
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
): EditorState {
  // In locked mode, block scrolling
  if (state.ui.mode === "locked") {
    return state;
  }

  // Handle transition from two-finger to single-finger (user lifted one finger)
  if (event.touches.length === 1 && touchState?.isTwoFingerScroll) {
    // User lifted one finger during two-finger scroll - end the scroll with momentum
    const avgVelocity = touchState.velocityY;
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

    touchState = null;
    return state;
  }

  // Handle transition from single to two-finger scroll
  if (
    event.touches.length === 2 &&
    touchState &&
    !touchState.isTwoFingerScroll
  ) {
    // User added a second finger - switch to two-finger scroll mode
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;

    touchState = {
      ...touchState,
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
    stopAutoScroll();
  }

  // Handle two-finger scroll
  if (event.touches.length === 2 && touchState?.isTwoFingerScroll) {
    event.preventDefault();
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    const currentTime = Date.now();
    const deltaTime = currentTime - touchState.lastTime;

    // Skip if no time has passed
    if (deltaTime === 0) return state;

    // Calculate average position of both fingers
    const avgY = (touch1.clientY + touch2.clientY) / 2 - containerRect.top;

    // Calculate scroll delta
    const scrollDeltaY = touchState.lastY - avgY;

    // Calculate instantaneous velocity (pixels per millisecond)
    const instantVelocity = scrollDeltaY / deltaTime;

    // Track velocity for momentum
    if (Math.abs(instantVelocity) > 0.01) {
      touchState.velocityHistory.push({
        velocity: instantVelocity,
        time: currentTime,
      });
    }

    // Keep only last 150ms of velocity history
    touchState.velocityHistory = touchState.velocityHistory.filter(
      (v) => currentTime - v.time < 150,
    );

    // Update velocity for momentum
    if (touchState.velocityHistory.length > 0) {
      const totalVelocity = touchState.velocityHistory.reduce(
        (sum, v) => sum + v.velocity,
        0,
      );
      touchState.velocityY = totalVelocity / touchState.velocityHistory.length;
    }

    // Apply scroll with multiplier for responsive feel
    const touchScrollMultiplier = 1.5;
    const scrollDelta = (touchState.startY - avgY) * touchScrollMultiplier;

    // Update scroll position with boundaries
    const maxScroll = documentHeight - viewport.height;
    const newScrollY = Math.max(
      0,
      Math.min(maxScroll, touchState.startScrollY + scrollDelta),
    );

    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }

    touchState.lastY = avgY;
    touchState.lastTime = currentTime;

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

  if (event.touches.length === 1 && touchState) {
    event.preventDefault();
    const touch = event.touches[0];
    const currentTime = Date.now();
    const deltaTime = currentTime - touchState.lastTime;
    const canvasX = touch.clientX - containerRect.left;
    const canvasY = touch.clientY - containerRect.top;

    // Skip if no time has passed
    if (deltaTime === 0) return state;

    // Handle scrollbar drag
    if (touchState.isScrollbarDrag && state.view.scrollbar.isDragging) {
      const newScrollY = updateScrollFromThumbDrag(
        canvasY,
        viewport,
        documentHeight,
        state.view.scrollbar,
      );
      if (updateViewportCallback) {
        updateViewportCallback({ scrollY: newScrollY });
      }
      // Clear link hover overlay when scrolling via scrollbar
      return {
        ...state,
        ui: {
          ...state.ui,
          activeMenu: { type: "none" },
          isHoveringLinkWithModifier: false,
          imageHover: null,
        },
      };
    }

    // Handle image drag resize
    if (state.ui.imageDrag) {
      touchState.lastY = canvasY;
      touchState.lastTime = currentTime;
      touchState.currentTouchX = canvasX;
      touchState.currentTouchY = canvasY;

      const { blockIndex, handle } = state.ui.imageDrag;
      const block = state.document.page.blocks[blockIndex];
      if (!block || block.deleted) return state;

      // Check if we should allow auto-scroll for bottom edge
      // Only block scrolling down if: bottom handle + near bottom edge + image at max height
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
          // Use startHeight + delta to get current effective height
          const currentHeight =
            state.ui.imageDrag.startHeight +
            (canvasY - state.ui.imageDrag.startY);
          const isAtMaxHeight = currentHeight >= maxHeightForRatio - 1;
          const isNearBottomEdge =
            canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
            canvasY > viewport.height;
          shouldBlockBottomScroll = isAtMaxHeight && isNearBottomEdge;
        }
      }

      // Check for edge scrolling during image drag
      const isNearTopEdge = canvasY < EDGE_SCROLL_THRESHOLD || canvasY < 0;
      const isNearBottomEdge =
        canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
        canvasY > viewport.height;
      const isNearEdge = isNearTopEdge || isNearBottomEdge;

      // Allow scroll if near edge, but block bottom scroll if image is at max
      if (isNearEdge && !(shouldBlockBottomScroll && isNearBottomEdge)) {
        if (!autoScrollState.isActive) {
          startAutoScroll();
        }
        autoScrollState.lastMouseX = canvasX;
        autoScrollState.lastMouseY = canvasY;
      } else {
        if (autoScrollState.isActive) {
          stopAutoScroll();
        }
      }

      return {
        ...updateImageDrag(state, viewport, canvasX, canvasY),
        view: {
          ...state.view,
          scrollbar: {
            ...state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      };
    }

    // Handle selection handle drag
    if (state.ui.selectionHandleDrag) {
      touchState.lastY = canvasY;
      touchState.lastTime = currentTime;
      touchState.currentTouchX = canvasX;
      touchState.currentTouchY = canvasY;

      // Check for edge scrolling during selection handle drag
      const isNearEdge =
        canvasY < EDGE_SCROLL_THRESHOLD ||
        canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
        canvasY < 0 ||
        canvasY > viewport.height;

      if (isNearEdge) {
        if (!autoScrollState.isActive) {
          startAutoScroll();
        }
        autoScrollState.lastMouseX = canvasX;
        autoScrollState.lastMouseY = canvasY;
      } else {
        if (autoScrollState.isActive) {
          stopAutoScroll();
        }
      }

      // Get the new position based on touch location
      const newPosition = getTextPositionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
      );

      if (newPosition && state.document.selection) {
        const { handleType } = state.ui.selectionHandleDrag;
        const { anchor, focus } = state.document.selection;

        let newAnchor = anchor;
        let newFocus = focus;

        if (handleType === "anchor") {
          // Dragging anchor - update anchor position, keep focus
          newAnchor = newPosition;
        } else {
          // Dragging focus - update focus position, keep anchor
          newFocus = newPosition;
        }

        // Determine if selection is now forward or backward
        const isForward =
          newAnchor.blockIndex < newFocus.blockIndex ||
          (newAnchor.blockIndex === newFocus.blockIndex &&
            newAnchor.textIndex <= newFocus.textIndex);

        // Check if selection is collapsed
        const isCollapsed =
          newAnchor.blockIndex === newFocus.blockIndex &&
          newAnchor.textIndex === newFocus.textIndex;

        state = {
          ...state,
          document: {
            ...state.document,
            selection: {
              anchor: newAnchor,
              focus: newFocus,
              isForward,
              isCollapsed,
              lastUpdate: Date.now(),
            },
            cursor: {
              position: handleType === "anchor" ? newAnchor : newFocus,
              lastUpdate: Date.now(),
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

    // Handle cursor drag mode (mobile cursor repositioning with magnifier)
    if (touchState.isCursorDrag) {
      touchState.lastY = canvasY;
      touchState.lastTime = currentTime;
      touchState.currentTouchX = canvasX;
      touchState.currentTouchY = canvasY;
      touchState.touchRadiusY = touch.radiusY ?? touchState.touchRadiusY;

      // Check for edge scrolling during cursor drag
      const isNearEdge =
        canvasY < EDGE_SCROLL_THRESHOLD ||
        canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
        canvasY < 0 ||
        canvasY > viewport.height;

      if (isNearEdge) {
        if (!autoScrollState.isActive) {
          startAutoScroll();
        }
        autoScrollState.lastMouseX = canvasX;
        autoScrollState.lastMouseY = canvasY;
      } else {
        if (autoScrollState.isActive) {
          stopAutoScroll();
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
    const deltaX = Math.abs(canvasX - touchState.startX);
    const deltaY = Math.abs(canvasY - touchState.startY);
    const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Update current touch position for auto-scroll
    touchState.currentTouchX = canvasX;
    touchState.currentTouchY = canvasY;

    // If moved beyond threshold, mark as moved (cancels potential long press)
    if (!touchState.hasMoved && totalMovement > MOVEMENT_THRESHOLD) {
      touchState.hasMoved = true;

      // Cancel scrollbar press state if user moves (they're not trying to hold it)
      if (scrollbarPressState) {
        clearScrollPress();
      }

      // Close all menus on movement - scrolling has priority
      // But don't close menus if we're about to enter cursor drag mode
      if (state.ui.activeMenu.type !== "none" && !touchState.isTouchingCursor) {
        state = closeActiveMenu(state);
      }
    }

    // Handle long press text selection mode
    // Block long-press text selection in readonly mode
    if (touchState.isLongPress && state.ui.mode !== "readonly") {
      // If context menu is open, allow drag-and-release interaction
      // Don't start text selection - user might be dragging to menu item
      if (state.ui.activeMenu.type === "contextMenu") {
        touchState.lastY = canvasY;
        touchState.lastTime = currentTime;

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
      if (!touchState.isTouchingSelection) {
        // Start selection mode if not already in it
        if (state.ui.mode !== "select") {
          const position = getTextPositionFromViewport(
            touchState.startX,
            touchState.startY,
            state,
            viewport,
          );

          if (position) {
            state = startSelection(state, position);
            state = updateMode(state, "select");
          }
        }

        if (!autoScrollState.isActive) {
          startAutoScroll();
        }

        touchState.lastY = canvasY;
        touchState.lastTime = currentTime;

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
        touchState.lastY = canvasY;
        touchState.lastTime = currentTime;
        return state;
      }
    }

    // Default: Handle scrolling
    const scrollDeltaY = touchState.lastY - canvasY;

    // Calculate instantaneous velocity (pixels per millisecond)
    const instantVelocity = scrollDeltaY / deltaTime;

    // Only track velocity if there's actual movement (avoid diluting with zeros)
    // This prevents touchmove events with no vertical movement from adding 0-velocity entries
    if (Math.abs(instantVelocity) > 0.01) {
      touchState.velocityHistory.push({
        velocity: instantVelocity,
        time: currentTime,
      });
    }

    // Keep only last 150ms of velocity history (increased from 100ms to be more reliable)
    touchState.velocityHistory = touchState.velocityHistory.filter(
      (v) => currentTime - v.time < 150,
    );

    // Always update velocity for momentum (use average if history exists)
    if (touchState.velocityHistory.length > 0) {
      const totalVelocity = touchState.velocityHistory.reduce(
        (sum, v) => sum + v.velocity,
        0,
      );
      touchState.velocityY = totalVelocity / touchState.velocityHistory.length;
      // console.log("touchState.velocityY", touchState.velocityY);
    }
    // Apply scroll speed multiplier for more responsive feel on mobile
    // 1.5x makes scrolling feel more direct and responsive
    const touchScrollMultiplier = 1.5;
    const scrollDelta = (touchState.startY - canvasY) * touchScrollMultiplier;

    // Update scroll position with hard boundaries
    const maxScroll = documentHeight - viewport.height;
    const newScrollY = Math.max(
      0,
      Math.min(maxScroll, touchState.startScrollY + scrollDelta),
    );

    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }

    touchState.lastY = canvasY;
    touchState.lastTime = currentTime;
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
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  stopAutoScroll();

  // Handle two-finger scroll end with momentum
  if (touchState?.isTwoFingerScroll) {
    const avgVelocity = touchState.velocityY;
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

    touchState = null;
    return { state, ops };
  }

  // Clean up scrollbar press state (iOS-style hold)
  if (scrollbarPressState) {
    clearScrollPress();
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
    touchState = null;
    return {
      state: {
        ...state,
        ui: {
          ...state.ui,
          selectionHandleDrag: null,
        },
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

  // End cursor drag if active
  if (touchState?.isCursorDrag) {
    const didNotMove = !touchState.hasMoved;
    const touchX = touchState.currentTouchX;
    const touchY = touchState.currentTouchY;
    triggerHapticFeedback("medium");
    touchState = null;

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

  // End image drag if active
  if (state.ui.imageDrag) {
    touchState = null;
    const endDragResult = endImageDrag(state);
    return {
      state: {
        ...endDragResult.state,
        view: {
          ...endDragResult.state.view,
          scrollbar: {
            ...endDragResult.state.view.scrollbar,
            lastInteraction: Date.now(),
          },
        },
      },
      ops: endDragResult.ops,
    };
  }

  // Handle drag-and-release for context menu (power user feature)
  // Check if context menu is open and user is releasing (possibly over a menu item)
  if (state.ui.activeMenu.type === "contextMenu" && touchState?.isLongPress) {
    // Use the hoveredItemId from the state (already tracked during touchmove)
    const hoveredItemId = state.ui.activeMenu.hoveredItemId;

    if (hoveredItemId) {
      // User released on a menu item - mark it as selected
      // MountedEditor will detect this and execute the action
      state = selectContextMenuItem(state, hoveredItemId);
      touchState = null;
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
      touchState = null;
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
  if (touchState?.isLongPress) {
    if (touchState.isTouchingSelection) {
      // Long pressed on existing selection - context menu already shown, just cleanup
      touchState = null;
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
      touchState = null;

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
        touchState.currentTouchX,
        touchState.currentTouchY,
      );
      touchState = null;
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
    touchState &&
    !touchState.isScrollbarDrag &&
    !touchState.hasMoved &&
    currentTime - touchState.startTime < TAP_MAX_DURATION;

  if (isTap && touchState) {
    const tapPosition = { x: touchState.startX, y: touchState.startY };

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

      touchState = null;
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

        touchState = null;
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

    // Check for tap on todo checkbox
    const checkboxTapResult = handleTodoCheckboxClick(
      state,
      tapPosition.x,
      tapPosition.y,
      viewport,
    );
    if (checkboxTapResult) {
      touchState = null;
      return {
        state: checkboxTapResult.state,
        ops: checkboxTapResult.ops,
      };
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
      touchTapTracker.lastTapPosition &&
      currentTime - touchTapTracker.lastTapTime <= DOUBLE_CLICK_TIME &&
      isWithinClickDistance(
        tapPosition,
        touchTapTracker.lastTapPosition,
        TAP_DISTANCE_THRESHOLD,
      )
    ) {
      touchTapTracker.count++;
      isMultiTap = true;
    } else {
      touchTapTracker.count = 1;
    }

    touchTapTracker.lastTapTime = currentTime;
    touchTapTracker.lastTapPosition = tapPosition;

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

          touchState = null;
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
              touchState = null;
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
            touchState = null;
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

          touchState = null;
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

            touchState = null;
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

          touchState = null;
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
      if (isMultiTap && touchTapTracker.count >= 3) {
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
      else if (isMultiTap && touchTapTracker.count === 2) {
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

    touchState = null;
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
  if (touchState && !touchState.isScrollbarDrag && !touchState.isLongPress) {
    // Use the average velocity from recent history
    const avgVelocity = touchState.velocityY;

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

  touchState = null;

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
export function handleTouchCancel(state: EditorState): EditorState {
  stopAutoScroll();

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
  if (touchState?.isLongPress && state.ui.mode === "select") {
    state = updateMode(state, "edit");
  }

  // Clear touch state
  touchState = null;

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
