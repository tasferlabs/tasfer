/**
 * CRDT Helper Functions
 *
 * These helpers return BOTH the new data AND the CRDT operation atomically.
 * Also includes functions to apply remote CRDT operations to editor Page blocks.
 */

import type { Block, Char, FormatSpan, Page, TextFormat } from "../deserializer/loadPage";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  FormatSet,
  Operation,
  TextDelete,
  TextInsert
} from "../sync/types";
import type { CRDTContext } from "./types";
import { compareIds } from "../sync/id";

export interface InsertCharsResult {
  newChars: Char[];
  op: TextInsert;
}

export interface DeleteCharsResult {
  newChars: Char[];
  op: TextDelete;
}

export interface FormatCharsResult {
  newFormats: FormatSpan[];
  op: FormatSet;
}

/**
 * Insert text at a position - returns new chars AND the operation
 */
export function insertCharsAtPosition(
  chars: Char[],
  position: number,
  text: string,
  blockId: string,
  crdt: CRDTContext
): InsertCharsResult {
  const afterCharId = findCharIdAtPosition(chars, position);
  
  const newCharObjects: Char[] = Array.from(text).map(char => ({
    id: crdt.idGen(),
    char,
    deleted: false,
  }));
  
  const insertIndex = findInsertIndex(chars, position);
  const newChars = [...chars];
  newChars.splice(insertIndex, 0, ...newCharObjects);
  
  const op: TextInsert = {
    op: "text_insert",
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId,
    afterCharId,
    chars: newCharObjects.map(c => ({ id: c.id, char: c.char })),
  };
  
  return { newChars, op };
}

/**
 * Delete text in a range - returns new chars AND the operation
 */
export function deleteCharsInRange(
  chars: Char[],
  startIndex: number,
  endIndex: number,
  blockId: string,
  crdt: CRDTContext,
): DeleteCharsResult {
  const deletedIds: string[] = [];
  let visibleCount = 0;
  
  const newChars = chars.map(char => {
    if (!char.deleted) {
      if (visibleCount >= startIndex && visibleCount < endIndex) {
        deletedIds.push(char.id);
        return { ...char, deleted: true };
      }
      visibleCount++;
    }
    return char;
  });
  
  const op: TextDelete = {
    op: "text_delete",
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId,
    charIds: deletedIds,
  };
  
  return { newChars, op };
}

/**
 * Check if a character ID is within a format span
 */
function isCharIdInSpan(charId: string, span: FormatSpan, chars: Char[]): boolean {
  const startIdx = chars.findIndex(c => c.id === span.startCharId);
  const endIdx = chars.findIndex(c => c.id === span.endCharId);
  const charIdx = chars.findIndex(c => c.id === charId);
  
  if (startIdx === -1 || endIdx === -1 || charIdx === -1) return false;
  
  return charIdx >= startIdx && charIdx <= endIdx;
}

/**
 * Apply formatting to a range - returns new formats AND the operation
 * When value is false, removes the format from the range
 */
export function formatCharsInRange(
  chars: Char[],
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
  blockId: string,
  format: TextFormat,
  value: boolean | string,
  crdt: CRDTContext
): FormatCharsResult {
  const charIds = getCharIdsInRange(chars, startIndex, endIndex);
  
  if (charIds.length === 0) {
    return {
      newFormats: formats,
      op: {
        op: "format_set",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
        blockId,
        charIds: [],
        format: format.type as any,
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
      const overlaps = charIds.some(charId => isCharIdInSpan(charId, span, chars));
      return !overlaps;
    });
  } else {
    // Add format: create a new span
    const newSpan: FormatSpan = {
      startCharId: charIds[0],
      endCharId: charIds[charIds.length - 1],
      format,
      clock: crdt.clock().wall,
    };
    newFormats = [...formats, newSpan];
  }
  
  const op: FormatSet = {
    op: "format_set",
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId,
    charIds,
    format: format.type as any,
    value,
  };
  
  return { newFormats, op };
}

export function getVisibleText(chars: Char[]): string {
  return chars.filter(c => !c.deleted).map(c => c.char).join("");
}

export function getVisibleLength(chars: Char[]): number {
  return chars.filter(c => !c.deleted).length;
}

export function getCharIdsInRange(
  chars: Char[],
  startIndex: number,
  endIndex: number
): string[] {
  const ids: string[] = [];
  let visibleCount = 0;
  
  for (const char of chars) {
    if (!char.deleted) {
      if (visibleCount >= startIndex && visibleCount < endIndex) {
        ids.push(char.id);
      }
      visibleCount++;
      if (visibleCount >= endIndex) break;
    }
  }
  
  return ids;
}

function findCharIdAtPosition(chars: Char[], position: number): string | null {
  if (position === 0) return null;
  
  let visibleCount = 0;
  for (const char of chars) {
    if (!char.deleted) {
      visibleCount++;
      if (visibleCount === position) {
        return char.id;
      }
    }
  }
  return null;
}

function findInsertIndex(chars: Char[], visiblePosition: number): number {
  let visibleCount = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].deleted) {
      if (visibleCount === visiblePosition) return i;
      visibleCount++;
    }
  }
  return chars.length;
}

/**
 * Check if all characters in a range have a specific format
 */
export function allCharsHaveFormat(
  chars: Char[],
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
  formatType: TextFormat["type"]
): boolean {
  const charIds = getCharIdsInRange(chars, startIndex, endIndex);
  if (charIds.length === 0) return false;
  
  // Check if all char IDs are covered by format spans of the given type
  return charIds.every(charId => 
    formats.some(span => 
      span.format.type === formatType && 
      isCharIdInSpan(charId, span, chars)
    )
  );
}

/**
 * Get formats at a specific position (for cursor)
 */
export function getFormatsAtCharPosition(
  chars: Char[],
  formats: FormatSpan[],
  position: number
): TextFormat[] {
  if (position === 0) return [];

  // Get the char ID at position - 1 (inherit from previous char)
  const charId = findCharIdAtPosition(chars, position);
  if (!charId) return [];

  // Find all format spans that include this char
  const activeFormats: TextFormat[] = [];
  for (const span of formats) {
    if (isCharIdInSpan(charId, span, chars)) {
      activeFormats.push(span.format);
    }
  }

  return activeFormats;
}

// =============================================================================
// Remote Operation Application
// =============================================================================

/**
 * Find insertion index for a new character in sorted char array.
 * Characters with the same afterCharId are sorted by their own ID.
 * (Local version that works with editor's Char type where deleted is optional)
 */
function findCharInsertIndexLocal(
  chars: Char[],
  afterCharId: string | null,
  newCharId: string
): number {
  if (afterCharId === null) {
    // Insert at beginning, but after any other chars also inserted at beginning
    // that have a smaller ID (for deterministic ordering)
    let index = 0;
    while (index < chars.length) {
      if (index === 0 || compareIds(chars[index].id, newCharId) >= 0) {
        break;
      }
      index++;
    }
    return index;
  }

  // Find the position of afterCharId
  const afterIndex = chars.findIndex((c) => c.id === afterCharId);

  if (afterIndex === -1) {
    // afterCharId not found - insert at the end as fallback
    return chars.length;
  }

  // Insert after afterIndex, but respect ordering of concurrent inserts
  let insertIndex = afterIndex + 1;

  // Skip past any characters that were also inserted after afterCharId
  // but have a smaller ID than newCharId
  while (insertIndex < chars.length) {
    const existingChar = chars[insertIndex];
    if (compareIds(existingChar.id, newCharId) >= 0) {
      break;
    }
    insertIndex++;
  }

  return insertIndex;
}

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
  if (block.type === "image" || block.type === "line") {
    return page;
  }

  if (!block.chars) {
    return page;
  }

  // Create new chars array with insertions
  const newChars = [...block.chars];
  let insertAfter = op.afterCharId;

  for (const charData of op.chars) {
    const newChar: Char = {
      id: charData.id,
      char: charData.char,
      deleted: false,
    };

    const insertIndex = findCharInsertIndexLocal(newChars, insertAfter, charData.id);
    newChars.splice(insertIndex, 0, newChar);
    insertAfter = charData.id;
  }

  const updatedBlock = { ...block, chars: newChars };
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

  if (block.type === "image" || block.type === "line" || !block.chars) {
    return page;
  }

  const charIdsToDelete = new Set(op.charIds);

  const newChars = block.chars.map((char) => {
    if (charIdsToDelete.has(char.id)) {
      return { ...char, deleted: true };
    }
    return char;
  });

  const updatedBlock = { ...block, chars: newChars };
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

  if (block.type === "image" || block.type === "line") {
    return page;
  }

  // Convert CRDT format to editor TextFormat
  let format: TextFormat;
  if (op.format === "link" && typeof op.value === "string") {
    format = { type: "link", url: op.value };
  } else {
    format = { type: op.format as TextFormat["type"] };
  }

  const newSpan: FormatSpan = {
    startCharId: op.charIds[0],
    endCharId: op.charIds[op.charIds.length - 1],
    format,
    clock: typeof op.clock === "number" ? op.clock : op.clock.wall,
  };

  const updatedBlock = {
    ...block,
    formats: [...block.formats, newSpan],
  };

  const newBlocks = [...page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...page, blocks: newBlocks };
}

/**
 * Apply a remote block insert operation to editor Page blocks
 */
function applyRemoteBlockInsert(page: Page, op: BlockInsert): Page {
  // Check if block already exists (idempotent)
  if (page.blocks.some((b) => b.id === op.blockId)) {
    return page;
  }

  // Create the new block with appropriate type-specific properties
  let newBlock: Block;
  const baseBlock = {
    id: op.blockId,
    chars: [],
    formats: [],
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
      };
      break;
    case "line":
      newBlock = { id: op.blockId, type: "line" };
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
 */
function applyRemoteBlockDelete(page: Page, op: BlockDelete): Page {
  const newBlocks = page.blocks.filter((b) => b.id !== op.blockId);
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
