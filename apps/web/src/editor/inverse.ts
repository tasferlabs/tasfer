/**
 * Operation Inversion for User-Independent Undo/Redo
 *
 * This module computes inverse operations for each operation type.
 * When undoing, we apply the inverse operation instead of restoring state snapshots.
 * This allows undo/redo to work independently per user in a CRDT environment.
 */

import type { Block, Char, CharRun } from "@/deserializer/loadPage";
import { getClock, nextId } from "./sync/sync";
import {
  iterateAllChars,
  charRunsToChars,
} from "./sync/char-runs";
import { extractPeerId, extractCounter } from "./sync/id";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  FormatSet,
  Operation,
  TextDelete,
  TextInsert
} from "./sync/types";
import type { EditorState } from "./types";

/**
 * Convert Char[] to CharRun[] (for inverse operations).
 * Handles chars from multiple peers by splitting into separate runs.
 */
function charsToCharRuns(chars: Char[]): CharRun[] {
  if (chars.length === 0) return [];

  const runs: CharRun[] = [];
  let currentPeerId = extractPeerId(chars[0].id);
  let currentStartCounter = extractCounter(chars[0].id);
  let currentText = "";
  let currentDeleted: boolean[] = [];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const peerId = extractPeerId(char.id);
    const counter = extractCounter(char.id);

    // Check if continues current run (same peer, consecutive counter)
    if (
      peerId === currentPeerId &&
      counter === currentStartCounter + currentText.length
    ) {
      currentText += char.char;
      currentDeleted.push(char.deleted ?? false);
    } else {
      // Finish current run
      if (currentText.length > 0) {
        runs.push(
          createCharRunFromDeleted(
            currentPeerId,
            currentStartCounter,
            currentText,
            currentDeleted
          )
        );
      }

      // Start new run
      currentPeerId = peerId;
      currentStartCounter = counter;
      currentText = char.char;
      currentDeleted = [char.deleted ?? false];
    }
  }

  // Finish last run
  if (currentText.length > 0) {
    runs.push(
      createCharRunFromDeleted(
        currentPeerId,
        currentStartCounter,
        currentText,
        currentDeleted
      )
    );
  }

  return runs;
}

/**
 * Helper to create CharRun with optional deletedMask
 */
function createCharRunFromDeleted(
  peerId: string,
  startCounter: number,
  text: string,
  deleted: boolean[]
): CharRun {
  const hasDeleted = deleted.some((d) => d);

  if (!hasDeleted) {
    return { peerId, startCounter, text };
  }

  // Create deletedMask bitmap
  const deletedMask: number[] = new Array(Math.ceil(deleted.length / 8)).fill(0);
  deleted.forEach((isDeleted, i) => {
    if (isDeleted) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      deletedMask[byteIndex] |= 1 << bitIndex;
    }
  });

  return { peerId, startCounter, text, deletedMask };
}

/**
 * Compute the inverse of a text insert operation.
 * Inverse: Delete the inserted characters.
 */
function invertTextInsert(
  op: TextInsert,
  _state: EditorState
): TextDelete | null {
  // To invert a text insert, we need to delete the characters that were inserted
  // Convert charRuns back to chars to get the IDs
  const chars = charRunsToChars(op.charRuns);
  const charIds = chars.map((c) => c.id);

  if (charIds.length === 0) {
    return null;
  }

  return {
    op: "text_delete",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
    charIds,
  };
}

/**
 * Compute the inverse of a text delete operation.
 * Inverse: Re-insert the deleted characters (tombstones).
 */
function invertTextDelete(
  op: TextDelete,
  state: EditorState
): TextInsert | null {
  // Find the block (including tombstoned blocks)
  const block = state.document.page.blocks.find((b) => b.id === op.blockId);

  if (!block) {
    return null;
  }

  // Skip if block itself is tombstoned (deleted by someone else)
  if (block.deleted) {
    return null;
  }

  // Skip blocks without text content
  if (block.type === "image" || block.type === "line" || block.type === "math") {
    return null;
  }

  // Find the tombstoned (deleted) characters in the block
  const charsToReinsert: Char[] = [];
  const charIdSet = new Set(op.charIds);

  // Iterate through all chars (including deleted) to find tombstoned ones
  for (const { id, char, deleted } of iterateAllChars(block.charRuns)) {
    if (charIdSet.has(id) && deleted) {
      charsToReinsert.push({
        id,
        char,
      });
    }
  }

  if (charsToReinsert.length === 0) {
    return null; // All chars already restored or missing
  }

  // Find the position to insert after
  // Look for the character IMMEDIATELY BEFORE the first char to restore in the charRuns sequence
  // This preserves the original CRDT position regardless of tombstone status
  let afterCharId: string | null = null;
  const firstDeletedId = charsToReinsert[0].id;

  // Get all chars in order to find the preceding char
  const allChars: Array<{ id: string; deleted: boolean }> = [];
  for (const { id, deleted } of iterateAllChars(block.charRuns)) {
    allChars.push({ id, deleted });
  }

  const firstDeletedIndex = allChars.findIndex((c) => c.id === firstDeletedId);
  if (firstDeletedIndex > 0) {
    // Use the character immediately before (regardless of its deleted status)
    // This preserves the original CRDT ordering
    afterCharId = allChars[firstDeletedIndex - 1].id;
  }
  // If firstDeletedIndex is 0 or -1, afterCharId stays null (insert at beginning)

  // Convert to CharRuns
  const charRuns = charsToCharRuns(charsToReinsert);

  return {
    op: "text_insert",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
    afterCharId,
    charRuns: charRuns,
  };
}

/**
 * Compute the inverse of a format set operation.
 * Inverse: Set format back to previous value.
 */
function invertFormatSet(op: FormatSet, state: EditorState): FormatSet | null {
  // To invert a format set, we need to know the previous value
  // Since formats use LWW (Last-Writer-Wins), we can just set it to the opposite for toggles
  // For links, we'd need to track the previous URL (simplified here: just toggle off)

  const block = state.document.page.blocks.find((b) => b.id === op.blockId);

  if (!block || block.deleted) {
    return null;
  }

  // For boolean formats (bold, italic, etc.), toggle the value
  let inverseValue: boolean | string;

  if (typeof op.value === "boolean") {
    inverseValue = !op.value;
  } else {
    // For link formats, setting value to false removes the link
    inverseValue = false;
  }

  return {
    op: "format_set",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
    charIds: op.charIds,
    format: op.format,
    value: inverseValue,
  };
}

/**
 * Compute the inverse of a block insert operation.
 * Inverse: Delete the inserted block.
 */
function invertBlockInsert(
  op: BlockInsert,
  _state: EditorState
): BlockDelete | null {
  return {
    op: "block_delete",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
  };
}

/**
 * Compute the inverse of a block delete operation.
 * Inverse: Re-insert the deleted block (tombstone).
 */
function invertBlockDelete(
  op: BlockDelete,
  state: EditorState
): BlockInsert | null {
  // Find the tombstoned block in the current state
  const block: Block | undefined = state.document.page.blocks.find(
    (b) => b.id === op.blockId && b.deleted
  );

  if (!block) {
    return null; // Block not found or already restored
  }

  // Use the block's afterId directly (tombstone preserves position)
  const afterBlockId = block.afterId;

  // Build initial props based on block type
  let initialProps: any = {};
  if (block.type === "bullet_list" || block.type === "numbered_list") {
    initialProps.indent = block.indent;
  } else if (block.type === "todo_list") {
    initialProps.checked = block.checked;
    initialProps.indent = block.indent;
  } else if (block.type === "image") {
    initialProps.url = block.url;
    initialProps.alt = block.alt;
    initialProps.width = block.width;
    initialProps.height = block.height;
    initialProps.objectFit = block.objectFit;
  }

  return {
    op: "block_insert",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    afterBlockId: afterBlockId || null,
    blockId: op.blockId,
    blockType: block.type,
    initialProps,
  };
}

/**
 * Compute the inverse of a block set operation.
 * Inverse: Set the property back to its previous value.
 */
function invertBlockSet(op: BlockSet, state: EditorState): BlockSet | null {
  // To invert a block set, we need to know the previous value
  const block = state.document.page.blocks.find((b) => b.id === op.blockId);

  if (!block || block.deleted) {
    return null;
  }

  // Get the current value (which is the previous value before this op was applied)
  let previousValue: unknown;

  if (op.field === "type") {
    previousValue = block.type;
  } else {
    // Access the field directly on the block (for indent, checked, url, etc.)
    previousValue = (block as any)[op.field];
  }

  return {
    op: "block_set",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
    field: op.field,
    value: previousValue,
  };
}

/**
 * Compute the inverse of any operation.
 * Returns null if the operation cannot be inverted (e.g., missing data).
 */
export function invertOperation(
  op: Operation,
  state: EditorState
): Operation | null {
  switch (op.op) {
    case "text_insert":
      return invertTextInsert(op, state);
    case "text_delete":
      return invertTextDelete(op, state);
    case "format_set":
      return invertFormatSet(op, state);
    case "block_insert":
      return invertBlockInsert(op, state);
    case "block_delete":
      return invertBlockDelete(op, state);
    case "block_set":
      return invertBlockSet(op, state);
    default:
      return null;
  }
}

/**
 * Compute inverses for a batch of operations (in reverse order).
 * When undoing multiple operations, we need to invert them in reverse order.
 */
export function invertOperations(
  ops: readonly Operation[],
  state: EditorState
): Operation[] {
  const inverses: Operation[] = [];

  // Process in reverse order
  for (let i = ops.length - 1; i >= 0; i--) {
    const inverse = invertOperation(ops[i], state);
    if (inverse) {
      inverses.push(inverse);
    }
  }

  return inverses;
}
