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
import type {
  EditorState,
  MouseEvent,
  ViewportState,
  KeyboardEvent,
} from "./types";
import { recordUndo, undoState, redoState } from "./undo";

const DOUBLE_CLICK_TIME = 500; // ms
const CLICK_DISTANCE_THRESHOLD = 5; // pixels

function isWithinClickDistance(
  pos1: { x: number; y: number },
  pos2: { x: number; y: number }
): boolean {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  return Math.sqrt(dx * dx + dy * dy) <= CLICK_DISTANCE_THRESHOLD;
}

export function handleEvents(
  state: EditorState,
  viewport: ViewportState,
  visibility: { start: number; end: number },
  events: Event[]
): EditorState {
  if (events.length === 0) return state;
  for (const event of events) {
    switch (event.type) {
      case "mousedown":
      case "pointerdown":
        state = handleMouseDown(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility
        );
        break;
      case "mousemove":
      case "pointermove":
        state = handleMouseMove(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility
        );
        break;
      case "mouseup":
      case "pointerup":
        state = handleMouseUp(
          state,
          viewport,
          event as unknown as MouseEvent,
          visibility
        );
        break;
      case "keydown":
        state = handleKeyDown(state, viewport, event);
        break;
    }

    events.shift();
  }

  return state;
}

function handleMouseDown(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  visibility: { start: number; end: number }
): EditorState {
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

  // Handle multi-click selection
  if (isMultiClick) {
    if (state.clickTracker.count === 2) {
      // Double-click: select word
      return selectWordAtPosition(state, position);
    } else if (state.clickTracker.count >= 3) {
      // Triple-click: select line/paragraph
      return selectLineAtPosition(state, position);
    }
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
  visibility: { start: number; end: number }
): EditorState {
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
  // Exit select mode and return to edit mode
  if (state.mode === "select") {
    return updateMode(state, "edit");
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
        return moveToPreviousWord(state);
      } else {
        return moveCursorLeft(state);
      }
    case "ArrowRight":
      if (isCtrl && keyEvent.shiftKey) {
        return extendSelectionWordRight(state);
      } else if (keyEvent.shiftKey) {
        return extendSelectionRight(state);
      } else if (isCtrl) {
        return moveToNextWord(state);
      } else {
        return moveCursorRight(state);
      }
    case "ArrowUp":
      if (keyEvent.shiftKey) {
        return extendSelectionUp(state);
      } else {
        return moveCursorUp(state);
      }
    case "ArrowDown":
      if (keyEvent.shiftKey) {
        return extendSelectionDown(state);
      } else {
        return moveCursorDown(state);
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
