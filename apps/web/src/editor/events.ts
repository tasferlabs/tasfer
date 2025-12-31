import type { Block } from "../deserializer/loadPage";
import { SLASH_COMMANDS } from "./SlashCommandMenu";
import { copySelectionToClipboard, pasteFromClipboardEvent } from "./clipboard";
import {
  applySlashCommand,
  deleteForward,
  deleteSelectedText,
  deleteText,
  deleteWordBackward,
  deleteWordForward,
  extendSelectionEnd,
  extendSelectionHome,
  extendSelectionWordLeft,
  extendSelectionWordRight,
  getSelectionRange,
  insertText,
  moveToLineEnd,
  moveToLineStart,
  moveToNextWord,
  moveToPreviousWord,
  selectAll,
  selectLineAtPosition,
  selectWordAtPosition,
  splitBlock,
  deleteTextRangeInFormattedContent,
} from "./commands";
import {
  CLICK_DISTANCE_THRESHOLD,
  CONTEXT_MENU_DURATION,
  DOUBLE_CLICK_TIME,
  EDGE_SCROLL_ACCELERATION_RATE,
  EDGE_SCROLL_MAX_SPEED,
  EDGE_SCROLL_SPEED,
  EDGE_SCROLL_THRESHOLD,
  MOVEMENT_THRESHOLD,
  TAP_DISTANCE_THRESHOLD,
  TAP_MAX_DURATION,
} from "./constants";
import {
  applyMomentum,
  endScrollbarDrag,
  isPointInScrollbar,
  isPointInThumb,
  startScrollbarDrag,
  updateScrollFromThumbDrag,
  updateScrollFromTrackClick,
  updateScrollFromWheel,
  updateScrollbarFadeOpacity,
  updateScrollbarHover,
} from "./scrollbar";
import {
  getTextPositionFromViewport,
  scrollToMakeCursorVisible,
  getLinkAtPosition,
  getCursorCoordinates,
} from "./selection";
import {
  clearSelection,
  closeSlashCommand,
  extendSelectionDown,
  extendSelectionLeft,
  extendSelectionPageDown,
  extendSelectionPageUp,
  extendSelectionRight,
  extendSelectionUp,
  getBlockTextContent,
  getBlockTextLength,
  moveCursorDown,
  moveCursorLeft,
  moveCursorPageDown,
  moveCursorPageUp,
  moveCursorRight,
  moveCursorToPosition,
  moveCursorUp,
  openSlashCommand,
  startSelection,
  updateCursor,
  updateFocus,
  updateMode,
  updateSelectionFocus,
  updateSlashCommandFilter,
  updateSlashCommandSelection,
  openContextMenu,
} from "./state";
import type {
  EditorState,
  KeyboardEvent,
  MouseEvent,
  ViewportState,
} from "./types";
import { recordUndo, redoState, undoState } from "./undo";

function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}

/**
 * Helper function to scroll viewport to make cursor visible after state changes
 * @param newState The new editor state
 * @param oldState The previous editor state
 * @param viewport Current viewport state
 * @param updateViewportCallback Callback to update the viewport scroll position
 */
function ensureCursorVisible(
  newState: EditorState,
  oldState: EditorState,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): void {
  if (newState !== oldState && newState.document.cursor && updateViewportCallback) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }
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
  if (!state.document.selection) return false;

  const { anchor, focus } = state.document.selection;

  const selStart =
    anchor.blockIndex < focus.blockIndex ||
    (anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex <= focus.textIndex)
      ? anchor
      : focus;
  const selEnd = selStart === anchor ? focus : anchor;

  if (
    selStart.blockIndex === selEnd.blockIndex &&
    selStart.textIndex === selEnd.textIndex
  ) {
    return false;
  }

  if (
    position.blockIndex < selStart.blockIndex ||
    position.blockIndex > selEnd.blockIndex
  ) {
    return false;
  }

  if (
    position.blockIndex === selStart.blockIndex &&
    position.textIndex < selStart.textIndex
  ) {
    return false;
  }

  if (
    position.blockIndex === selEnd.blockIndex &&
    position.textIndex > selEnd.textIndex
  ) {
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
  containerRect: { left: number; top: number },
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  clipboardData?: { html: string; text: string } | null
): EditorState {
  // Check for long press trigger (independent of touchmove events)
  if (
    touchState &&
    !touchState.isLongPress &&
    !touchState.hasMoved &&
    !touchState.isScrollbarDrag
  ) {
    const timeSinceStart = Date.now() - touchState.startTime;
    if (timeSinceStart >= CONTEXT_MENU_DURATION) {
      touchState.isLongPress = true;

      const position = getTextPositionFromViewport(
        touchState.currentTouchX,
        touchState.currentTouchY,
        state,
        viewport,
        visibility
      );

      if (position) {
        if (!state.document.selection || !isPositionWithinSelection(state, position)) {
          state = updateCursor(state, position);
          state = clearSelection(state);
        }
      }

      state = openContextMenu(
        state,
        touchState.currentTouchX,
        touchState.currentTouchY
      );

      // Blur active element
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  }

  // Apply auto-scroll and selection update during long press
  if (autoScrollState.isActive && touchState?.isLongPress) {
    // Current touch coordinates are already adjusted relative to container in handleTouchMove
    const touch = {
      clientY: touchState.currentTouchY,
      clientX: touchState.currentTouchX,
    };

    const elapsedTime = Date.now() - autoScrollState.startTime;
    const timeBasedMultiplier = Math.min(
      Math.pow(EDGE_SCROLL_ACCELERATION_RATE, elapsedTime / 1000),
      EDGE_SCROLL_MAX_SPEED / EDGE_SCROLL_SPEED
    );
    autoScrollState.currentSpeedMultiplier = timeBasedMultiplier;

    let autoScrollDelta = 0;

    if (touch.clientY < 0) {
      const distance = Math.abs(touch.clientY);
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        -EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (touch.clientY < EDGE_SCROLL_THRESHOLD) {
      const proximity = 1 - touch.clientY / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = -EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    } else if (touch.clientY > viewport.height) {
      const distance = touch.clientY - viewport.height;
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (touch.clientY > viewport.height - EDGE_SCROLL_THRESHOLD) {
      const proximity =
        (touch.clientY - (viewport.height - EDGE_SCROLL_THRESHOLD)) /
        EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    }

    if (autoScrollDelta !== 0 && updateViewportCallback) {
      const maxScroll = documentHeight - viewport.height;
      const newScrollY = Math.max(
        0,
        Math.min(maxScroll, viewport.scrollY + autoScrollDelta)
      );

      if (newScrollY !== viewport.scrollY) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }

    const position = getTextPositionFromViewport(
      touch.clientX,
      touch.clientY,
      state,
      viewport,
      { start: 0, end: state.document.page.blocks.length - 1 }
    );

    if (position) {
      if (state.ui.mode !== "select") {
        state = updateCursor(state, position);
        state = startSelection(state, position);
        state = updateMode(state, "select");
      } else {
        state = updateSelectionFocus(state, position);
        state = updateCursor(state, position);
      }
    }

    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: {
          ...state.view.scrollbar,
          lastInteraction: Date.now(),
        },
      },
    };
  } else if (autoScrollState.isActive && state.ui.mode === "select") {
    // Apply auto-scroll for mouse selection
    const elapsedTime = Date.now() - autoScrollState.startTime;
    const timeBasedMultiplier = Math.min(
      Math.pow(EDGE_SCROLL_ACCELERATION_RATE, elapsedTime / 1000),
      EDGE_SCROLL_MAX_SPEED / EDGE_SCROLL_SPEED
    );
    autoScrollState.currentSpeedMultiplier = timeBasedMultiplier;

    let autoScrollDelta = 0;
    const mouseY = autoScrollState.lastMouseY;

    if (mouseY < 0) {
      const distance = Math.abs(mouseY);
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        -EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (mouseY < EDGE_SCROLL_THRESHOLD) {
      const proximity = 1 - mouseY / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = -EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    } else if (mouseY > viewport.height) {
      const distance = mouseY - viewport.height;
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta =
        EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (mouseY > viewport.height - EDGE_SCROLL_THRESHOLD) {
      const proximity =
        (mouseY - (viewport.height - EDGE_SCROLL_THRESHOLD)) /
        EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    }

    if (autoScrollDelta !== 0 && updateViewportCallback) {
      const maxScroll = documentHeight - viewport.height;
      const newScrollY = Math.max(
        0,
        Math.min(maxScroll, viewport.scrollY + autoScrollDelta)
      );

      if (newScrollY !== viewport.scrollY) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }

    // Update selection based on new scroll position
    const position = getTextPositionFromViewport(
      autoScrollState.lastMouseX,
      autoScrollState.lastMouseY,
      state,
      viewport,
      visibility // Use current visibility which might be slightly stale but acceptable for one frame
    );

    if (position) {
      state = updateSelectionFocus(state, position);
      state = updateCursor(state, position);
    }
  }

  // Apply momentum scrolling if active (even when no events)
  if (state.view.momentum.isActive) {
    const momentumResult = applyMomentum(
      viewport.scrollY,
      state.view.momentum,
      documentHeight,
      viewport.height
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
    };
  }

  if (events.length === 0) {
    // Update scrollbar fade opacity even when no events
    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: updateScrollbarFadeOpacity(state.view.scrollbar),
      },
    };
    return state;
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
          visibility
        );
        break;
      case "mousedown":
        if (isTouchDevice()) {
          break;
        }
        state = handleMouseDown(
          state,
          viewport,
          event as unknown as MouseEvent,
          containerRect,
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
          containerRect,
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
        state = handleKeyDown(state, viewport, event, updateViewportCallback);
        break;
      case "paste":
        state = handlePaste(
          state,
          event as ClipboardEvent,
          viewport,
          updateViewportCallback,
          clipboardData
        );
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
          containerRect,
          documentHeight
        );
        break;
      case "touchmove":
        state = handleTouchMove(
          state,
          viewport,
          event as TouchEvent,
          containerRect,
          documentHeight,
          updateViewportCallback
        );
        break;
      case "touchend":
        state = handleTouchEnd(
          state,
          viewport,
          event as TouchEvent,
          containerRect
        );
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
    view: {
      ...state.view,
      scrollbar: updateScrollbarFadeOpacity(state.view.scrollbar),
    },
  };

  return state;
}

function handleContextMenu(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number }
): EditorState {
  event.preventDefault();

  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
    visibility
  );

  if (position) {
    if (!state.document.selection || !isPositionWithinSelection(state, position)) {
      state = updateCursor(state, position);
      state = clearSelection(state);
    }
    state = openContextMenu(state, canvasX, canvasY);
  }

  return state;
}

function handlePaste(
  state: EditorState,
  event: ClipboardEvent,
  viewport: ViewportState,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void,
  clipboardData?: { html: string; text: string } | null
): EditorState {
  // Prevent default paste behavior
  event.preventDefault();

  // Use the tracked pasteAsPlainText flag (set during keydown)
  // Paste as plain text
  const newState = pasteFromClipboardEvent(state, event, clipboardData);
  if (!newState) {
    return state;
  }

  // Scroll to make the cursor (end of pasted content) visible
  if (newState.document.cursor && updateViewportCallback) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return newState;
}

function handleMouseDown(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  stopAutoScroll();

  // Close context menu on any click
  if (state.ui.contextMenu) {
    state = { ...state, ui: { ...state.ui, contextMenu: null } };
  }

  // Close slash command menu on mouse click
  if (state.ui.slashCommand) {
    state = closeSlashCommand(state);
  }

  state = updateFocus(state, true);

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

  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  // Check for Ctrl/Command+Click on link to open it
  const isCtrlOrCmd = event.ctrlKey || event.metaKey;
  if (isCtrlOrCmd) {
    const position = getTextPositionFromViewport(
      canvasX,
      canvasY,
      state,
      viewport,
      visibility
    );

    if (position) {
      const linkData = getLinkAtPosition(position, state);
      if (linkData) {
        // Open the link in a new tab
        window.open(linkData.url, "_blank", "noopener,noreferrer");
        // Clear any link hover state
        state = { ...state, ui: { ...state.ui, linkHover: null, isHoveringLinkWithModifier: false } };
        // Don't continue with normal click behavior - just return
        return state;
      }
    }
  }

  // Check if clicking on scrollbar
  if (isPointInScrollbar(canvasX, canvasY, viewport, documentHeight)) {
    // Check if clicking on thumb
    if (
      isPointInThumb(
        canvasX,
        canvasY,
        viewport,
        documentHeight,
        state.view.scrollbar
      )
    ) {
      return {
        ...state,
        view: {
          ...state.view,
          scrollbar: startScrollbarDrag(state.view.scrollbar),
        },
      };
    } else {
      // Clicking on track - page scroll
      const newScrollY = updateScrollFromTrackClick(
        canvasY,
        viewport,
        documentHeight,
        state.view.scrollbar
      );
      if (updateViewportCallback) {
        updateViewportCallback({ scrollY: newScrollY });
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
  }

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
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
  const currentPosition = { x: canvasX, y: canvasY };

  let isMultiClick = false;

  if (
    state.view.clickTracker.lastClickPosition &&
    currentTime - state.view.clickTracker.lastClickTime <= DOUBLE_CLICK_TIME &&
    isWithinClickDistance(currentPosition, state.view.clickTracker.lastClickPosition)
  ) {
    state.view.clickTracker.count++;
    isMultiClick = true;
  } else {
    state.view.clickTracker.count = 1;
  }

  state.view.clickTracker.lastClickTime = currentTime;
  state.view.clickTracker.lastClickPosition = currentPosition;

  // Handle triple-click: always select line (even inside selection)
  if (isMultiClick && state.view.clickTracker.count >= 3) {
    return selectLineAtPosition(state, position);
  }

  // // If clicking inside a selection (single or double click), don't reset it (Apple Notes behavior)
  // if (isPositionWithinSelection(state, position)) {
  //   return state;
  // }

  // Handle double-click: select word
  if (isMultiClick && state.view.clickTracker.count === 2) {
    return selectWordAtPosition(state, position);
  }

  // Set cursor position
  let newState = updateCursor(state, position);

  // If shift is held, extend selection; otherwise start new selection
  if (event.shiftKey && state.document.selection) {
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
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  if (state.view.scrollbar.isDragging) {
    const newScrollY = updateScrollFromThumbDrag(
      canvasY,
      viewport,
      documentHeight,
      state.view.scrollbar
    );
    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }
    return state;
  }

  const isOverScrollbar = isPointInScrollbar(
    canvasX,
    canvasY,
    viewport,
    documentHeight
  );
  state = {
    ...state,
    view: {
      ...state.view,
      scrollbar: updateScrollbarHover(state.view.scrollbar, isOverScrollbar),
    },
  };

  if (state.ui.mode !== "select") {
    // Check for link hover when not selecting (desktop only)
    // Don't show tooltip if Ctrl/Command key is held (user wants to click to open)
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;
    
    // If Ctrl/Command is held and we have a tooltip showing, clear it
    if (isCtrlOrCmd && state.ui.linkHover) {
      state = { ...state, ui: { ...state.ui, linkHover: null } };
      return state;
    }
    
    if (!isTouchDevice()) {
      const position = getTextPositionFromViewport(
        canvasX,
        canvasY,
        state,
        viewport,
        visibility
      );

      if (position) {
        const linkData = getLinkAtPosition(position, state);
        if (linkData) {
          // If Ctrl/Command is held, show pointer cursor but no tooltip
          if (isCtrlOrCmd) {
            state = {
              ...state,
              ui: {
                ...state.ui,
                linkHover: null,
                isHoveringLinkWithModifier: true,
              },
            };
          } else {
            // Normal hover - show tooltip
            // Calculate screen coordinates for tooltip at the link's start position
            const linkStartPos = {
              blockIndex: position.blockIndex,
              textIndex: linkData.start,
            };
            const linkCoords = getCursorCoordinates(
              linkStartPos,
              state,
              viewport
            );

            if (linkCoords) {
              // Position tooltip below the start of the link text
              state = {
                ...state,
                ui: {
                  ...state.ui,
                  linkHover: {
                    position,
                    url: linkData.url,
                    text: linkData.text,
                    x: linkCoords.x + containerRect.left,
                    y: linkCoords.y + linkCoords.height + containerRect.top,
                    segmentIndex: linkData?.segmentIndex,
                  },
                  isHoveringLinkWithModifier: false,
                },
              };
            }
          }
        } else if (state.ui.linkHover || state.ui.isHoveringLinkWithModifier) {
          // Check if mouse is over the tooltip area before clearing
          // Keep tooltip if we're within the tooltip bounds (approximate)
          const tooltipHeight = 120; // Approximate height
          const tooltipWidth = 300; // Approximate width

          if (
            state.ui.linkHover &&
            event.x >= state.ui.linkHover.x &&
            event.x <= state.ui.linkHover.x + tooltipWidth &&
            event.y >= state.ui.linkHover.y &&
            event.y <= state.ui.linkHover.y + tooltipHeight
          ) {
            // Keep the tooltip open
            return state;
          }

          // Clear link hover if no longer over a link or tooltip
          state = { ...state, ui: { ...state.ui, linkHover: null, isHoveringLinkWithModifier: false } };
        }
      } else if (state.ui.linkHover || state.ui.isHoveringLinkWithModifier) {
        // Check if mouse is still over the tooltip
        const tooltipHeight = 120;
        const tooltipWidth = 300;

        if (
          state.ui.linkHover &&
          event.x >= state.ui.linkHover.x &&
          event.x <= state.ui.linkHover.x + tooltipWidth &&
          event.y >= state.ui.linkHover.y &&
          event.y <= state.ui.linkHover.y + tooltipHeight
        ) {
          // Keep the tooltip open
          return state;
        }

        // Clear link hover if not over any text or tooltip
        state = { ...state, ui: { ...state.ui, linkHover: null, isHoveringLinkWithModifier: false } };
      }
    } else if (state.ui.linkHover || state.ui.isHoveringLinkWithModifier) {
      // Clear link hover on touch devices
      state = { ...state, ui: { ...state.ui, linkHover: null, isHoveringLinkWithModifier: false } };
    }

    return state;
  }

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
    visibility
  );

  if (!position) return state;

  let newState = updateSelectionFocus(state, position);
  newState = updateCursor(newState, position);

  const isNearEdge =
    canvasY < EDGE_SCROLL_THRESHOLD ||
    canvasY > viewport.height - EDGE_SCROLL_THRESHOLD ||
    canvasY < 0 ||
    canvasY > viewport.height;

  if (isNearEdge) {
    if (!autoScrollState.isActive) {
      startAutoScroll();
    }

    // Update stored mouse position for auto-scroll loop
    autoScrollState.lastMouseX = canvasX;
    autoScrollState.lastMouseY = canvasY;

    // We let handleEvents loop handle the actual scrolling to support
    // scrolling while the mouse is stationary at the edge.
  } else {
    if (autoScrollState.isActive) {
      stopAutoScroll();
    }
  }

  return newState;
}

function handleMouseUp(
  state: EditorState,
  _viewport: ViewportState,
  _event: MouseEvent,
  _visibility: { start: number; end: number }
): EditorState {
  stopAutoScroll();

  if (state.view.scrollbar.isDragging) {
    return {
      ...state,
      view: {
        ...state.view,
        scrollbar: endScrollbarDrag(state.view.scrollbar),
      },
    };
  }

  if (state.ui.mode === "select") {
    return updateMode(state, "edit");
  }

  return state;
}

function handlePointerCancel(state: EditorState): EditorState {
  stopAutoScroll();

  if (state.view.scrollbar.isDragging) {
    state = {
      ...state,
      view: {
        ...state.view,
        scrollbar: endScrollbarDrag(state.view.scrollbar),
      },
    };
  }

  if (state.ui.mode === "select") {
    state = updateMode(state, "edit");
  }

  return state;
}

function handleKeyDown(
  state: EditorState,
  viewport: ViewportState,
  event: Event,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  const keyEvent = event as unknown as KeyboardEvent;
  const key = keyEvent.key;
  const keyLower = key.toLowerCase();
  const isCtrl = keyEvent.ctrlKey || keyEvent.metaKey;

  // In locked mode, block all operations
  if (state.ui.mode === "locked") {
    return state;
  }

  // Undo/Redo - handle these first, even if slash command is open
  if (isCtrl && keyLower === "z" && !keyEvent.shiftKey) {
    const newState = undoState(state);
    ensureCursorVisible(newState, state, viewport, updateViewportCallback);
    return newState;
  }
  if (isCtrl && (keyLower === "y" || (keyEvent.shiftKey && keyLower === "z"))) {
    const newState = redoState(state);
    ensureCursorVisible(newState, state, viewport, updateViewportCallback);
    return newState;
  }

  // Select All
  if (isCtrl && keyLower === "a") {
    return selectAll(state);
  }

  // Copy
  if (isCtrl && keyLower === "c") {
    // Don't prevent default - allow browser's copy to work as fallback
    // But also handle our custom copy with formatting
    copySelectionToClipboard(state).catch((err) => {
      console.error("Copy failed:", err);
    });
    return state;
  }

  // Cut
  if (isCtrl && keyLower === "x") {
    const range = getSelectionRange(state);
    if (range) {
      // Copy to clipboard first
      copySelectionToClipboard(state).catch((err) => {
        console.error("Cut (copy) failed:", err);
      });
      // Then delete the selected text
      const newState = deleteSelectedText(recordUndo(state));
      ensureCursorVisible(newState, state, viewport, updateViewportCallback);
      return newState;
    }
    return state;
  }

  // Handle slash command menu navigation
  if (state.ui.slashCommand) {
    const filteredCommands = state.ui.slashCommand.filter
      ? SLASH_COMMANDS.filter(
          (cmd) =>
            cmd.label
              .toLowerCase()
              .includes(state.ui.slashCommand!.filter.toLowerCase()) ||
            cmd.description
              .toLowerCase()
              .includes(state.ui.slashCommand!.filter.toLowerCase()) ||
            cmd.keywords?.some((keyword) =>
              keyword
                .toLowerCase()
                .startsWith(state.ui.slashCommand!.filter.toLowerCase())
            )
        )
      : SLASH_COMMANDS;

    switch (key) {
      case "ArrowLeft":
      case "ArrowRight":
        // Close slash menu on left/right arrow and continue to normal arrow key handling
        state = closeSlashCommand(state);
        break;
      case "ArrowDown":
        if (filteredCommands.length > 0) {
          const newIndex = Math.min(
            state.ui.slashCommand.selectedIndex + 1,
            filteredCommands.length - 1
          );
          return updateSlashCommandSelection(state, newIndex);
        }
        return state;
      case "ArrowUp":
        const newIndex = Math.max(state.ui.slashCommand.selectedIndex - 1, 0);
        return updateSlashCommandSelection(state, newIndex);
      case "Enter":
        if (filteredCommands.length > 0 && state.document.cursor) {
          const selectedCommand =
            filteredCommands[state.ui.slashCommand.selectedIndex];
          const newState = applySlashCommand(
            recordUndo(state),
            selectedCommand
          );
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return newState;
        }
        return closeSlashCommand(state);
      case "Escape":
        // Close slash command and remove the "/" character
        if (state.document.cursor) {
          const { blockIndex, textIndex } = state.ui.slashCommand;
          const block = state.document.page.blocks[blockIndex];

          // Remove the "/" and filter text, preserving formatting
          const newContent = deleteTextRangeInFormattedContent(
            block.content,
            textIndex - 1, // Remove the "/"
            state.document.cursor.position.textIndex // Remove up to cursor (the filter text)
          );

          const newBlock: Block = {
            ...block,
            content: newContent,
          };

          const newBlocks = [...state.document.page.blocks];
          newBlocks[blockIndex] = newBlock;
          const newPage = { ...state.document.page, blocks: newBlocks };

          let newState: EditorState = {
            ...state,
            document: { ...state.document, page: newPage },
          };
          newState = closeSlashCommand(newState);
          newState = moveCursorToPosition(newState, blockIndex, textIndex - 1);

          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return newState;
        }
        return closeSlashCommand(state);
      case "Backspace":
        // If at the start of filter, close menu
        if (
          state.document.cursor &&
          state.document.cursor.position.textIndex <= state.ui.slashCommand.textIndex
        ) {
          // Close menu and delete the slash character - no recordUndo needed since deleteText already records
          const newState = closeSlashCommand(deleteText(recordUndo(state)));
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return newState;
        }
        // Otherwise update filter - deleteText handles recordUndo internally
        if (state.document.cursor) {
          const newState = deleteText(recordUndo(state));
          if (newState.document.cursor) {
            const block = newState.document.page.blocks[state.ui.slashCommand.blockIndex];
            const text = getBlockTextContent(block);
            const filter = text.slice(
              state.ui.slashCommand.textIndex,
              newState.document.cursor.position.textIndex
            );
            const finalState = updateSlashCommandFilter(newState, filter);
            ensureCursorVisible(
              finalState,
              state,
              viewport,
              updateViewportCallback
            );
            return finalState;
          }
        }
        return state;
      default:
        // Handle typing to filter commands (including spaces)
        if (
          key.length === 1 &&
          !keyEvent.ctrlKey &&
          !keyEvent.altKey &&
          !keyEvent.metaKey
        ) {
          // insertText handles recordUndo internally
          const newState = insertText(recordUndo(state), key);
          if (newState.document.cursor) {
            const block = newState.document.page.blocks[state.ui.slashCommand.blockIndex];
            const text = getBlockTextContent(block);
            const filter = text.slice(
              state.ui.slashCommand.textIndex,
              newState.document.cursor.position.textIndex
            );
            const finalState = updateSlashCommandFilter(newState, filter);
            ensureCursorVisible(
              finalState,
              state,
              viewport,
              updateViewportCallback
            );
            return finalState;
          }
          return newState;
        }
        return state;
    }
  }

  let newState = state;

  // Navigation & selection
  switch (key) {
    case "ArrowLeft":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (isCtrl && keyEvent.shiftKey) {
        newState = extendSelectionWordLeft(newState);
      } else if (keyEvent.shiftKey) {
        newState = extendSelectionLeft(newState);
      } else {
        // If there's a selection, move to the start of it
        const range = getSelectionRange(newState);
        if (range) {
          newState = moveCursorToPosition(
            clearSelection(newState),
            range.start.blockIndex,
            range.start.textIndex
          );
        } else if (isCtrl) {
          newState = moveToPreviousWord(clearSelection(newState));
        } else {
          newState = moveCursorLeft(clearSelection(newState));
        }
      }
      break;
    case "ArrowRight":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (isCtrl && keyEvent.shiftKey) {
        newState = extendSelectionWordRight(state);
      } else if (keyEvent.shiftKey) {
        newState = extendSelectionRight(newState);
      } else {
        // If there's a selection, move to the end of it
        const range = getSelectionRange(newState);
        if (range) {
          newState = moveCursorToPosition(
            clearSelection(newState),
            range.end.blockIndex,
            range.end.textIndex
          );
        } else if (isCtrl) {
          newState = moveToNextWord(clearSelection(newState));
        } else {
          newState = moveCursorRight(clearSelection(newState));
        }
      }
      break;
    case "ArrowUp":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionUp(newState, viewport);
      } else {
        // If there's a selection, move to the start of it
        const range = getSelectionRange(newState);
        if (range) {
          newState = moveCursorToPosition(
            clearSelection(newState),
            range.start.blockIndex,
            range.start.textIndex
          );
        } else {
          newState = moveCursorUp(clearSelection(newState), viewport);
        }
      }
      break;
    case "ArrowDown":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionDown(newState, viewport);
      } else {
        // If there's a selection, move to the end of it
        const range = getSelectionRange(newState);
        if (range) {
          newState = moveCursorToPosition(
            clearSelection(newState),
            range.end.blockIndex,
            range.end.textIndex
          );
        } else {
          newState = moveCursorDown(clearSelection(newState), viewport);
        }
      }
      break;
    case "PageUp":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionPageUp(newState, viewport);
      } else {
        newState = moveCursorPageUp(clearSelection(state), viewport);
      }
      break;
    case "PageDown":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionPageDown(newState, viewport);
      } else {
        newState = moveCursorPageDown(clearSelection(state), viewport);
      }
      break;
    case "Home":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionHome(newState, isCtrl);
      } else {
        if (isCtrl) {
          newState = moveCursorToPosition(clearSelection(state), 0, 0);
        } else {
          newState = moveToLineStart(clearSelection(state));
        }
      }
      break;
    case "End":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionEnd(newState, isCtrl);
      } else {
        if (isCtrl) {
          newState = moveCursorToPosition(
            clearSelection(state),
            state.document.page.blocks.length - 1,
            getBlockTextLength(state.document.page.blocks[state.document.page.blocks.length - 1])
          );
        } else {
          newState = moveToLineEnd(clearSelection(state));
        }
      }
      break;
    case "Escape":
      return clearSelection(state);
    case "Backspace":
      if (isCtrl) {
        newState = deleteWordBackward(recordUndo(state));
      } else {
        newState = deleteText(recordUndo(state));
      }
      break;
    case "Delete":
      if (isCtrl) {
        newState = deleteWordForward(recordUndo(state));
      } else {
        newState = deleteForward(recordUndo(state));
      }
      break;
    case "Enter":
      newState = splitBlock(recordUndo(state));
      break;
    case " ":
    case "Space":
      newState = insertText(recordUndo(state), " ");
      break;
    default:
      // Check if typing "/" at the start of a block (only on desktop)
      if (
        key === "/" &&
        !isTouchDevice() &&
        state.document.cursor &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        const { blockIndex } = state.document.cursor.position;

        // Allow slash command anywhere in paragraphs and headings
        const newState = insertText(recordUndo(state), "/");
        if (newState.document.cursor) {
          const finalState = openSlashCommand(
            newState,
            blockIndex,
            newState.document.cursor.position.textIndex
          );
          ensureCursorVisible(
            finalState,
            state,
            viewport,
            updateViewportCallback
          );
          return finalState;
        }
        return newState;
      }

      if (
        key.length === 1 &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        newState = insertText(recordUndo(state), key);
        break;
      }
      return state;
  }

  if (newState !== state && newState.document.cursor && updateViewportCallback) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return newState;
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
    view: {
      ...state.view,
      momentum: {
        velocity: 0,
        lastTime: Date.now(),
        isActive: false,
      },
    },
  };

  const { scrollY, scrollbarState } = updateScrollFromWheel(
    event.deltaY,
    viewport,
    documentHeight,
    state.view.scrollbar
  );

  if (updateViewportCallback) {
    updateViewportCallback({ scrollY });
  }

  return {
    ...state,
    view: {
      ...state.view,
      scrollbar: scrollbarState,
    },
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
  currentTouchX: number;
  currentTouchY: number;
  isTouchingSelection: boolean;
} | null = null;

let autoScrollState: {
  isActive: boolean;
  startTime: number;
  currentSpeedMultiplier: number;
  lastMouseX: number;
  lastMouseY: number;
} = {
  isActive: false,
  startTime: 0,
  currentSpeedMultiplier: 1,
  lastMouseX: 0,
  lastMouseY: 0,
};

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

function startAutoScroll() {
  if (!autoScrollState.isActive) {
    autoScrollState.isActive = true;
    autoScrollState.startTime = Date.now();
    autoScrollState.currentSpeedMultiplier = 1;
  }
}

function stopAutoScroll() {
  autoScrollState.isActive = false;
  autoScrollState.startTime = 0;
  autoScrollState.currentSpeedMultiplier = 1;
}

export function isInLongPressMode(): boolean {
  return touchState?.isLongPress === true;
}

function handleTouchStart(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  containerRect: { left: number; top: number },
  documentHeight: number
): EditorState {
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    const currentTime = Date.now();
    const canvasX = touch.clientX - containerRect.left;
    const canvasY = touch.clientY - containerRect.top;

    // Check if touch is near the right edge of screen (where scrollbar is)
    // Use a threshold (e.g., last 60px) to detect scrollbar area
    const edgeThreshold = 60;
    const isNearRightEdge = canvasX >= viewport.width - edgeThreshold;

    // Also check if actually hitting scrollbar
    const isScrollbarTouch =
      isNearRightEdge &&
      isPointInScrollbar(canvasX, canvasY, viewport, documentHeight);

    // Check if touching within existing selection
    const position = getTextPositionFromViewport(
      canvasX,
      canvasY,
      state,
      viewport,
      { start: 0, end: state.document.page.blocks.length - 1 }
    );
    const isTouchingSelection = position
      ? isPositionWithinSelection(state, position)
      : false;
    touchState = {
      startY: canvasY,
      startScrollY: viewport.scrollY,
      lastY: canvasY,
      lastTime: currentTime,
      velocityY: 0,
      velocityHistory: [],
      isScrollbarDrag: isScrollbarTouch,
      startX: canvasX,
      startTime: currentTime,
      isLongPress: false,
      hasMoved: false,
      currentTouchX: canvasX,
      currentTouchY: canvasY,
      isTouchingSelection,
    };

    // If touching scrollbar, start drag
    if (isScrollbarTouch) {
      state = {
        ...state,
        view: {
          ...state.view,
          scrollbar: startScrollbarDrag(state.view.scrollbar),
        },
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

function handleTouchMove(
  state: EditorState,
  viewport: ViewportState,
  event: TouchEvent,
  containerRect: { left: number; top: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
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
        state.view.scrollbar
      );
      if (updateViewportCallback) {
        updateViewportCallback({ scrollY: newScrollY });
      }
      return state;
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

      // Close context menu when movement is detected
      if (state.ui.contextMenu) {
        state = {
          ...state,
          ui: { ...state.ui, contextMenu: null },
        };
      }
    }

    // Handle long press text selection mode
    if (touchState.isLongPress) {
      // Only start/continue text selection if NOT long-pressing on existing selection
      // If long-pressing on existing selection, we'll show context menu on touchend instead
      if (!touchState.isTouchingSelection) {
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
    const scrollDelta = (touchState.startY - canvasY) * touchScrollMultiplier;

    // Update scroll position with hard boundaries
    const maxScroll = documentHeight - viewport.height;
    const newScrollY = Math.max(
      0,
      Math.min(maxScroll, touchState.startScrollY + scrollDelta)
    );

    if (updateViewportCallback) {
      updateViewportCallback({ scrollY: newScrollY });
    }

    touchState.lastY = canvasY;
    touchState.lastTime = currentTime;
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

function handleTouchEnd(
  state: EditorState,
  viewport: ViewportState,
  _event: TouchEvent,
  _containerRect: { left: number; top: number }
): EditorState {
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

  // If we were in long press mode
  if (touchState?.isLongPress) {
    // Two scenarios:
    // 1. Long press on existing selection -> show context menu (already shown on long press trigger)
    // 2. Long press to create new selection -> exit select mode, do NOT show context menu
    if (touchState.isTouchingSelection) {
      // Long pressed on existing selection - context menu already shown, just cleanup
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
    } else if (state.ui.mode === "select") {
      // Long press created a new selection - exit select mode without showing context menu
      state = updateMode(state, "edit");
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
      { start: 0, end: state.document.page.blocks.length - 1 }
    );

    // Check for multi-tap (double/triple) - use larger threshold for touch
    let isMultiTap = false;
    if (
      touchTapTracker.lastTapPosition &&
      currentTime - touchTapTracker.lastTapTime <= DOUBLE_CLICK_TIME &&
      isWithinClickDistance(
        tapPosition,
        touchTapTracker.lastTapPosition,
        TAP_DISTANCE_THRESHOLD
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
      // Handle triple-tap: always select line (even inside selection)
      if (isMultiTap && touchTapTracker.count >= 3) {
        state = selectLineAtPosition(state, position);
      }
      // If tapping inside a selection (single or double tap), don't reset it (Apple Notes behavior)
      else if (isPositionWithinSelection(state, position)) {
        // Close context menu if open when tapping on selection
        if (state.ui.contextMenu) {
          state = {
            ...state,
            ui: { ...state.ui, contextMenu: null },
          };
        }
      }
      // Handle double-tap: select word
      else if (isMultiTap && touchTapTracker.count === 2) {
        state = selectWordAtPosition(state, position);
        // Close context menu when making new selection
        if (state.ui.contextMenu) {
          state = {
            ...state,
            ui: { ...state.ui, contextMenu: null },
          };
        }
      }
      // Single tap outside selection: position cursor and close context menu
      else {
        state = clearSelection(state);
        state = updateCursor(state, position);
        state = updateMode(state, "edit");
        // Close context menu when tapping outside
        if (state.ui.contextMenu) {
          state = {
            ...state,
            ui: { ...state.ui, contextMenu: null },
          };
        }
      }
    } else {
      // Tapping outside editor area: clear selection and close context menu
      state = clearSelection(state);
      state = updateMode(state, "edit");
      if (state.ui.contextMenu) {
        state = {
          ...state,
          ui: { ...state.ui, contextMenu: null },
        };
      }
    }

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

function handleTouchCancel(state: EditorState): EditorState {
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
