import type { EditorState, Position } from "./state-types";

// Composition (IME) State Management

export function startComposition(
  state: EditorState,
  text: string,
  startPosition: Position,
): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        isComposing: true,
        text,
        startPosition,
        cursorOffset: text.length,
      },
    },
  };
}

export function updateComposition(
  state: EditorState,
  text: string,
): EditorState {
  if (!state.ui.composition) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: {
        ...state.ui.composition,
        text,
        cursorOffset: Math.min(state.ui.composition.cursorOffset, text.length),
      },
    },
  };
}

export function endComposition(state: EditorState): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      composition: null,
    },
  };
}
