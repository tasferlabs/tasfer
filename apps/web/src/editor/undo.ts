import type { EditorState, UndoManagerState, UndoGroup } from "./types";
import type { Operation } from "../sync/types";
import { invalidateBlockCache } from "./renderer";
import { applyRemoteOps } from "./crdt-helpers";
import { invertOperations } from "./inverse";

export const initialUndoManagerState: UndoManagerState = {
  undoStack: [],
  redoStack: [],
};

/**
 * Record operations to the undo stack.
 * Called after any operation that modifies the document.
 * Clears the redo stack since a new action invalidates redo history.
 */
export function recordUndoOps(
  state: EditorState,
  ops: readonly Operation[],
  peerId: string
): EditorState {
  if (ops.length === 0) return state;

  const undoGroup: UndoGroup = {
    operations: ops,
    peerId,
  };

  return {
    ...state,
    undoManager: {
      undoStack: [...state.undoManager.undoStack, undoGroup],
      redoStack: [], // Clear redo stack on new operations
    },
  };
}

/**
 * Invalidate cache for affected blocks after applying operations.
 */
function invalidateAffectedBlocks(
  state: EditorState,
  operations: Operation[]
): void {
  const affectedBlockIds = new Set<string>();

  // Collect all affected block IDs
  for (const op of operations) {
    switch (op.op) {
      case "text_insert":
      case "text_delete":
      case "format_set":
      case "block_set":
        affectedBlockIds.add(op.blockId);
        break;
      case "block_insert":
      case "block_delete":
        affectedBlockIds.add(op.blockId);
        break;
    }
  }

  // Invalidate cache for affected blocks
  for (const blockId of affectedBlockIds) {
    const block = state.document.page.blocks.find((b) => b.id === blockId);
    if (block) {
      invalidateBlockCache(block);
    }
  }
}

/**
 * Undo the last operation group by this user.
 * Computes inverse operations on-the-fly using tombstones.
 * Returns the updated state and the inverse operations that were applied.
 */
export function undoState(state: EditorState): {
  state: EditorState;
  ops: Operation[];
} {
  const { undoStack, redoStack } = state.undoManager;
  const currentPeerId = state.crdt.clock().peerId;

  // Find the last undo group from this user
  let lastUserGroupIndex = -1;
  for (let i = undoStack.length - 1; i >= 0; i--) {
    if (undoStack[i].peerId === currentPeerId) {
      lastUserGroupIndex = i;
      break;
    }
  }

  if (lastUserGroupIndex === -1) {
    // No undo operations from this user
    return { state, ops: [] };
  }

  const undoGroup = undoStack[lastUserGroupIndex];

  // Compute inverse operations on-the-fly using current state and tombstones
  const inverseOps = invertOperations(undoGroup.operations, state);

  // If no valid inverses (e.g., all operations target tombstoned blocks), skip this group
  if (inverseOps.length === 0) {
    // Remove this group and try the next one
    const newUndoStack = [
      ...undoStack.slice(0, lastUserGroupIndex),
      ...undoStack.slice(lastUserGroupIndex + 1),
    ];

    const stateWithUpdatedStack = {
      ...state,
      undoManager: {
        ...state.undoManager,
        undoStack: newUndoStack,
      },
    };

    // Recursively try the next group
    return undoState(stateWithUpdatedStack);
  }

  // Apply inverse operations to the page
  const newPage = applyRemoteOps(state.document.page, inverseOps);

  // Invalidate affected blocks
  const newState: EditorState = {
    ...state,
    document: {
      ...state.document,
      page: newPage,
    },
  };

  invalidateAffectedBlocks(newState, inverseOps);

  // Update undo/redo stacks
  const newUndoStack = [
    ...undoStack.slice(0, lastUserGroupIndex),
    ...undoStack.slice(lastUserGroupIndex + 1),
  ];

  // For redo, store the original operations
  const redoGroup: UndoGroup = {
    operations: undoGroup.operations, // Store original ops for redo
    peerId: currentPeerId,
  };

  return {
    state: {
      ...newState,
      undoManager: {
        undoStack: newUndoStack,
        redoStack: [...redoStack, redoGroup],
      },
    },
    ops: inverseOps,
  };
}

/**
 * Redo the last undone operation group by this user.
 * Reapplies the original operations that were undone.
 * Returns the updated state and the operations that were applied.
 */
export function redoState(state: EditorState): {
  state: EditorState;
  ops: Operation[];
} {
  const { undoStack, redoStack } = state.undoManager;
  const currentPeerId = state.crdt.clock().peerId;

  // Find the last redo group from this user
  let lastUserGroupIndex = -1;
  for (let i = redoStack.length - 1; i >= 0; i--) {
    if (redoStack[i].peerId === currentPeerId) {
      lastUserGroupIndex = i;
      break;
    }
  }

  if (lastUserGroupIndex === -1) {
    // No redo operations from this user
    return { state, ops: [] };
  }

  // Get the original operations to reapply
  const redoGroup = redoStack[lastUserGroupIndex];
  const redoOps = [...redoGroup.operations];

  // Apply redo operations to the page
  const newPage = applyRemoteOps(state.document.page, redoOps);

  // Invalidate affected blocks
  const newState: EditorState = {
    ...state,
    document: {
      ...state.document,
      page: newPage,
    },
  };

  invalidateAffectedBlocks(newState, redoOps);

  // Update undo/redo stacks
  const newRedoStack = [
    ...redoStack.slice(0, lastUserGroupIndex),
    ...redoStack.slice(lastUserGroupIndex + 1),
  ];

  // Put back on undo stack for potential re-undo
  const undoGroup: UndoGroup = {
    operations: redoOps, // The ops we just applied
    peerId: currentPeerId,
  };

  return {
    state: {
      ...newState,
      undoManager: {
        undoStack: [...undoStack, undoGroup],
        redoStack: newRedoStack,
      },
    },
    ops: redoOps,
  };
}
