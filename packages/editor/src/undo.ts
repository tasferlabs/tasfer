import { isTextualBlock, type Page } from "./deserializer/loadPage";
import { invertOperations, refreshOps } from "./inverse";
import { invalidateBlockCache } from "./renderer";
import { updateCursor, updateSelection } from "./state";
import {
  findCharInRuns,
  iterateVisibleChars
} from "./sync/char-runs";
import { applyOp, applyOps } from "./sync/reducer";
import { getPeerId } from "./sync/sync";
import type { Operation } from "./sync/types";
import type {
  CRDTCursorState,
  CRDTPosition,
  CRDTSelectionState,
  EditorState,
  Position,
  UndoGroup,
  UndoManagerState,
} from "./types";

export const initialUndoManagerState: UndoManagerState = {
  undoStack: [],
  redoStack: [],
};

//NOTE - we should move the crdt to crdt folder
/**
 * Convert a Position (index-based) to a CRDTPosition (ID-based).
 * Returns null if the position cannot be converted (e.g., block doesn't exist).
 */
export function positionToCRDT(
  page: Page,
  position: Position
): CRDTPosition | null {
  const block = page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;

  // For non-textual blocks (images, lines), cursor is always at position 0
  if (!isTextualBlock(block)) {
    return {
      blockId: block.id,
      afterCharId: null,
    };
  }

  // Find the character ID at the given text index
  const visibleChars: Array<{ id: string }> = [];
  for (const { id } of iterateVisibleChars(block.charRuns)) {
    visibleChars.push({ id });
  }

  if (position.textIndex === 0) {
    return {
      blockId: block.id,
      afterCharId: null,
    };
  }

  // textIndex is 1-based for "after" position, so textIndex N means after the Nth visible char
  const charIndex = position.textIndex - 1;
  if (charIndex >= 0 && charIndex < visibleChars.length) {
    return {
      blockId: block.id,
      afterCharId: visibleChars[charIndex].id,
    };
  }

  // If textIndex is beyond the end, use the last character
  if (visibleChars.length > 0) {
    return {
      blockId: block.id,
      afterCharId: visibleChars[visibleChars.length - 1].id,
    };
  }

  return {
    blockId: block.id,
    afterCharId: null,
  };
}

/**
 * Convert a CRDTPosition (ID-based) to a Position (index-based).
 * Returns null if the position cannot be converted (e.g., block was deleted).
 */
export function crdtToPosition(
  page: Page,
  crdtPos: CRDTPosition
): Position | null {
  // Find block by ID
  const blockIndex = page.blocks.findIndex(
    (b) => b.id === crdtPos.blockId && !b.deleted
  );
  if (blockIndex === -1) return null;

  const block = page.blocks[blockIndex];
  if (!block || block.deleted) return null;

  // For non-textual blocks, always return position 0
  if (!isTextualBlock(block)) {
    return {
      blockIndex: blockIndex,
      textIndex: 0,
    };
  }

  // If no afterCharId, cursor is at position 0
  if (crdtPos.afterCharId === null) {
    return {
      blockIndex: blockIndex,
      textIndex: 0,
    };
  }

  // Find the visible index of the character
  const visibleChars: Array<{ id: string }> = [];
  let charVisibleIndex = -1;
  let visibleIndex = 0;
  for (const { id } of iterateVisibleChars(block.charRuns)) {
    visibleChars.push({ id });
    if (id === crdtPos.afterCharId) {
      charVisibleIndex = visibleIndex;
    }
    visibleIndex++;
  }

  if (charVisibleIndex !== -1) {
    // textIndex is the position after the character, so add 1
    return {
      blockIndex: blockIndex,
      textIndex: charVisibleIndex + 1,
    };
  }

  // Character was deleted - find the best fallback position
  // Look for the character in all chars (including deleted) to find its neighbors
  const charResult = findCharInRuns(block.charRuns, crdtPos.afterCharId);

  if (charResult) {
    // Find the nearest visible character before this position
    // We need to count visible chars before this one
    let visibleCountBefore = 0;
    for (const { id } of iterateVisibleChars(block.charRuns)) {
      if (id === crdtPos.afterCharId) {
        break;
      }
      visibleCountBefore++;
    }
    return {
      blockIndex: blockIndex,
      textIndex: visibleCountBefore,
    };
  }

  // Character ID not found at all, default to end of block
  return {
    blockIndex: blockIndex,
    textIndex: visibleChars.length,
  };
}

/**
 * Convert a selection range (index-based) to CRDT positions (ID-based).
 * Returns null if either position cannot be converted.
 */
export function selectionRangeToCRDT(
  page: Page,
  range: { start: Position; end: Position }
): { start: CRDTPosition; end: CRDTPosition } | null {
  const startCRDT = positionToCRDT(page, range.start);
  const endCRDT = positionToCRDT(page, range.end);
  if (!startCRDT || !endCRDT) return null;
  return { start: startCRDT, end: endCRDT };
}

/**
 * Convert CRDT selection range (ID-based) to index-based positions.
 * Returns null if either position cannot be converted.
 */
export function crdtToSelectionRange(
  page: Page,
  crdtRange: { start: CRDTPosition; end: CRDTPosition }
): { start: Position; end: Position } | null {
  const start = crdtToPosition(page, crdtRange.start);
  const end = crdtToPosition(page, crdtRange.end);
  if (!start || !end) return null;
  return { start, end };
}

/**
 * Capture current cursor state as CRDT-compatible state.
 */
function captureCRDTCursor(state: EditorState): CRDTCursorState | null {
  const cursor = state.document.cursor;
  if (!cursor) return null;

  const crdtPos = positionToCRDT(state.document.page, cursor.position);
  if (!crdtPos) return null;

  return { position: crdtPos };
}

/**
 * Capture current selection state as CRDT-compatible state.
 */
function captureCRDTSelection(state: EditorState): CRDTSelectionState | null {
  const selection = state.document.selection;
  if (!selection) return null;

  const anchorCRDT = positionToCRDT(state.document.page, selection.anchor);
  const focusCRDT = positionToCRDT(state.document.page, selection.focus);

  if (!anchorCRDT || !focusCRDT) return null;

  return {
    anchor: anchorCRDT,
    focus: focusCRDT,
  };
}

/**
 * Restore cursor from CRDT state.
 */
function restoreCursor(
  state: EditorState,
  crdtCursor: CRDTCursorState | null
): EditorState {
  if (!crdtCursor) {
    return updateCursor(state, null);
  }

  const position = crdtToPosition(state.document.page, crdtCursor.position);
  return updateCursor(state, position);
}

/**
 * Restore selection from CRDT state.
 */
function restoreSelection(
  state: EditorState,
  crdtSelection: CRDTSelectionState | null
): EditorState {
  if (!crdtSelection) {
    return updateSelection(state, null);
  }

  const anchor = crdtToPosition(state.document.page, crdtSelection.anchor);
  const focus = crdtToPosition(state.document.page, crdtSelection.focus);

  if (!anchor || !focus) {
    return updateSelection(state, null);
  }

  return updateSelection(state, { anchor, focus });
}

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
  peerId: string
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
