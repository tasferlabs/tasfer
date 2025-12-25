import type { EditorState, EditorModelState, UndoManagerState } from "./types";

export const initialUndoManagerState: UndoManagerState = {
  undoStack: [],
  redoStack: [],
};

function getModelState(state: EditorState): EditorModelState {
  const { undoManager, slashCommand, ...model } = state;
  // Exclude slashCommand from undo state as it's transient UI state
  return { ...model, slashCommand: null };
}

export function recordUndo(state: EditorState): EditorState {
  const modelState = getModelState(state);
  const { undoStack } = state.undoManager;
  return {
    ...state,
    undoManager: {
      undoStack: [...undoStack, modelState],
      redoStack: [],
    },
  };
}

export function undoState(state: EditorState): EditorState {
  const modelState = getModelState(state);
  const { undoStack, redoStack } = state.undoManager;
  if (undoStack.length === 0) {
    return state;
  }
  const prevModel = undoStack[undoStack.length - 1];
  return {
    ...prevModel,
    undoManager: {
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, modelState],
    },
  };
}

export function redoState(state: EditorState): EditorState {
  const modelState = getModelState(state);
  const { undoStack, redoStack } = state.undoManager;
  if (redoStack.length === 0) {
    return state;
  }
  const nextModel = redoStack[redoStack.length - 1];
  return {
    ...nextModel,
    undoManager: {
      undoStack: [...undoStack, modelState],
      redoStack: redoStack.slice(0, -1),
    },
  };
}






