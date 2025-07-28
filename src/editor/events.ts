import { getTextPositionFromViewport as getTextPositionFromViewport } from "./selection";
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
} from "./state";
import type { EditorState, MouseEvent, ViewportState } from "./types";

export function handleEvents(
  state: EditorState,
  viewport: ViewportState,
  events: Event[]
): EditorState {
  if (events.length === 0) return state;
  for (const event of events) {
    switch (event.type) {
      case "mousedown":
        state = handleMouseDown(
          state,
          viewport,
          event as unknown as MouseEvent
        );
        break;
      case "mousemove":
        state = handleMouseMove(
          state,
          viewport,
          event as unknown as MouseEvent
        );
        break;
      case "mouseup":
        state = handleMouseUp(state, viewport, event as unknown as MouseEvent);
        break;
      case "keydown":
        state = handleKeyDown(state, viewport, event);
        break;
      // case "wheel":
      // state = handleWheel(state, event);
      // break;
      // case "resize":
      //   state = handleResize(state, event);
      //   break;
    }

    events.shift();
  }

  return state;
}

function handleMouseDown(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent
): EditorState {
  // console.log(event.x, event.y, viewport.width, viewport.height);
  const position = getTextPositionFromViewport(
    event.x,
    event.y,
    state,
    viewport
  );

  if (!position) return state;

  // Set cursor position
  let newState = updateCursor(state, position);

  // console.log(
  //   "Cursor: ",
  //   newState.cursor?.position.blockIndex,
  //   newState.cursor?.position.textIndex
  // );

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
  event: MouseEvent
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
    undefined,
    true // isDragSelection - excludes margin fallback
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
  viewport: ViewportState,
  event: MouseEvent
): EditorState {
  // Exit select mode and return to edit mode
  if (state.mode === "select") {
    return updateMode(state, "edit");
  }

  return state;
}

function handleKeyDown(
  state: EditorState,
  viewport: ViewportState,
  event: Event
): EditorState {
  const allowedKeys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "Escape",
  ];

  const key = (event as KeyboardEvent).key;

  if (!allowedKeys.includes(key)) return state;

  switch (key) {
    case "ArrowLeft":
      return moveCursorLeft(state);
    case "ArrowRight":
      return moveCursorRight(state);
    case "ArrowUp":
      return moveCursorUp(state);
    case "ArrowDown":
      return moveCursorDown(state);
    case "Home":
      return moveCursorToPosition(state, 0, 0);
    case "End":
      return moveCursorToPosition(
        state,
        state.page.blocks.length - 1,
        getBlockTextLength(state.page.blocks[state.page.blocks.length - 1])
      );
    case "Escape":
      return clearSelection(state);
  }

  return state;
}

// function handleWheel(state: EditorState, event: Event): EditorState {
//   return state;
// }

// function handleResize(state: EditorState, event: Event): EditorState {
//   return state;
// }
