import { invertOperations, refreshOps } from "./inverse";
import { invalidateBlockCache } from "./renderer";
import {
  captureCRDTCursor,
  captureCRDTSelection,
  restoreCursor,
  restoreSelection,
} from "./sync/crdt-utils";
import { applyOp, applyOps } from "./sync/reducer";
import { getPeerId } from "./sync/sync";
import type { Operation } from "./sync/types";
import type { EditorState, UndoGroup, UndoManagerState } from "./types";

export const initialUndoManagerState: UndoManagerState = {
  undoStack: [],
  redoStack: [],
};

//NOTE - up to here these has nothing with undo/redo

/**
 * Record operations to the undo stack.
 *
 * Captures the inverses of `ops` against `stateBefore` and stores them on
 * the UndoGroup. At undo time those inverses are re-stamped with fresh
 * id/clock and applied verbatim — they don't get recomputed from current
 * state. That decouples undo from any intervening remote edits and removes
 * a whole class of "inverse function drifted from apply function" bugs.
 *
 * Clears the redo stack since a new action invalidates redo history.
 *
 * @param stateBefore - The state BEFORE the operations were applied
 * @param stateAfter - The state AFTER the operations were applied
 * @param ops - The operations that were applied
 * @param peerId - The peer ID of the user who performed the operations
 */
export function recordUndoOps(
  stateBefore: EditorState,
  stateAfter: EditorState,
  ops: readonly Operation[],
  peerId: string,
): EditorState {
  if (ops.length === 0) return stateAfter;

  const cursorBefore = captureCRDTCursor(stateBefore);
  const selectionBefore = captureCRDTSelection(stateBefore);
  const cursorAfter = captureCRDTCursor(stateAfter);
  const selectionAfter = captureCRDTSelection(stateAfter);

  // Capture inverses now, against stateBefore. invertOperations folds
  // applyOp through `ops` so each op's inverse is computed against the
  // state immediately before that specific op was applied.
  const inverses = invertOperations(ops, stateBefore.document.page, applyOp);

  const undoGroup: UndoGroup = {
    operations: ops,
    inverses,
    peerId,
    cursorBefore,
    selectionBefore,
    cursorAfter,
    selectionAfter,
  };

  return {
    ...stateAfter,
    undoManager: {
      undoStack: [...stateAfter.undoManager.undoStack, undoGroup],
      redoStack: [], // Clear redo stack on new operations
    },
  };
}

/**
 * Invalidate cache for affected blocks after applying operations.
 */
function invalidateAffectedBlocks(
  state: EditorState,
  operations: Operation[],
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
 *
 * Applies the captured inverses (re-stamped with fresh id/clock via
 * refreshOps) instead of recomputing them from current state. The captured
 * inverses encode the original action's pre-state and apply cleanly even if
 * other peers have edited the document around them in the meantime.
 *
 * Returns the updated state and the inverse operations that were applied
 * (already stamped with fresh id/clock, ready to be broadcast to peers).
 */
export function undoState(state: EditorState): {
  state: EditorState;
  ops: Operation[];
} {
  const { undoStack, redoStack } = state.undoManager;
  const currentPeerId = getPeerId();

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

  // If the captured inverses are empty (e.g. all the original ops were
  // no-ops in the first place), skip this group and try the next.
  if (undoGroup.inverses.length === 0) {
    const newUndoStack = [
      ...undoStack.slice(0, lastUserGroupIndex),
      ...undoStack.slice(lastUserGroupIndex + 1),
    ];
    return undoState({
      ...state,
      undoManager: { ...state.undoManager, undoStack: newUndoStack },
    });
  }

  // Re-stamp the captured inverses with fresh id/clock so peers (and the
  // local oplog) see them as new events. Payload is unchanged.
  const inverseOps = refreshOps(undoGroup.inverses);

  // Apply inverse operations to the page
  const newPage = applyOps(state.document.page, inverseOps);

  // Create state with new page
  let newState: EditorState = {
    ...state,
    document: {
      ...state.document,
      page: newPage,
    },
  };

  invalidateAffectedBlocks(newState, inverseOps);

  // Restore cursor/selection to the state BEFORE the operation was performed
  newState = restoreCursor(newState, undoGroup.cursorBefore);
  newState = restoreSelection(newState, undoGroup.selectionBefore);

  // Update undo/redo stacks
  const newUndoStack = [
    ...undoStack.slice(0, lastUserGroupIndex),
    ...undoStack.slice(lastUserGroupIndex + 1),
  ];

  // Carry the original group onto the redo stack verbatim, including its
  // captured inverses. A subsequent redo→undo cycle will reuse the same
  // inverses, keeping the round-trip deterministic.
  const redoGroup: UndoGroup = {
    operations: undoGroup.operations,
    inverses: undoGroup.inverses,
    peerId: currentPeerId,
    cursorBefore: undoGroup.cursorBefore,
    selectionBefore: undoGroup.selectionBefore,
    cursorAfter: undoGroup.cursorAfter,
    selectionAfter: undoGroup.selectionAfter,
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
 *
 * Re-applies the original operations (re-stamped with fresh id/clock via
 * refreshOps). The captured inverses are carried back to the undo stack so
 * subsequent re-undo uses the same inverses — the same emit-time pre-state
 * is still the correct rollback target.
 */
export function redoState(state: EditorState): {
  state: EditorState;
  ops: Operation[];
} {
  const { undoStack, redoStack } = state.undoManager;
  const currentPeerId = getPeerId();

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

  const redoGroupData = redoStack[lastUserGroupIndex];

  // Re-stamp the original ops with fresh id/clock. The originals are
  // already in every peer's version vector from the first broadcast, so
  // re-sending them would be a no-op; the re-stamped copies propagate
  // normally. Semantic effect is identical because the payload is unchanged.
  const redoOps = refreshOps(redoGroupData.operations);

  // Apply redo operations to the page
  const newPage = applyOps(state.document.page, redoOps);

  // Create state with new page
  let newState: EditorState = {
    ...state,
    document: {
      ...state.document,
      page: newPage,
    },
  };

  invalidateAffectedBlocks(newState, redoOps);

  // Restore cursor/selection to the state AFTER the operation was performed
  newState = restoreCursor(newState, redoGroupData.cursorAfter);
  newState = restoreSelection(newState, redoGroupData.selectionAfter);

  // Update undo/redo stacks
  const newRedoStack = [
    ...redoStack.slice(0, lastUserGroupIndex),
    ...redoStack.slice(lastUserGroupIndex + 1),
  ];

  // Carry the captured inverses back to the undo stack so subsequent
  // re-undo rolls back to the same emit-time pre-state.
  const undoGroup: UndoGroup = {
    operations: redoGroupData.operations,
    inverses: redoGroupData.inverses,
    peerId: currentPeerId,
    cursorBefore: redoGroupData.cursorBefore,
    selectionBefore: redoGroupData.selectionBefore,
    cursorAfter: redoGroupData.cursorAfter,
    selectionAfter: redoGroupData.selectionAfter,
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

//NOTE - this should be crdt folder
