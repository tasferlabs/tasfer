/**
 * CRDT Helper Functions
 *
 * These helpers return BOTH the new data AND the CRDT operation atomically.
 * Also includes functions to apply remote CRDT operations to editor Page blocks.
 */

import type { Block, Char, CharRun, FormatSpan, Page, TextFormat } from "../../deserializer/loadPage";
import { isTextualBlock } from "../../deserializer/loadPage";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  FormatSet,
  Operation,
  TextDelete,
  TextInsert
} from "../sync/types";
import { getPageId, nextId, getClock } from "./sync";
import {
  insertIntoRuns,
  deleteFromRuns,
  getVisibleTextFromRuns,
  getVisibleLengthFromRuns,
  getCharIdAtVisiblePosition,
  iterateVisibleChars,
  isCharIdInRange,
} from "./char-runs";

export interface InsertCharsResult {
  newCharRuns: CharRun[];
  op: TextInsert;
}

export interface DeleteCharsResult {
  newCharRuns: CharRun[];
  op: TextDelete;
}

export interface FormatCharsResult {
  newFormats: FormatSpan[];
  op: FormatSet;
}

/**
 * Insert text at a position - returns new charRuns AND the operation
 */
export function insertCharsAtPosition(
  charRuns: CharRun[] | undefined,
  position: number,
  text: string,
  blockId: string
): InsertCharsResult {
  const afterCharId = getCharIdAtVisiblePosition(charRuns, position);

  // Create new Char objects for the operation payload
  // Each char gets a unique ID from nextId()
  const newCharObjects: Char[] = Array.from(text).map((char) => ({
    id: nextId(),
    char,
  }));

  // Insert into runs
  const newCharRuns = insertIntoRuns(charRuns, afterCharId, newCharObjects);

  const op: TextInsert = {
    op: "text_insert",
    id: nextId(),
    clock: getClock(),
    pageId: getPageId(),
    blockId,
    afterCharId,
    chars: newCharObjects,
  };

  return { newCharRuns, op };
}

/**
 * Delete text in a range - returns new charRuns AND the operation
 */
export function deleteCharsInRange(
  charRuns: CharRun[] | undefined,
  startIndex: number,
  endIndex: number,
  blockId: string
): DeleteCharsResult {
  // Get char IDs to delete
  const deletedIds = getCharIdsInRange(charRuns, startIndex, endIndex);

  // Delete from runs
  const newCharRuns = deleteFromRuns(charRuns, deletedIds);

  const op: TextDelete = {
    op: "text_delete",
    id: nextId(),
    clock: getClock(),
    pageId: getPageId(),
    blockId,
    charIds: deletedIds,
  };

  return { newCharRuns, op };
}

/**
 * Check if a character ID is within a format span
 */
function isCharIdInSpan(charId: string, span: FormatSpan, charRuns: CharRun[] | undefined): boolean {
  if (!charRuns) return false;
  return isCharIdInRange(charRuns, charId, span.startCharId, span.endCharId);
}

/**
 * Apply formatting to a range - returns new formats AND the operation
 * When value is false, removes the format from the range
 */
export function formatCharsInRange(
  charRuns: CharRun[] | undefined,
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
  blockId: string,
  format: TextFormat,
  value: boolean | string
): FormatCharsResult {
  const charIds = getCharIdsInRange(charRuns, startIndex, endIndex);

  if (charIds.length === 0) {
    return {
      newFormats: formats,
      op: {
        op: "format_set",
        id: nextId(),
        clock: getClock(),
        pageId: getPageId(),
        blockId,
        charIds: [],
        format,
        value,
      },
    };
  }

  let newFormats: FormatSpan[];

  if (value === false) {
    // Remove format: filter out spans that match this format type and overlap with our range
    newFormats = formats.filter(span => {
      if (span.format.type !== format.type) return true;

      // Check if this span overlaps with any of our charIds
      const overlaps = charIds.some(charId => isCharIdInSpan(charId, span, charRuns));
      return !overlaps;
    });
  } else {
    // Add format: create a new span
    const newSpan: FormatSpan = {
      startCharId: charIds[0],
      endCharId: charIds[charIds.length - 1],
      format,
      clock: getClock(),
    };
    newFormats = [...formats, newSpan];
  }

  const op: FormatSet = {
    op: "format_set",
    id: nextId(),
    clock: getClock(),
    pageId: getPageId(),
    blockId,
    charIds,
    format,
    value,
  };

  return { newFormats, op };
}

export function getVisibleText(charRuns: CharRun[]): string {
  return getVisibleTextFromRuns(charRuns);
}

export function getVisibleLength(charRuns: CharRun[]): number {
  return getVisibleLengthFromRuns(charRuns);
}

export function getCharIdsInRange(
  charRuns: CharRun[] | undefined,
  startIndex: number,
  endIndex: number
): string[] {
  if (!charRuns) return [];

  const ids: string[] = [];
  let visibleCount = 0;

  for (const { id } of iterateVisibleChars(charRuns)) {
    if (visibleCount >= startIndex && visibleCount < endIndex) {
      ids.push(id);
    }
    visibleCount++;
    if (visibleCount >= endIndex) break;
  }

  return ids;
}

function findCharIdAtPosition(charRuns: CharRun[] | undefined, position: number): string | null {
  return getCharIdAtVisiblePosition(charRuns, position);
}

/**
 * Check if all characters in a range have a specific format
 */
export function allCharsHaveFormat(
  charRuns: CharRun[] | undefined,
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
  formatType: TextFormat["type"]
): boolean {
  if (!charRuns) return false;

  const charIds = getCharIdsInRange(charRuns, startIndex, endIndex);
  if (charIds.length === 0) return false;

  // Check if all char IDs are covered by format spans of the given type
  return charIds.every(charId =>
    formats.some(span =>
      span.format.type === formatType &&
      isCharIdInSpan(charId, span, charRuns)
    )
  );
}

/**
 * Get formats at a specific position (for cursor)
 */
export function getFormatsAtCharPosition(
  charRuns: CharRun[],
  formats: FormatSpan[],
  position: number
): TextFormat[] {
  if (position === 0) return [];

  // Get the char ID at position (inherit from previous char)
  const charId = findCharIdAtPosition(charRuns, position);
  if (!charId) return [];

  // Find all format spans that include this char
  const activeFormats: TextFormat[] = [];
  for (const span of formats) {
    if (isCharIdInSpan(charId, span, charRuns)) {
      activeFormats.push(span.format);
    }
  }

  return activeFormats;
}

// =============================================================================
// Remote Operation Application
// =============================================================================

/**
 * Apply a remote text insert operation to editor Page blocks
 */
function applyRemoteTextInsert(page: Page, op: TextInsert): Page {
  const blockIndex = page.blocks.findIndex((b) => b.id === op.blockId);

  if (blockIndex === -1) {
    // Block not found - this can happen if block insert is received later
    return page;
  }

  const block = page.blocks[blockIndex];

  // Skip text operations on blocks that don't have text content
  if (!isTextualBlock(block)) {
    return page;
  }

  // Insert into charRuns
  const newCharRuns = insertIntoRuns(block.charRuns, op.afterCharId, op.chars);

  const updatedBlock = { ...block, charRuns: newCharRuns };
  const newBlocks = [...page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...page, blocks: newBlocks };
}

/**
 * Apply a remote text delete operation to editor Page blocks
 */
function applyRemoteTextDelete(page: Page, op: TextDelete): Page {
  const blockIndex = page.blocks.findIndex((b) => b.id === op.blockId);

  if (blockIndex === -1) {
    return page;
  }

  const block = page.blocks[blockIndex];

  if (!isTextualBlock(block)) {
    return page;
  }

  // Delete from charRuns
  const newCharRuns = deleteFromRuns(block.charRuns, op.charIds);

  const updatedBlock = { ...block, charRuns: newCharRuns };
  const newBlocks = [...page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...page, blocks: newBlocks };
}

/**
 * Apply a remote format set operation to editor Page blocks
 */
function applyRemoteFormatSet(page: Page, op: FormatSet): Page {
  const blockIndex = page.blocks.findIndex((b) => b.id === op.blockId);

  if (blockIndex === -1) {
    return page;
  }

  const block = page.blocks[blockIndex];

  if (!isTextualBlock(block)) {
    return page;
  }

  if (op.charIds.length === 0) {
    return page;
  }

  let newFormats: FormatSpan[];

  if (op.value === false) {
    // Remove format: filter out spans that match this format type and overlap with charIds
    newFormats = block.formats.filter((span) => {
      if (span.format.type !== op.format.type) return true;

      // Check if this span overlaps with any of the charIds
      const overlaps = op.charIds.some((charId) =>
        isCharIdInSpan(charId, span, block.charRuns)
      );
      return !overlaps;
    });
  } else {
    // Add format: create a new span
    const newSpan: FormatSpan = {
      startCharId: op.charIds[0],
      endCharId: op.charIds[op.charIds.length - 1],
      format: op.format,
      clock: op.clock,
    };
    newFormats = [...block.formats, newSpan];
  }

  const updatedBlock = {
    ...block,
    formats: newFormats,
  };

  const newBlocks = [...page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...page, blocks: newBlocks };
}

/**
 * Apply a remote block insert operation to editor Page blocks
 */
function applyRemoteBlockInsert(page: Page, op: BlockInsert): Page {
  // Check if block already exists
  const existingBlockIndex = page.blocks.findIndex((b) => b.id === op.blockId);

  if (existingBlockIndex !== -1) {
    // Block exists - if it's tombstoned, restore it; otherwise it's idempotent (no-op)
    const existingBlock = page.blocks[existingBlockIndex];
    if (existingBlock.deleted) {
      // Restore the tombstoned block by marking it as not deleted
      const restoredBlock = { ...existingBlock, deleted: false };
      const newBlocks = [...page.blocks];
      newBlocks[existingBlockIndex] = restoredBlock;
      return { ...page, blocks: newBlocks };
    }
    // Block already exists and is not deleted - idempotent, do nothing
    return page;
  }

  // Create the new block with appropriate type-specific properties
  let newBlock: Block;
  const baseBlock = {
    id: op.blockId,
    charRuns: [] as CharRun[],
    formats: [] as FormatSpan[],
    afterId: op.afterBlockId, // Store the afterBlockId for position tracking
  };

  switch (op.blockType) {
    case "paragraph":
      newBlock = { ...baseBlock, type: "paragraph" };
      break;
    case "heading1":
    case "heading2":
    case "heading3":
      newBlock = { ...baseBlock, type: op.blockType };
      break;
    case "bullet_list":
      newBlock = { ...baseBlock, type: "bullet_list", indent: op.initialProps?.indent ?? 0 };
      break;
    case "numbered_list":
      newBlock = { ...baseBlock, type: "numbered_list", indent: op.initialProps?.indent ?? 0 };
      break;
    case "todo_list":
      newBlock = {
        ...baseBlock,
        type: "todo_list",
        checked: op.initialProps?.checked ?? false,
        indent: op.initialProps?.indent ?? 0,
      };
      break;
    case "image":
      newBlock = {
        id: op.blockId,
        type: "image",
        url: op.initialProps?.url ?? "",
        alt: op.initialProps?.alt,
        width: op.initialProps?.width,
        height: op.initialProps?.height,
        objectFit: op.initialProps?.objectFit,
        afterId: op.afterBlockId, // Store for position tracking
      };
      break;
    case "line":
      newBlock = { id: op.blockId, type: "line", afterId: op.afterBlockId };
      break;
    default:
      newBlock = { ...baseBlock, type: "paragraph" };
  }

  // Find insertion position based on afterBlockId
  let insertIndex = 0;
  if (op.afterBlockId) {
    const afterIndex = page.blocks.findIndex((b) => b.id === op.afterBlockId);
    if (afterIndex !== -1) {
      insertIndex = afterIndex + 1;
    }
  }

  const newBlocks = [...page.blocks];
  newBlocks.splice(insertIndex, 0, newBlock);

  return { ...page, blocks: newBlocks };
}

/**
 * Apply a remote block delete operation to editor Page blocks
 * Marks the block as deleted (tombstone) instead of removing it,
 * preserving position information for potential undo operations.
 */
function applyRemoteBlockDelete(page: Page, op: BlockDelete): Page {
  const blockIndex = page.blocks.findIndex((b) => b.id === op.blockId);

  if (blockIndex === -1) {
    return page;
  }

  const block = page.blocks[blockIndex];

  // Mark block as deleted (tombstone) instead of removing it
  const updatedBlock = { ...block, deleted: true };
  const newBlocks = [...page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...page, blocks: newBlocks };
}

/**
 * Apply a remote block set operation to editor Page blocks
 */
function applyRemoteBlockSet(page: Page, op: BlockSet): Page {
  const blockIndex = page.blocks.findIndex((b) => b.id === op.blockId);

  if (blockIndex === -1) {
    return page;
  }

  const block = page.blocks[blockIndex];

  // Handle 'type' field - block type change
  if (op.field === "type") {
    // Type changes are complex and may need structure changes
    // For now, just update the type property
    const updatedBlock = { ...block, type: op.value } as Block;
    const newBlocks = [...page.blocks];
    newBlocks[blockIndex] = updatedBlock;
    return { ...page, blocks: newBlocks };
  }

  // Handle other property fields directly on the block
  const updatedBlock = { ...block, [op.field]: op.value } as Block;
  const newBlocks = [...page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...page, blocks: newBlocks };
}

/**
 * Apply a single remote operation to editor Page
 */
export function applyRemoteOp(page: Page, op: Operation): Page {
  switch (op.op) {
    case "text_insert":
      return applyRemoteTextInsert(page, op);
    case "text_delete":
      return applyRemoteTextDelete(page, op);
    case "format_set":
      return applyRemoteFormatSet(page, op);
    case "block_insert":
      return applyRemoteBlockInsert(page, op);
    case "block_delete":
      return applyRemoteBlockDelete(page, op);
    case "block_set":
      return applyRemoteBlockSet(page, op);
    default:
      return page;
  }
}

/**
 * Apply multiple remote operations to editor Page
 */
export function applyRemoteOps(page: Page, ops: Operation[]): Page {
  let result = page;
  for (const op of ops) {
    result = applyRemoteOp(result, op);
  }
  return result;
}
