import {
  clearSelection,
  moveCursorDown,
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
  moveCursorUp,
} from "./state";
import type { EditorState } from "./types";

export function handleEvents(state: EditorState, events: Event[]): EditorState {
  if (events.length === 0) return state;

  for (const event of events) {
    switch (event.type) {
      case "mousedown":
        state = handleMouseDown(state, event);
        break;
      case "mousemove":
        state = handleMouseMove(state, event);
        break;
      case "mouseup":
        state = handleMouseUp(state, event);
        break;
      case "keydown":
        state = handleKeyDown(state, event);
        break;
      case "wheel":
        state = handleWheel(state, event);
        break;
      case "resize":
        state = handleResize(state, event);
        break;
    }

    events.shift();
  }

  return state;
}

function handleMouseDown(state: EditorState, event: Event): EditorState {
  return state;
}

function handleMouseMove(state: EditorState, event: Event): EditorState {
  return state;
}

function handleMouseUp(state: EditorState, event: Event): EditorState {
  return state;
}

function handleKeyDown(state: EditorState, event: Event): EditorState {
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
      return moveCursorToPosition(state, state.page.blocks.length - 1, 0);
    case "Escape":
      return clearSelection(state);
  }

  return state;
}

function handleWheel(state: EditorState, event: Event): EditorState {
  return state;
}

function handleResize(state: EditorState, event: Event): EditorState {
  return state;
}
