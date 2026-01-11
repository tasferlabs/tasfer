/**
 * Operation Generation Helpers
 *
 * Functions to generate CRDT operations from editor actions.
 * These are used by the SyncBinding to emit operations when
 * editor commands execute.
 */

import type { Operation, BlockType, FormatType } from "./types";
import type { SyncEngine } from "./index";

/**
 * Generate operations for inserting text at a position.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block to insert into
 * @param position - Text position (0-based visible character index)
 * @param text - Text to insert
 * @returns Array of operations to emit
 */
export function createTextInsertOps(
  engine: SyncEngine,
  blockId: string,
  position: number,
  text: string
): Operation[] {
  const op = engine.insertText(blockId, position, text);
  return [op];
}

/**
 * Generate operations for deleting text in a range.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block to delete from
 * @param startIndex - Start position (inclusive)
 * @param endIndex - End position (exclusive)
 * @returns Array of operations to emit
 */
export function createTextDeleteOps(
  engine: SyncEngine,
  blockId: string,
  startIndex: number,
  endIndex: number
): Operation[] {
  if (startIndex >= endIndex) {
    return [];
  }
  const op = engine.deleteText(blockId, startIndex, endIndex);
  return [op];
}

/**
 * Generate operations for formatting text in a range.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block containing the text
 * @param startIndex - Start position (inclusive)
 * @param endIndex - End position (exclusive)
 * @param format - Format type to apply
 * @param value - Format value (boolean or string for links)
 * @returns Array of operations to emit
 */
export function createFormatOps(
  engine: SyncEngine,
  blockId: string,
  startIndex: number,
  endIndex: number,
  format: FormatType,
  value: boolean | string
): Operation[] {
  if (startIndex >= endIndex) {
    return [];
  }
  const op = engine.formatText(blockId, startIndex, endIndex, format, value);
  return [op];
}

/**
 * Generate operations for splitting a block (Enter key).
 *
 * This operation:
 * 1. Creates a new block after the current one
 * 2. Deletes text after cursor from current block
 * 3. Inserts that text into the new block
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block to split
 * @param splitPosition - Position to split at
 * @param textAfterCursor - Text to move to new block
 * @returns Array of operations to emit, with blockInsert first
 */
export function createSplitBlockOps(
  engine: SyncEngine,
  blockId: string,
  splitPosition: number,
  textAfterCursor: string
): Operation[] {
  const ops: Operation[] = [];

  // 1. Insert new paragraph block after current
  const blockInsert = engine.createBlockInsert(blockId, "paragraph");
  ops.push(blockInsert);

  // 2. Delete text after cursor from current block
  const state = engine.getState();
  const block = state.blocks.find((b) => b.id === blockId);
  if (block && block.chars && block.type !== "image" && block.type !== "line") {
    const textLength = block.chars.filter((c) => !c.deleted).length;
    if (splitPosition < textLength) {
      const deleteOp = engine.deleteText(blockId, splitPosition, textLength);
      ops.push(deleteOp);
    }
  }

  // 3. Insert text into new block (if any)
  if (textAfterCursor.length > 0) {
    const insertOp = engine.insertText(blockInsert.blockId, 0, textAfterCursor);
    ops.push(insertOp);
  }

  return ops;
}

/**
 * Generate operations for merging two blocks (Backspace at block start).
 *
 * This operation:
 * 1. Moves text from second block to end of first block
 * 2. Deletes the second block
 *
 * @param engine - SyncEngine instance
 * @param firstBlockId - Block to merge into
 * @param secondBlockId - Block to merge from (will be deleted)
 * @param secondBlockText - Text content of second block
 * @returns Array of operations to emit
 */
export function createMergeBlockOps(
  engine: SyncEngine,
  firstBlockId: string,
  secondBlockId: string,
  secondBlockText: string
): Operation[] {
  const ops: Operation[] = [];

  // 1. Get length of first block text (insert position)
  const state = engine.getState();
  const firstBlock = state.blocks.find((b) => b.id === firstBlockId);
  const insertPosition = firstBlock
    ? firstBlock.chars.filter((c) => !c.deleted).length
    : 0;

  // 2. Insert second block's text at end of first block
  if (secondBlockText.length > 0) {
    const insertOp = engine.insertText(
      firstBlockId,
      insertPosition,
      secondBlockText
    );
    ops.push(insertOp);
  }

  // 3. Delete second block
  const deleteOp = engine.createBlockDelete(secondBlockId);
  ops.push(deleteOp);

  return ops;
}

/**
 * Generate operations for changing block type.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block to change
 * @param newType - New block type
 * @returns Array of operations to emit
 */
export function createBlockTypeChangeOps(
  engine: SyncEngine,
  blockId: string,
  newType: BlockType
): Operation[] {
  const op = engine.changeBlockType(blockId, newType);
  return [op];
}

/**
 * Generate operations for changing a block property.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block to update
 * @param field - Property field name (indent, checked, url, etc.)
 * @param value - New property value
 * @returns Array of operations to emit
 */
export function createBlockPropertyOps(
  engine: SyncEngine,
  blockId: string,
  field: string,
  value: unknown
): Operation[] {
  const op = engine.createBlockSet(blockId, field, value);
  return [op];
}

/**
 * Generate operations for inserting a new block.
 *
 * @param engine - SyncEngine instance
 * @param afterBlockId - Insert after this block (null = beginning)
 * @param blockType - Type of block to create
 * @returns The block insert operation (also returns blockId)
 */
export function createBlockInsertOp(
  engine: SyncEngine,
  afterBlockId: string | null,
  blockType: BlockType
): Operation {
  return engine.createBlockInsert(afterBlockId, blockType);
}

/**
 * Generate operations for deleting a block.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block to delete
 * @returns Array of operations to emit
 */
export function createBlockDeleteOps(
  engine: SyncEngine,
  blockId: string
): Operation[] {
  const op = engine.createBlockDelete(blockId);
  return [op];
}

/**
 * Generate operations for toggling a format on a selection.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block containing the selection
 * @param startIndex - Start position (inclusive)
 * @param endIndex - End position (exclusive)
 * @param format - Format type to toggle
 * @param currentlyHasFormat - Whether selection currently has this format
 * @returns Array of operations to emit
 */
export function createToggleFormatOps(
  engine: SyncEngine,
  blockId: string,
  startIndex: number,
  endIndex: number,
  format: FormatType,
  currentlyHasFormat: boolean
): Operation[] {
  // Toggle: if has format, remove it; otherwise add it
  const value = !currentlyHasFormat;
  return createFormatOps(engine, blockId, startIndex, endIndex, format, value);
}

/**
 * Generate operations for setting a link on a selection.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Block containing the selection
 * @param startIndex - Start position (inclusive)
 * @param endIndex - End position (exclusive)
 * @param url - Link URL (empty string to remove link)
 * @returns Array of operations to emit
 */
export function createLinkOps(
  engine: SyncEngine,
  blockId: string,
  startIndex: number,
  endIndex: number,
  url: string
): Operation[] {
  const value = url || false; // false removes the link
  return createFormatOps(engine, blockId, startIndex, endIndex, "link", value);
}

/**
 * Generate operations for indenting a list item.
 *
 * @param engine - SyncEngine instance
 * @param blockId - List block to indent
 * @param newIndent - New indent level
 * @returns Array of operations to emit
 */
export function createIndentOps(
  engine: SyncEngine,
  blockId: string,
  newIndent: number
): Operation[] {
  // Ensure indent is not negative
  const safeIndent = Math.max(0, newIndent);
  return createBlockPropertyOps(engine, blockId, "indent", safeIndent);
}

/**
 * Generate operations for toggling a todo item's checked state.
 *
 * @param engine - SyncEngine instance
 * @param blockId - Todo block to toggle
 * @returns Array of operations to emit
 */
export function createToggleTodoOps(engine: SyncEngine, blockId: string): Operation[] {
  const state = engine.getState();
  const block = state.blocks.find((b) => b.id === blockId);
  const currentChecked = block?.props.checked ?? false;

  return createBlockPropertyOps(engine, blockId, "checked", !currentChecked);
}
