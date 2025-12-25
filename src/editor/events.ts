import {
  deleteText,
  deleteForward,
  deleteWordForward,
  deleteWordBackward,
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
  selectAll,
  applySlashCommand,
  getSelectionRange,
} from "./commands";
import type { Block } from "../deserializer/loadPage";
import { getTextPositionFromViewport, scrollToMakeCursorVisible } from "./selection";
import {
  clearSelection,
  getBlockTextLength,
  moveCursorDown,
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
  moveCursorUp,
  moveCursorPageUp,
  moveCursorPageDown,
  startSelection,
  updateCursor,
  updateMode,
  updateFocus,
  updateSelectionFocus,
  extendSelectionLeft,
  extendSelectionRight,
  extendSelectionUp,
  extendSelectionDown,
  openSlashCommand,
  updateSlashCommandFilter,
  updateSlashCommandSelection,
  closeSlashCommand,
  getBlockTextContent,
} from "./state";
import { SLASH_COMMANDS } from "./SlashCommandMenu";
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
import {
  DOUBLE_CLICK_TIME,
  CLICK_DISTANCE_THRESHOLD,
  TAP_DISTANCE_THRESHOLD,
  LONG_PRESS_DURATION,
  MOVEMENT_THRESHOLD,
  TAP_MAX_DURATION,
  EDGE_SCROLL_THRESHOLD,
  EDGE_SCROLL_SPEED,
  EDGE_SCROLL_MAX_SPEED,
  EDGE_SCROLL_ACCELERATION_RATE,
} from "./constants";

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
  containerRect: { left: number; top: number },
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  // Apply auto-scroll and selection update during long press
  if (autoScrollState.isActive && touchState?.isLongPress) {
    // Current touch coordinates are already adjusted relative to container in handleTouchMove
    const touch = { clientY: touchState.currentTouchY, clientX: touchState.currentTouchX };
    
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
      autoScrollDelta = -EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (touch.clientY < EDGE_SCROLL_THRESHOLD) {
      const proximity = 1 - touch.clientY / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = -EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    } else if (touch.clientY > viewport.height) {
      const distance = touch.clientY - viewport.height;
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta = EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (touch.clientY > viewport.height - EDGE_SCROLL_THRESHOLD) {
      const proximity = (touch.clientY - (viewport.height - EDGE_SCROLL_THRESHOLD)) / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    }
    
    if (autoScrollDelta !== 0 && updateViewportCallback) {
      const maxScroll = documentHeight - viewport.height;
      const newScrollY = Math.max(0, Math.min(maxScroll, viewport.scrollY + autoScrollDelta));
      
      if (newScrollY !== viewport.scrollY) {
        updateViewportCallback({ scrollY: newScrollY });
      }
    }
    
    const position = getTextPositionFromViewport(
      touch.clientX,
      touch.clientY,
      state,
      viewport,
      { start: 0, end: state.page.blocks.length - 1 }
    );
    
    if (position) {
      if (state.mode !== "select") {
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
      scrollbar: {
        ...state.scrollbar,
        lastInteraction: Date.now(),
      },
    };
  } else if (autoScrollState.isActive && state.mode === "select") {
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
      autoScrollDelta = -EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (mouseY < EDGE_SCROLL_THRESHOLD) {
      const proximity = 1 - mouseY / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = -EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    } else if (mouseY > viewport.height) {
      const distance = mouseY - viewport.height;
      const speedMultiplier = Math.min(distance / 100, 3);
      autoScrollDelta = EDGE_SCROLL_SPEED * (1 + speedMultiplier) * timeBasedMultiplier;
    } else if (mouseY > viewport.height - EDGE_SCROLL_THRESHOLD) {
      const proximity = (mouseY - (viewport.height - EDGE_SCROLL_THRESHOLD)) / EDGE_SCROLL_THRESHOLD;
      autoScrollDelta = EDGE_SCROLL_SPEED * proximity * timeBasedMultiplier;
    }

    if (autoScrollDelta !== 0 && updateViewportCallback) {
      const maxScroll = documentHeight - viewport.height;
      const newScrollY = Math.max(0, Math.min(maxScroll, viewport.scrollY + autoScrollDelta));

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

  while (events.length > 0) {
    const event = events[0];
    switch (event.type) {
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
        state = handleTouchEnd(state, viewport, event as TouchEvent, containerRect);
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
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  stopAutoScroll();
  
  // Close slash command menu on mouse click
  if (state.slashCommand) {
    state = closeSlashCommand(state);
  }
  
  state = updateFocus(state, true);

  state = {
    ...state,
    momentum: {
      velocity: 0,
      lastTime: Date.now(),
      isActive: false,
    },
  };

  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  // Check if clicking on scrollbar
  if (isPointInScrollbar(canvasX, canvasY, viewport, documentHeight)) {
    // Check if clicking on thumb
    if (
      isPointInThumb(
        canvasX,
        canvasY,
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
        canvasY,
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

  // // If clicking inside a selection (single or double click), don't reset it (Apple Notes behavior)
  // if (isPositionWithinSelection(state, position)) {
  //   return state;
  // }

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
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number },
  documentHeight: number,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): EditorState {
  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  if (state.scrollbar.isDragging) {
    const newScrollY = updateScrollFromThumbDrag(
      canvasY,
      viewport,
      documentHeight,
      state.scrollbar
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
    scrollbar: updateScrollbarHover(state.scrollbar, isOverScrollbar),
  };

  if (state.mode !== "select") {
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
  
  if (state.scrollbar.isDragging) {
    return {
      ...state,
      scrollbar: endScrollbarDrag(state.scrollbar),
    };
  }

  if (state.mode === "select") {
    return updateMode(state, "edit");
  }

  return state;
}

function handlePointerCancel(state: EditorState): EditorState {
  stopAutoScroll();
  
  if (state.scrollbar.isDragging) {
    state = {
      ...state,
      scrollbar: endScrollbarDrag(state.scrollbar),
    };
  }

  if (state.mode === "select") {
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

  // Undo/Redo - handle these first, even if slash command is open
  if (isCtrl && keyLower === "z" && !keyEvent.shiftKey) {
    return undoState(state);
  }
  if (isCtrl && (keyLower === "y" || (keyEvent.shiftKey && keyLower === "z"))) {
    return redoState(state);
  }

  // Select All
  if (isCtrl && keyLower === "a") {
    return selectAll(state);
  }

  // Handle slash command menu navigation
  if (state.slashCommand) {
    const filteredCommands = state.slashCommand.filter
      ? SLASH_COMMANDS.filter(
          (cmd) =>
            cmd.label.toLowerCase().includes(state.slashCommand!.filter.toLowerCase()) ||
            cmd.description.toLowerCase().includes(state.slashCommand!.filter.toLowerCase()) ||
            cmd.keywords?.some((keyword) => keyword.toLowerCase().startsWith(state.slashCommand!.filter.toLowerCase()))
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
            state.slashCommand.selectedIndex + 1,
            filteredCommands.length - 1
          );
          return updateSlashCommandSelection(state, newIndex);
        }
        return state;
      case "ArrowUp":
        const newIndex = Math.max(state.slashCommand.selectedIndex - 1, 0);
        return updateSlashCommandSelection(state, newIndex);
      case "Enter":
        if (filteredCommands.length > 0 && state.cursor) {
          const selectedCommand =
            filteredCommands[state.slashCommand.selectedIndex];
          return applySlashCommand(recordUndo(state), selectedCommand);
        }
        return closeSlashCommand(state);
      case "Escape":
        // Close slash command and remove the "/" character
        if (state.cursor) {
          const { blockIndex, textIndex } = state.slashCommand;
          const block = state.page.blocks[blockIndex];
          const text = getBlockTextContent(block);
          const beforeSlash = text.slice(0, textIndex - 1);
          const afterFilter = text.slice(state.cursor.position.textIndex);
          const newText = beforeSlash + afterFilter;
          
          const newBlock: Block = {
            ...block,
            content: [{ content: newText }],
          };
          
          const newBlocks = [...state.page.blocks];
          newBlocks[blockIndex] = newBlock;
          const newPage = { ...state.page, blocks: newBlocks };
          
          let newState: EditorState = { ...state, page: newPage };
          newState = closeSlashCommand(newState);
          newState = moveCursorToPosition(newState, blockIndex, beforeSlash.length);
          
          return newState;
        }
        return closeSlashCommand(state);
      case "Backspace":
        // If at the start of filter, close menu
        if (state.cursor && state.cursor.position.textIndex <= state.slashCommand.textIndex) {
          // Close menu and delete the slash character - no recordUndo needed since deleteText already records
          return closeSlashCommand(deleteText(recordUndo(state)));
        }
        // Otherwise update filter - deleteText handles recordUndo internally
        if (state.cursor) {
          const newState = deleteText(recordUndo(state));
          if (newState.cursor) {
            const block = newState.page.blocks[state.slashCommand.blockIndex];
            const text = getBlockTextContent(block);
            const filter = text.slice(
              state.slashCommand.textIndex,
              newState.cursor.position.textIndex
            );
            return updateSlashCommandFilter(newState, filter);
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
          if (newState.cursor) {
            const block = newState.page.blocks[state.slashCommand.blockIndex];
            const text = getBlockTextContent(block);
            const filter = text.slice(
              state.slashCommand.textIndex,
              newState.cursor.position.textIndex
            );
            return updateSlashCommandFilter(newState, filter);
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
          newState = moveCursorToPosition(clearSelection(newState), range.start.blockIndex, range.start.textIndex);
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
          newState = moveCursorToPosition(clearSelection(newState), range.end.blockIndex, range.end.textIndex);
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
          newState = moveCursorToPosition(clearSelection(newState), range.start.blockIndex, range.start.textIndex);
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
          newState = moveCursorToPosition(clearSelection(newState), range.end.blockIndex, range.end.textIndex);
        } else {
          newState = moveCursorDown(clearSelection(newState), viewport);
        }
      }
      break;
    case "PageUp":
      newState = moveCursorPageUp(clearSelection(state), viewport);
      break;
    case "PageDown":
      newState = moveCursorPageDown(clearSelection(state), viewport);
      break;
    case "Home":
      if (isCtrl) {
        newState = moveCursorToPosition(state, 0, 0);
      } else {
        newState = moveToLineStart(state);
      }
      break;
    case "End":
      if (isCtrl) {
        newState = moveCursorToPosition(
          state,
          state.page.blocks.length - 1,
          getBlockTextLength(state.page.blocks[state.page.blocks.length - 1])
        );
      } else {
        newState = moveToLineEnd(state);
      }
      break;
    case "Escape":
      return clearSelection(state);
    case "Backspace":
      if (isCtrl) {
        return deleteWordBackward(recordUndo(state));
      }
      return deleteText(recordUndo(state));
    case "Delete":
      if (isCtrl) {
        return deleteWordForward(recordUndo(state));
      }
      return deleteForward(recordUndo(state));
    case "Enter":
      return splitBlock(recordUndo(state));
    case " ":
    case "Space":
      return insertText(recordUndo(state), " ");
    default:
      // Check if typing "/" at the start of a block (only on desktop)
      if (
        key === "/" &&
        !isTouchDevice() &&
        state.cursor &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        const { blockIndex } = state.cursor.position;
        
        // Allow slash command anywhere in paragraphs and headings
        const newState = insertText(recordUndo(state), "/");
        if (newState.cursor) {
          return openSlashCommand(newState, blockIndex, newState.cursor.position.textIndex);
        }
        return newState;
      }
      
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

  if (newState !== state && newState.cursor && updateViewportCallback) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.cursor.position,
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
  currentTouchX: number;
  currentTouchY: number;
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
      isPointInScrollbar(
        canvasX,
        canvasY,
        viewport,
        documentHeight
      );

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
    if (touchState.isScrollbarDrag && state.scrollbar.isDragging) {
      const newScrollY = updateScrollFromThumbDrag(
        canvasY,
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
    const deltaX = Math.abs(canvasX - touchState.startX);
    const deltaY = Math.abs(canvasY - touchState.startY);
    const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Detect long press: if user held still for LONG_PRESS_DURATION, switch to text selection
    const timeSinceStart = currentTime - touchState.startTime;
    if (
      !touchState.hasMoved &&
      !touchState.isLongPress &&
      timeSinceStart >= LONG_PRESS_DURATION &&
      totalMovement < MOVEMENT_THRESHOLD
    ) {
      touchState.isLongPress = true;
      
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }

    // Update current touch position for auto-scroll
    touchState.currentTouchX = canvasX;
    touchState.currentTouchY = canvasY;

    // If moved beyond threshold, mark as moved (cancels potential long press)
    if (!touchState.hasMoved && totalMovement > MOVEMENT_THRESHOLD) {
      touchState.hasMoved = true;
    }

    // Handle long press text selection mode
    if (touchState.isLongPress) {
      if (!autoScrollState.isActive) {
        startAutoScroll();
      }

      touchState.lastY = canvasY;
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
    const scrollDelta =
      (touchState.startY - canvasY) * touchScrollMultiplier;

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
    scrollbar: {
      ...state.scrollbar,
      lastInteraction: Date.now(),
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
    } else {
      // Tapping outside editor area: clear selection
      state = clearSelection(state);
      state = updateMode(state, "edit");
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
  stopAutoScroll();
  
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
