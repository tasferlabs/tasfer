import type {
  EditorState,
  UndoManagerState,
  UndoGroup,
  CRDTPosition,
  CRDTCursorState,
  CRDTSelectionState,
  Position,
} from "./types";
import type { Operation } from "./sync/types";
import { invalidateBlockCache } from "./renderer";
import { applyRemoteOps } from "./sync/crdt-helpers";
import { invertOperations } from "./inverse";
import { isTextualBlock, type Page } from "../deserializer/loadPage";
import { updateCursor, updateSelection } from "./state";

export const initialUndoManagerState: UndoManagerState = {
  undoStack: [],
  redoStack: [],
};

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
  const visibleChars = block.chars.filter((c) => !c.deleted);

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

  // For non-textual blocks, always return position 0
  if (!isTextualBlock(block)) {
    return {
      blockIndex,
      textIndex: 0,
    };
  }

  // If no afterCharId, cursor is at position 0
  if (crdtPos.afterCharId === null) {
    return {
      blockIndex,
      textIndex: 0,
    };
  }

  // Find the visible index of the character
  const visibleChars = block.chars.filter((c) => !c.deleted);
  const charVisibleIndex = visibleChars.findIndex(
    (c) => c.id === crdtPos.afterCharId
  );

  if (charVisibleIndex !== -1) {
    // textIndex is the position after the character, so add 1
    return {
      blockIndex,
      textIndex: charVisibleIndex + 1,
    };
  }

  // Character was deleted - find the best fallback position
  // Look for the character in all chars (including deleted) to find its neighbors
  const allCharsIndex = block.chars.findIndex(
    (c) => c.id === crdtPos.afterCharId
  );

  if (allCharsIndex !== -1) {
    // Find the nearest visible character before this position
    let visibleCountBefore = 0;
    for (let i = 0; i < allCharsIndex; i++) {
      if (!block.chars[i].deleted) {
        visibleCountBefore++;
      }
    }
    return {
      blockIndex,
      textIndex: visibleCountBefore,
    };
  }

  // Character ID not found at all, default to end of block
  return {
    blockIndex,
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
 * Called after any operation that modifies the document.
 * Clears the redo stack since a new action invalidates redo history.
 *
 * @param stateBefore - The state BEFORE the operations were applied (for cursor capture)
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

  // Capture cursor/selection state BEFORE operations (for undo restoration)
  const cursorBefore = captureCRDTCursor(stateBefore);
  const selectionBefore = captureCRDTSelection(stateBefore);

  // Capture cursor/selection state AFTER operations (for redo restoration)
  const cursorAfter = captureCRDTCursor(stateAfter);
  const selectionAfter = captureCRDTSelection(stateAfter);

  const undoGroup: UndoGroup = {
    operations: ops,
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

  // For redo, store the original operations and preserve cursor state
  const redoGroup: UndoGroup = {
    operations: undoGroup.operations, // Store original ops for redo
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
  const redoGroupData = redoStack[lastUserGroupIndex];
  const redoOps = [...redoGroupData.operations];

  // Apply redo operations to the page
  const newPage = applyRemoteOps(state.document.page, redoOps);

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

  // Put back on undo stack for potential re-undo, preserving cursor state
  const undoGroup: UndoGroup = {
    operations: redoOps, // The ops we just applied
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
