/**
 * Operation Inversion for User-Independent Undo/Redo
 *
 * This module computes inverse operations for each operation type.
 * When undoing, we apply the inverse operation instead of restoring state snapshots.
 * This allows undo/redo to work independently per user in a CRDT environment.
 */

import type { Block, Char } from "@/deserializer/loadPage";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  FormatSet,
  Operation,
  TextDelete,
  TextInsert
} from "../sync/types";
import type { EditorState } from "./types";

/**
 * Compute the inverse of a text insert operation.
 * Inverse: Delete the inserted characters.
 */
function invertTextInsert(
  op: TextInsert,
  state: EditorState
): TextDelete | null {
  // To invert a text insert, we need to delete the characters that were inserted
  const charIds = op.chars.map((c) => c.id);

  if (charIds.length === 0) {
    return null;
  }

  return {
    op: "text_delete",
    id: state.crdt.idGen(),
    clock: state.crdt.clock(),
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
  if (block.type === "image" || block.type === "line") {
    return null;
  }

  // Find the tombstoned (deleted) characters in the block
  const charsToReinsert: Char[] = [];
  const charIdSet = new Set(op.charIds);

  for (const char of block.chars) {
    if (charIdSet.has(char.id) && char.deleted) {
      charsToReinsert.push({
        id: char.id,
        char: char.char,
      });
    }
  }

  if (charsToReinsert.length === 0) {
    return null; // All chars already restored or missing
  }

  // Find the position to insert after (skip tombstoned chars when looking backwards)
  let afterCharId: string | null = null;
  const firstDeletedId = charsToReinsert[0].id;

  for (let i = 0; i < block.chars.length; i++) {
    if (block.chars[i].id === firstDeletedId) {
      // Look backwards for first non-deleted char
      for (let j = i - 1; j >= 0; j--) {
        if (!block.chars[j].deleted) {
          afterCharId = block.chars[j].id;
          break;
        }
      }
      break;
    }
  }

  return {
    op: "text_insert",
    id: state.crdt.idGen(),
    clock: state.crdt.clock(),
    pageId: op.pageId,
    blockId: op.blockId,
    afterCharId,
    chars: charsToReinsert,
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
    id: state.crdt.idGen(),
    clock: state.crdt.clock(),
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
  state: EditorState
): BlockDelete | null {
  return {
    op: "block_delete",
    id: state.crdt.idGen(),
    clock: state.crdt.clock(),
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
    id: state.crdt.idGen(),
    clock: state.crdt.clock(),
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
    id: state.crdt.idGen(),
    clock: state.crdt.clock(),
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
