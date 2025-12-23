import {
  deleteText,
  deleteForward,
  insertText,
  splitBlock,
  extendSelectionWordLeft,
  extendSelectionWordRight,
  moveToPreviousWord,
  moveToNextWord,
  selectWordAtPosition,
  selectLineAtPosition,
  moveToLineStart,
  moveToLineEnd,
} from "./commands";
import { getTextPositionFromViewport } from "./selection";
import {
  clearSelection,
  getBlockTextLength,
  moveCursorDown,
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
  moveCursorUp,
  startSelection,
  updateCursor,
  updateMode,
  updateSelectionFocus,
  extendSelectionLeft,
  extendSelectionRight,
  extendSelectionUp,
  extendSelectionDown,
} from "./state";
import {
  isPointInScrollbar,
  isPointInThumb,
  updateScrollbarHover,
  startScrollbarDrag,
  endScrollbarDrag,
  updateScrollFromThumbDrag,
  updateScrollFromTrackClick,
  updateScrollFromWheel,
  updateScrollbarFadeOpacity,
  applyMomentum,
} from "./scrollbar";
import type {
  EditorState,
  MouseEvent,
  ViewportState,
  KeyboardEvent,
} from "./types";
import { recordUndo, undoState, redoState } from "./undo";

const DOUBLE_CLICK_TIME = 500; // ms
const CLICK_DISTANCE_THRESHOLD = 5; // pixels
const TAP_DISTANCE_THRESHOLD = 30; // pixels - larger for touch to account for finger movement

function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}

function isWithinClickDistance(
  pos1: { x: number; y: number },
  pos2: { x: number; y: number },
  threshold: number = CLICK_DISTANCE_THRESHOLD
): boolean {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  return Math.sqrt(dx * dx + dy * dy) <= threshold;
}

function isPositionWithinSelection(
  state: EditorState,
  position: { blockIndex: number; textIndex: number }
): boolean {
  if (!state.selection) return false;

  const { anchor, focus } = state.selection;

  const selStart =
    anchor.blockIndex < focus.blockIndex ||
    (anchor.blockIndex === focus.blockIndex && anchor.textIndex <= focus.textIndex)
      ? anchor
      : focus;
  const selEnd = selStart === anchor ? focus : anchor;

  if (selStart.blockIndex === selEnd.blockIndex && selStart.textIndex === selEnd.textIndex) {
    return false;
  }

  if (position.blockIndex < selStart.blockIndex || position.blockIndex > selEnd.blockIndex) {
    return false;
  }

  if (position.blockIndex === selStart.blockIndex && position.textIndex < selStart.textIndex) {
    return false;
  }

  if (position.blockIndex === selEnd.blockIndex && position.textIndex > selEnd.textIndex) {
    return false;
  }

  return true;
}

export function handleEvents(
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  events: Event[],
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  // Apply momentum scrolling if active (even when no events)
  if (state.momentum.isActive) {
    const momentumResult = applyMomentum(
      viewport.scrollY,
      state.momentum,
      documentHeight,
      viewport.height
    );

    if (updateViewportCallback && momentumResult.scrollY !== viewport.scrollY) {
      updateViewportCallback({ scrollY: momentumResult.scrollY });
    }

    state = {
      ...state,
      momentum: momentumResult.momentumState,
      scrollbar: {
        ...state.scrollbar,
        lastInteraction: Date.now(),
      },
    };
  }

  if (events.length === 0) {
    // Update scrollbar fade opacity even when no events
    state = {
      ...state,
      scrollbar: updateScrollbarFadeOpacity(state.scrollbar),
    };
    return state;
  }

  for (const event of events) {
    switch (event.type) {
      case "mousedown":
        if (isTouchDevice()) {
          break;
        }
        state = handleMouseDown(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility,
          documentHeight,
          updateViewportCallback
        );
        break;
      case "mousemove":
        if (isTouchDevice()) {
          break;
        }
        state = handleMouseMove(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility,
          documentHeight,
          updateViewportCallback
        );
        break;
      case "mouseup":
        if (isTouchDevice()) {
          break;
        }
        state = handleMouseUp(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility
        );
        break;
      case "pointercancel":
        // Only cancel on pointercancel (not on leave)
        state = handlePointerCancel(state);
        break;
      case "keydown":
        state = handleKeyDown(state, viewport, event);
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
          updateViewportCallback
        );
        break;
      case "touchstart":
        state = handleTouchStart(
          state,
          viewport,
          event as TouchEvent,
          documentHeight
        );
        break;
      case "touchmove":
        state = handleTouchMove(
          state,
          viewport,
          event as TouchEvent,
          documentHeight,
          updateViewportCallback
        );
        break;
      case "touchend":
        state = handleTouchEnd(state, viewport, event as TouchEvent);
        break;
      case "touchcancel":
        // Cancel touch interaction
        state = handleTouchCancel(state);
        break;
    }

    events.shift();
  }

  // Update scrollbar fade opacity
  state = {
    ...state,
    scrollbar: updateScrollbarFadeOpacity(state.scrollbar),
  };

  return state;
}

function handleMouseDown(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  // Stop any momentum scrolling when user interacts
  state = {
    ...state,
    momentum: {
      velocity: 0,
      lastTime: Date.now(),
      isActive: false,
    },
  };

  // Check if clicking on scrollbar
  if (isPointInScrollbar(event.x, event.y, viewport, documentHeight)) {
    // Check if clicking on thumb
    if (
      isPointInThumb(
        event.x,
        event.y,
        viewport,
        documentHeight,
        state.scrollbar
      )
    ) {
      return {
        ...state,
        scrollbar: startScrollbarDrag(state.scrollbar),
      };
    } else {
      // Clicking on track - page scroll
      const newScrollY = updateScrollFromTrackClick(
        event.y,
        viewport,
        documentHeight,
        state.scrollbar
      );
      if (updateViewportCallback) {
        updateViewportCallback({ scrollY: newScrollY });
      }
      return {
        ...state,
        scrollbar: {
          ...state.scrollbar,
          lastInteraction: Date.now(),
        },
      };
    }
  }

  const position = getTextPositionFromViewport(
    event.x,
    event.y,
    state,
    viewport,
    visibility
  );

  if (!position) {
    const clearedState = clearSelection(state);
    return updateMode(clearedState, "edit");
  }

  // Track click for double/triple click detection
  const currentTime = Date.now();
  const currentPosition = { x: event.x, y: event.y };

  let isMultiClick = false;

  if (
    state.clickTracker.lastClickPosition &&
    currentTime - state.clickTracker.lastClickTime <= DOUBLE_CLICK_TIME &&
    isWithinClickDistance(currentPosition, state.clickTracker.lastClickPosition)
  ) {
    state.clickTracker.count++;
    isMultiClick = true;
  } else {
    state.clickTracker.count = 1;
  }

  state.clickTracker.lastClickTime = currentTime;
  state.clickTracker.lastClickPosition = currentPosition;

  // Handle triple-click: always select line (even inside selection)
  if (isMultiClick && state.clickTracker.count >= 3) {
    return selectLineAtPosition(state, position);
  }

  // If clicking inside a selection (single or double click), don't reset it (Apple Notes behavior)
  if (isPositionWithinSelection(state, position)) {
    return state;
  }

  // Handle double-click: select word
  if (isMultiClick && state.clickTracker.count === 2) {
    return selectWordAtPosition(state, position);
  }

  // Set cursor position
  let newState = updateCursor(state, position);

  // If shift is held, extend selection; otherwise start new selection
  if (event.shiftKey && state.selection) {
    newState = updateSelectionFocus(newState, position);
  } else {
    // Start selection at cursor position
    newState = startSelection(newState, position);
    // Enter select mode if not already
    newState = updateMode(newState, "select");
  }

  return newState;
}

function handleMouseMove(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  // Handle scrollbar drag
  if (state.scrollbar.isDragging) {
    const newScrollY = updateScrollFromThumbDrag(
      event.y,
      viewport,
      documentHeight,
      state.scrollbar
    );
    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }
    return state;
  }

  // Update scrollbar hover state
  const isOverScrollbar = isPointInScrollbar(
    event.x,
    event.y,
    viewport,
    documentHeight
  );
  // Use entire scrollbar area (track + thumb) for hover detection
  // This affects both cursor style and thumb visual feedback
  state = {
    ...state,
    scrollbar: updateScrollbarHover(state.scrollbar, isOverScrollbar),
  };

  // Only handle mouse move if we're in select mode (dragging)
  if (state.mode !== "select") {
    return state;
  }

  const position = getTextPositionFromViewport(
    event.x,
    event.y,
    state,
    viewport,
    visibility
  );

  if (!position) return state;

  // Update selection focus and cursor position
  let newState = updateSelectionFocus(state, position);
  newState = updateCursor(newState, position);

  // if (newState !== null && newState.selection !== null) {
  //   if (newState.selection.isForward) {
  //     console.log(
  //       `$anchor:${newState.selection.anchor.blockIndex}:${newState.selection.anchor.textIndex} focus: ${newState.selection.focus.blockIndex}:${newState.selection.focus.textIndex}`
  //     );
  //   } else {
  //     console.log(
  //       `$focus:${newState.selection.focus.blockIndex}:${newState.selection.focus.textIndex} anchor: ${newState.selection.anchor.blockIndex}:${newState.selection.focus.textIndex}`
  //     );
  //   }
  // }
  return newState;
}

function handleMouseUp(
  state: EditorState,
  _viewport: ViewportState,
  _event: MouseEvent,
  _visibility: { start: number; end: number }
): EditorState {
  // End scrollbar drag
  if (state.scrollbar.isDragging) {
    return {
      ...state,
      scrollbar: endScrollbarDrag(state.scrollbar),
    };
  }

  // Exit select mode and return to edit mode
  if (state.mode === "select") {
    return updateMode(state, "edit");
  }

  return state;
}

function handlePointerCancel(state: EditorState): EditorState {
  // Only cancel on explicit pointer cancellation (not just leaving)
  // End scrollbar drag if active
  if (state.scrollbar.isDragging) {
    state = {
      ...state,
      scrollbar: endScrollbarDrag(state.scrollbar),
    };
  }

  // Exit select mode and return to edit mode
  if (state.mode === "select") {
    state = updateMode(state, "edit");
  }

  return state;
}

function handleKeyDown(
  state: EditorState,
  _viewport: ViewportState,
  event: Event
): EditorState {
  const keyEvent = event as unknown as KeyboardEvent;
  const key = keyEvent.key;
  const keyLower = key.toLowerCase();
  const isCtrl = keyEvent.ctrlKey || keyEvent.metaKey;

  // Undo/Redo
  if (isCtrl && keyLower === "z" && !keyEvent.shiftKey) {
    return undoState(state);
  }
  if (isCtrl && (keyLower === "y" || (keyEvent.shiftKey && keyLower === "z"))) {
    return redoState(state);
  }

  // Navigation & selection
  switch (key) {
    case "ArrowLeft":
      if (isCtrl && keyEvent.shiftKey) {
        return extendSelectionWordLeft(state);
      } else if (keyEvent.shiftKey) {
        return extendSelectionLeft(state);
      } else if (isCtrl) {
        return moveToPreviousWord(clearSelection(state));
      } else {
        return moveCursorLeft(clearSelection(state));
      }
    case "ArrowRight":
      if (isCtrl && keyEvent.shiftKey) {
        return extendSelectionWordRight(state);
      } else if (keyEvent.shiftKey) {
        return extendSelectionRight(state);
      } else if (isCtrl) {
        return moveToNextWord(clearSelection(state));
      } else {
        return moveCursorRight(clearSelection(state));
      }
    case "ArrowUp":
      if (keyEvent.shiftKey) {
        return extendSelectionUp(state);
      } else {
        return moveCursorUp(clearSelection(state));
      }
    case "ArrowDown":
      if (keyEvent.shiftKey) {
        return extendSelectionDown(state);
      } else {
        return moveCursorDown(clearSelection(state));
      }
    case "Home":
      if (isCtrl) {
        // Ctrl+Home: Go to document start
        return moveCursorToPosition(state, 0, 0);
      } else {
        // Home: Go to line start
        return moveToLineStart(state);
      }
    case "End":
      if (isCtrl) {
        // Ctrl+End: Go to document end
        return moveCursorToPosition(
          state,
          state.page.blocks.length - 1,
          getBlockTextLength(state.page.blocks[state.page.blocks.length - 1])
        );
      } else {
        // End: Go to line end
        return moveToLineEnd(state);
      }
    case "Escape":
      return clearSelection(state);
    case "Backspace":
      return deleteText(recordUndo(state));
    case "Delete":
      return deleteForward(recordUndo(state));
    case "Enter":
      return splitBlock(recordUndo(state));
    case " ":
    case "Space":
      return insertText(recordUndo(state), " ");
    default:
      if (
        key.length === 1 &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        return insertText(recordUndo(state), key);
      }
      return state;
  }
}

function handleWheel(
  state: EditorState,
  viewport: ViewportState,
  event: WheelEvent,
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  // Stop momentum when using wheel
  state = {
    ...state,
    momentum: {
      velocity: 0,
      lastTime: Date.now(),
      isActive: false,
    },
  };

  const { scrollY, scrollbarState } = updateScrollFromWheel(
    event.deltaY,
    viewport,
    documentHeight,
    state.scrollbar
  );

  if (updateViewportCallback) {
    updateViewportCallback({ scrollY });
  }

  return {
    ...state,
    scrollbar: scrollbarState,
  };
}

// Touch state storage (needs to be outside functions to persist between events)
let touchState: {
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
} | null = null;

// Touch tap tracking for double/triple tap detection (similar to clickTracker)
let touchTapTracker: {
  lastTapTime: number;
  lastTapPosition: { x: number; y: number } | null;
  count: number;
} = {
  lastTapTime: 0,
  lastTapPosition: null,
  count: 0,
};

const LONG_PRESS_DURATION = 400; // ms - time to wait before switching to text selection
const MOVEMENT_THRESHOLD = 10; // pixels - movement that cancels long press detection
const TAP_MAX_DURATION = 500; // ms - max duration for a gesture to count as a tap

function handleTouchStart(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  documentHeight: number
): EditorState {
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    const currentTime = Date.now();

    // Check if touch is near the right edge of screen (where scrollbar is)
    // Use a threshold (e.g., last 60px) to detect scrollbar area
    const edgeThreshold = 60;
    const isNearRightEdge = touch.clientX >= viewport.width - edgeThreshold;

    // Also check if actually hitting scrollbar
    const isScrollbarTouch =
      isNearRightEdge &&
      isPointInScrollbar(
        touch.clientX,
        touch.clientY,
        viewport,
        documentHeight
      );

    touchState = {
      startY: touch.clientY,
      startScrollY: viewport.scrollY,
      lastY: touch.clientY,
      lastTime: currentTime,
      velocityY: 0,
      velocityHistory: [],
      isScrollbarDrag: isScrollbarTouch,
      startX: touch.clientX,
      startTime: currentTime,
      isLongPress: false,
      hasMoved: false,
    };

    // If touching scrollbar, start drag
    if (isScrollbarTouch) {
      state = {
        ...state,
        scrollbar: startScrollbarDrag(state.scrollbar),
      };
    }

    // Stop any ongoing momentum
    state = {
      ...state,
      momentum: {
        velocity: 0,
        lastTime: Date.now(),
        isActive: false,
      },
    };
  }

  return {
    ...state,
    scrollbar: {
      ...state.scrollbar,
      lastInteraction: Date.now(),
    },
  };
}

function handleTouchMove(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  if (event.touches.length === 1 && touchState) {
    event.preventDefault();
    const touch = event.touches[0];
    const currentTime = Date.now();
    const deltaTime = currentTime - touchState.lastTime;

    // Skip if no time has passed
    if (deltaTime === 0) return state;

    // Handle scrollbar drag
    if (touchState.isScrollbarDrag && state.scrollbar.isDragging) {
      const newScrollY = updateScrollFromThumbDrag(
        touch.clientY,
        viewport,
        documentHeight,
        state.scrollbar
      );
      if (updateViewportCallback) {
        updateViewportCallback({ scrollY: newScrollY });
      }
      return state;
    }

    // Check if we've moved significantly from start position
    const deltaX = Math.abs(touch.clientX - touchState.startX);
    const deltaY = Math.abs(touch.clientY - touchState.startY);
    const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Detect long press: if user held still for LONG_PRESS_DURATION, switch to text selection
    const timeSinceStart = currentTime - touchState.startTime;
    if (
      !touchState.hasMoved &&
      !touchState.isLongPress &&
      timeSinceStart >= LONG_PRESS_DURATION &&
      totalMovement < MOVEMENT_THRESHOLD
    ) {
      // User held finger down without moving - activate long press mode
      touchState.isLongPress = true;
    }

    // If moved beyond threshold, mark as moved (cancels potential long press)
    if (!touchState.hasMoved && totalMovement > MOVEMENT_THRESHOLD) {
      touchState.hasMoved = true;
    }

    // Handle long press text selection mode
    if (touchState.isLongPress) {
      // Get position for text selection
      const position = getTextPositionFromViewport(
        touch.clientX,
        touch.clientY,
        state,
        viewport,
        { start: 0, end: state.page.blocks.length - 1 }
      );

      if (position) {
        // If not in select mode yet, start selection
        if (state.mode !== "select") {
          state = updateCursor(state, position);
          state = startSelection(state, position);
          state = updateMode(state, "select");
        } else {
          // Update selection focus
          state = updateSelectionFocus(state, position);
          state = updateCursor(state, position);
        }
      }

      touchState.lastY = touch.clientY;
      touchState.lastTime = currentTime;

      return {
        ...state,
        scrollbar: {
          ...state.scrollbar,
          lastInteraction: Date.now(),
        },
      };
    }

    // Default: Handle scrolling
    const scrollDeltaY = touchState.lastY - touch.clientY;

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
      (v) => currentTime - v.time < 150
    );

    // Always update velocity for momentum (use average if history exists)
    if (touchState.velocityHistory.length > 0) {
      const totalVelocity = touchState.velocityHistory.reduce(
        (sum, v) => sum + v.velocity,
        0
      );
      touchState.velocityY = totalVelocity / touchState.velocityHistory.length;
      // console.log("touchState.velocityY", touchState.velocityY);
    }
    // Apply scroll speed multiplier for more responsive feel on mobile
    // 1.5x makes scrolling feel more direct and responsive
    const touchScrollMultiplier = 1.5;
    const scrollDelta =
      (touchState.startY - touch.clientY) * touchScrollMultiplier;

    // Update scroll position with hard boundaries
    const maxScroll = documentHeight - viewport.height;
    const newScrollY = Math.max(
      0,
      Math.min(maxScroll, touchState.startScrollY + scrollDelta)
    );

    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }

    touchState.lastY = touch.clientY;
    touchState.lastTime = currentTime;
  }

  return {
    ...state,
    scrollbar: {
      ...state.scrollbar,
      lastInteraction: Date.now(),
    },
  };
}

function handleTouchEnd(
  state: EditorState,
  viewport: ViewportState,
  _event: TouchEvent
): EditorState {
  // End scrollbar drag if active
  if (state.scrollbar.isDragging) {
    state = {
      ...state,
      scrollbar: endScrollbarDrag(state.scrollbar),
    };
  }

  // If we were in long press text selection mode, exit select mode
  if (touchState?.isLongPress && state.mode === "select") {
    state = updateMode(state, "edit");
    touchState = null;
    return {
      ...state,
      scrollbar: {
        ...state.scrollbar,
        lastInteraction: Date.now(),
      },
    };
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

    // Get text position for cursor/selection
    const position = getTextPositionFromViewport(
      tapPosition.x,
      tapPosition.y,
      state,
      viewport,
      { start: 0, end: state.page.blocks.length - 1 }
    );

    // Check for multi-tap (double/triple) - use larger threshold for touch
    let isMultiTap = false;
    if (
      touchTapTracker.lastTapPosition &&
      currentTime - touchTapTracker.lastTapTime <= DOUBLE_CLICK_TIME &&
      isWithinClickDistance(tapPosition, touchTapTracker.lastTapPosition, TAP_DISTANCE_THRESHOLD)
    ) {
      touchTapTracker.count++;
      isMultiTap = true;
    } else {
      touchTapTracker.count = 1;
    }

    touchTapTracker.lastTapTime = currentTime;
    touchTapTracker.lastTapPosition = tapPosition;

    if (position) {
      // Handle triple-tap: always select line (even inside selection)
      if (isMultiTap && touchTapTracker.count >= 3) {
        state = selectLineAtPosition(state, position);
      }
      // If tapping inside a selection (single or double tap), don't reset it (Apple Notes behavior)
      else if (isPositionWithinSelection(state, position)) {
        // Do nothing, keep selection
      }
      // Handle double-tap: select word
      else if (isMultiTap && touchTapTracker.count === 2) {
        state = selectWordAtPosition(state, position);
      }
      // Single tap outside selection: position cursor
      else {
        state = clearSelection(state);
        state = updateCursor(state, position);
        state = updateMode(state, "edit");
      }
    }

    touchState = null;
    return {
      ...state,
      scrollbar: {
        ...state.scrollbar,
        lastInteraction: Date.now(),
      },
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
        momentum: {
          velocity: avgVelocity * momentumMultiplier,
          lastTime: Date.now(),
          isActive: true,
        },
      };
    }
  }

  touchState = null;

  return {
    ...state,
    scrollbar: {
      ...state.scrollbar,
      lastInteraction: Date.now(),
    },
  };
}

function handleTouchCancel(state: EditorState): EditorState {
  // End scrollbar drag if active
  if (state.scrollbar.isDragging) {
    state = {
      ...state,
      scrollbar: endScrollbarDrag(state.scrollbar),
    };
  }

  // If we were in long press text selection mode, exit select mode
  if (touchState?.isLongPress && state.mode === "select") {
    state = updateMode(state, "edit");
  }

  // Clear touch state
  touchState = null;

  return {
    ...state,
    scrollbar: {
      ...state.scrollbar,
      lastInteraction: Date.now(),
    },
  };
}
