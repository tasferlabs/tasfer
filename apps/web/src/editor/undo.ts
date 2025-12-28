import type { EditorState, EditorModelState, UndoManagerState } from "./types";
import type { Block } from "../deserializer/loadPage";
import { invalidateBlockCache } from "./renderer";

export const initialUndoManagerState: UndoManagerState = {
  undoStack: [],
  redoStack: [],
};

// Invalidate cache for blocks that changed between two states (for undo/redo)
function invalidateChangedBlocks(oldBlocks: Block[], newBlocks: Block[]) {
  // Build a map of old blocks by ID for fast lookup
  const oldBlocksMap = new Map<string, Block>();
  oldBlocks.forEach((block) => oldBlocksMap.set(block.id, block));

  // Build a map of new blocks by ID
  const newBlocksMap = new Map<string, Block>();
  newBlocks.forEach((block) => newBlocksMap.set(block.id, block));

  // Invalidate blocks that were deleted (in old but not in new)
  oldBlocks.forEach((oldBlock) => {
    if (!newBlocksMap.has(oldBlock.id)) {
      invalidateBlockCache(oldBlock);
    }
  });

  // Invalidate blocks that were added or modified
  newBlocks.forEach((newBlock) => {
    const oldBlock = oldBlocksMap.get(newBlock.id);
    if (!oldBlock) {
      // New block - doesn't have cache yet, no need to invalidate
      return;
    }

    // Check if content changed (simple string comparison)
    const oldContent = JSON.stringify(oldBlock.content);
    const newContent = JSON.stringify(newBlock.content);
    if (oldContent !== newContent || oldBlock.type !== newBlock.type) {
      invalidateBlockCache(newBlock);
    }
  });
}

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
  
  // Invalidate only blocks that changed between current and previous state
  invalidateChangedBlocks(state.page.blocks, prevModel.page.blocks);
  
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
  
  // Invalidate only blocks that changed between current and next state
  invalidateChangedBlocks(state.page.blocks, nextModel.page.blocks);
  
  return {
    ...nextModel,
    undoManager: {
      undoStack: [...undoStack, modelState],
      redoStack: redoStack.slice(0, -1),
    },
  };
}






