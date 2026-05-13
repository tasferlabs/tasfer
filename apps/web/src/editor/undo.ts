import { isTextualBlock, type Page, type TextFormat } from "../deserializer/loadPage";
import { invertOperations, refreshOps } from "./inverse";
import { invalidateBlockCache } from "./renderer";
import { updateCursor, updateSelection } from "./state";
import {
  findCharInRuns,
  isCharIdInRange,
  iterateVisibleChars
} from "./sync/char-runs";
import { applyOps } from "./sync/reducer";
import { getPeerId } from "./sync/sync";
import type { Operation } from "./sync/types";
import type {
  CRDTCursorState,
  CRDTPosition,
  CRDTSelectionState,
  EditorState,
  Position,
  PriorFormatEntry,
  UndoGroup,
  UndoManagerState,
} from "./types";

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
 * For each charId affected by a format_set op, find the format of the same
 * type (if any) that was active on that char in stateBefore. Returns null if
 * the block is missing, isn't a textual block, or the op has no charIds.
 */
function capturePriorFormatsForOp(
  stateBefore: EditorState,
  op: Operation
): PriorFormatEntry[] | null {
  if (op.op !== "format_set") return null;
  if (op.charIds.length === 0) return null;

  const block = stateBefore.document.page.blocks.find((b) => b.id === op.blockId);
  if (!block || block.deleted || !isTextualBlock(block)) return null;

  const entries: PriorFormatEntry[] = [];
  for (const charId of op.charIds) {
    let priorFormat: TextFormat | null = null;
    let priorClockCounter = -1;
    let priorClockPeer = "";

    // Walk all spans of the same format type; the latest-clock one wins LWW.
    for (const span of block.formats) {
      if (span.format.type !== op.format.type) continue;
      if (!isCharIdInRange(block.charRuns, charId, span.startCharId, span.endCharId)) {
        continue;
      }
      if (
        span.clock.counter > priorClockCounter ||
        (span.clock.counter === priorClockCounter && span.clock.peerId > priorClockPeer)
      ) {
        priorFormat = span.format;
        priorClockCounter = span.clock.counter;
        priorClockPeer = span.clock.peerId;
      }
    }

    entries.push({ charId, priorFormat });
  }

  return entries;
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

  // Snapshot prior format state for every format_set op so undo can restore
  // per-char what was there before (preserves link URLs, prior bold/italic, etc.)
  // rather than just toggling the format off.
  let priorFormats: Map<string, readonly PriorFormatEntry[]> | undefined;
  for (const op of ops) {
    if (op.op !== "format_set") continue;
    const entries = capturePriorFormatsForOp(stateBefore, op);
    if (!entries) continue;
    if (!priorFormats) priorFormats = new Map();
    priorFormats.set(op.id, entries);
  }

  const undoGroup: UndoGroup = {
    operations: ops,
    peerId,
    cursorBefore,
    selectionBefore,
    cursorAfter,
    selectionAfter,
    priorFormats,
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

  // Compute inverse operations on-the-fly using current state and tombstones.
  // priorFormats lets invertFormatSet restore per-char prior format state
  // (link URLs etc.) instead of just toggling the format off.
  const inverseOps = invertOperations(
    undoGroup.operations,
    state,
    undoGroup.priorFormats
  );

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

  // For redo, store the original operations and preserve cursor state.
  // Carry priorFormats forward so a future undo-after-redo can still restore
  // per-char prior format state.
  const redoGroup: UndoGroup = {
    operations: undoGroup.operations, // Store original ops for redo
    peerId: currentPeerId,
    cursorBefore: undoGroup.cursorBefore,
    selectionBefore: undoGroup.selectionBefore,
    cursorAfter: undoGroup.cursorAfter,
    selectionAfter: undoGroup.selectionAfter,
    priorFormats: undoGroup.priorFormats,
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

  // Get the original operations to reapply.
  //
  // We must re-stamp each op with a fresh id/clock. The originals are already
  // in every peer's version vector from the first broadcast, so re-sending
  // them is a no-op on remote peers — and on the local oplog too. The
  // re-stamped ops are new events that propagate normally; their semantic
  // effect is identical because the payload (charIds, blockId, format, value,
  // afterCharId, etc.) is unchanged, and the apply paths key off those stable
  // IDs (e.g. text_insert un-tombstones by char id).
  const redoGroupData = redoStack[lastUserGroupIndex];
  const redoOps = refreshOps(redoGroupData.operations);

  // Re-key priorFormats from the old op ids to the refreshed ones so that
  // a future undo-after-redo can still look up per-char prior format state.
  let redoPriorFormats: Map<string, readonly PriorFormatEntry[]> | undefined;
  if (redoGroupData.priorFormats) {
    redoPriorFormats = new Map();
    for (let i = 0; i < redoGroupData.operations.length; i++) {
      const oldId = redoGroupData.operations[i].id;
      const entries = redoGroupData.priorFormats.get(oldId);
      if (entries) redoPriorFormats.set(redoOps[i].id, entries);
    }
  }

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

  // Put back on undo stack for potential re-undo, preserving cursor state
  const undoGroup: UndoGroup = {
    operations: redoOps, // The ops we just applied
    peerId: currentPeerId,
    cursorBefore: redoGroupData.cursorBefore,
    selectionBefore: redoGroupData.selectionBefore,
    cursorAfter: redoGroupData.cursorAfter,
    selectionAfter: redoGroupData.selectionAfter,
    priorFormats: redoPriorFormats,
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
