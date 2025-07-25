import {
  findCharacterAtPosition,
  findNearestCharacterPosition,
} from "./characterMap";
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
import type { CharacterMap, EditorState, MouseEvent, Position } from "./types";

export function handleEvents(
  state: EditorState,
  events: Event[],
  characterMap: CharacterMap
): EditorState {
  if (events.length === 0) return state;
  for (const event of events) {
    switch (event.type) {
      case "mousedown":
        state = handleMouseDown(
          state,
          event as unknown as MouseEvent,
          characterMap
        );
        break;
      case "mousemove":
        state = handleMouseMove(
          state,
          event as unknown as MouseEvent,
          characterMap
        );
        break;
      case "mouseup":
        state = handleMouseUp(
          state,
          event as unknown as MouseEvent,
          characterMap
        );
        break;
      case "keydown":
        state = handleKeyDown(state, event);
        break;
      case "wheel":
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

function getPositionFromCharMap(
  x: number,
  y: number,
  characterMap: CharacterMap
): Position | null {
  // First try to find an exact character hit
  const exactChar = findCharacterAtPosition(characterMap, x, y);
  if (exactChar) {
    return {
      blockIndex: exactChar.blockIndex,
      textIndex: exactChar.textIndex,
    };
  }

  // If no exact hit, find the nearest character
  const nearestChar = findNearestCharacterPosition(characterMap, x, y);
  if (nearestChar) {
    return {
      blockIndex: nearestChar.blockIndex,
      textIndex: nearestChar.textIndex,
    };
  }

  // If no characters found at all, return null
  return null;
}

function handleMouseDown(
  state: EditorState,
  event: MouseEvent,
  characterMap: CharacterMap
): EditorState {
  const position = getPositionFromCharMap(event.x, event.y, characterMap);

  if (!position) return state;

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
  event: MouseEvent,
  characterMap: CharacterMap
): EditorState {
  const mouseEvent = event;

  // Only handle mouse move if we're in select mode and have an active selection
  if (state.mode !== "select" || !state.selection) {
    return state;
  }

  const position = getPositionFromCharMap(
    mouseEvent.x,
    mouseEvent.y,
    characterMap
  );

  if (!position) return state;

  // Update selection focus and cursor position
  let newState = updateSelectionFocus(state, position);
  newState = updateCursor(newState, position);

  return newState;
}

function handleMouseUp(
  state: EditorState,
  event: MouseEvent,
  characterMap: CharacterMap
): EditorState {
  // Exit select mode and return to edit mode
  if (state.mode === "select") {
    return updateMode(state, "edit");
  }

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

function handleWheel(state: EditorState, event: Event): EditorState {
  return state;
}

function handleResize(state: EditorState, event: Event): EditorState {
  return state;
}
