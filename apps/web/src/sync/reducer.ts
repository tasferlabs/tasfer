/**
 * CRDT Reducer
 *
 * Applies operations to state and rebuilds state from operations.
 * This is the core of the CRDT engine - all state changes flow through here.
 */

import type {
  PageState,
  BlockState,
  Char,
  FormatSpan,
  Operation,
  TextInsert,
  TextDelete,
  FormatSet,
  BlockInsert,
  BlockDelete,
  BlockSet,
  BlockProps,
  BlockType,
} from "./types";
import { compareHLC } from "./hlc";
import {
  findCharInsertIndex,
  findBlockInsertIndex,
  resolveBlockOrder,
} from "./conflicts";

/**
 * Create an empty page state.
 */
export function createEmptyPageState(pageId: string): PageState {
  return {
    id: pageId,
    title: "",
    blocks: [],
  };
}

/**
 * Create an empty block state.
 */
export function createEmptyBlock(
  id: string,
  afterId: string | null,
  type: BlockType,
  props: BlockProps = {}
): BlockState {
  return {
    id,
    afterId,
    deleted: false,
    type,
    props,
    chars: [],
    formats: [],
  };
}

/**
 * Find a block by ID in the state.
 * Returns undefined if not found.
 */
function findBlock(
  state: PageState,
  blockId: string
): BlockState | undefined {
  return state.blocks.find((b) => b.id === blockId);
}

/**
 * Find block index by ID in the state.
 * Returns -1 if not found.
 */
function findBlockIndex(state: PageState, blockId: string): number {
  return state.blocks.findIndex((b) => b.id === blockId);
}

/**
 * Apply a text insert operation.
 * Inserts characters after the specified character ID.
 */
function applyTextInsert(state: PageState, op: TextInsert): PageState {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    // Block not found - operation targets non-existent block
    // This can happen if block was created in a concurrent op not yet applied
    // Store operation for later or ignore
    return state;
  }

  const block = state.blocks[blockIndex];

  // Skip text operations on blocks that don't have text content
  if (block.type === "image" || block.type === "line") {
    return state;
  }

  // Ensure chars array exists
  if (!block.chars) {
    return state;
  }

  // Create new chars array with insertions
  const newChars = [...block.chars];

  // Insert chars one by one, maintaining order
  let insertAfter = op.afterCharId;

  for (const charData of op.chars) {
    const newChar: Char = {
      id: charData.id,
      char: charData.char,
      deleted: false,
    };

    const insertIndex = findCharInsertIndex(newChars, insertAfter, charData.id);
    newChars.splice(insertIndex, 0, newChar);

    // Next char inserts after this one
    insertAfter = charData.id;
  }

  // Create updated block
  const updatedBlock: BlockState = {
    ...block,
    chars: newChars,
  };

  // Update state with new block
  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a text delete operation.
 * Marks characters as deleted (tombstone).
 */
function applyTextDelete(state: PageState, op: TextDelete): PageState {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  // Skip text operations on blocks that don't have text content
  if (block.type === "image" || block.type === "line") {
    return state;
  }

  // Ensure chars array exists
  if (!block.chars) {
    return state;
  }

  const charIdsToDelete = new Set(op.charIds);

  // Mark chars as deleted
  const newChars = block.chars.map((char) => {
    if (charIdsToDelete.has(char.id)) {
      return { ...char, deleted: true };
    }
    return char;
  });

  const updatedBlock: BlockState = {
    ...block,
    chars: newChars,
  };

  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a format set operation.
 * Adds or updates a format span on the specified characters.
 */
function applyFormatSet(state: PageState, op: FormatSet): PageState {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  // Create a new format span
  const newSpan: FormatSpan = {
    startCharId: op.charIds[0],
    endCharId: op.charIds[op.charIds.length - 1],
    format: op.format,
    value: op.value,
    clock: op.clock,
  };

  // Add to formats (LWW will be resolved when reading)
  const updatedBlock: BlockState = {
    ...block,
    formats: [...block.formats, newSpan],
  };

  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a block insert operation.
 * Inserts a new block after the specified block ID.
 */
function applyBlockInsert(state: PageState, op: BlockInsert): PageState {
  // Check if block already exists
  if (findBlock(state, op.blockId)) {
    // Block already exists - idempotent, skip
    return state;
  }

  // Create the new block
  const newBlock = createEmptyBlock(
    op.blockId,
    op.afterBlockId,
    op.blockType,
    op.initialProps
  );

  // Find insertion position
  const insertIndex = findBlockInsertIndex(
    state.blocks,
    op.afterBlockId,
    op.blockId
  );

  // Insert block
  const newBlocks = [...state.blocks];
  newBlocks.splice(insertIndex, 0, newBlock);

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a block delete operation.
 * Marks the block as deleted (tombstone).
 */
function applyBlockDelete(state: PageState, op: BlockDelete): PageState {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  const updatedBlock: BlockState = {
    ...block,
    deleted: true,
  };

  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a block set operation.
 * Updates a block property using Last-Writer-Wins.
 */
function applyBlockSet(state: PageState, op: BlockSet): PageState {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  // Handle 'type' field specially
  if (op.field === "type") {
    const updatedBlock: BlockState = {
      ...block,
      type: op.value as BlockType,
    };

    const newBlocks = [...state.blocks];
    newBlocks[blockIndex] = updatedBlock;

    return {
      ...state,
      blocks: newBlocks,
    };
  }

  // Handle property fields
  const updatedProps: BlockProps = {
    ...block.props,
    [op.field]: op.value,
  };

  const updatedBlock: BlockState = {
    ...block,
    props: updatedProps,
  };

  const newBlocks = [...state.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return {
    ...state,
    blocks: newBlocks,
  };
}

/**
 * Apply a single operation to the state.
 */
export function applyOp(state: PageState, op: Operation): PageState {
  switch (op.op) {
    case "text_insert":
      return applyTextInsert(state, op);
    case "text_delete":
      return applyTextDelete(state, op);
    case "format_set":
      return applyFormatSet(state, op);
    case "block_insert":
      return applyBlockInsert(state, op);
    case "block_delete":
      return applyBlockDelete(state, op);
    case "block_set":
      return applyBlockSet(state, op);
    default:
      // Unknown operation type
      return state;
  }
}

/**
 * Rebuild state from scratch by applying all operations.
 * Operations are sorted by HLC before applying.
 *
 * @param pageId - Page ID for the new state
 * @param ops - All operations to apply
 * @returns Computed page state
 */
export function rebuildState(pageId: string, ops: Operation[]): PageState {
  // Sort operations by HLC
  const sorted = [...ops].sort((a, b) => compareHLC(a.clock, b.clock));

  // Apply operations in order
  let state = createEmptyPageState(pageId);

  for (const op of sorted) {
    state = applyOp(state, op);
  }

  // Resolve block ordering
  state = {
    ...state,
    blocks: resolveBlockOrder(state.blocks),
  };

  return state;
}

/**
 * Get visible text content from a block (excluding deleted chars).
 */
export function getVisibleText(block: BlockState): string {
  // Image and Line blocks don't have text content
  if (block.type === "image" || block.type === "line") {
    return "";
  }
  // Ensure chars array exists
  if (!block.chars) {
    return "";
  }
  return block.chars
    .filter((c) => !c.deleted)
    .map((c) => c.char)
    .join("");
}

/**
 * Get visible blocks from state (excluding deleted blocks).
 */
export function getVisibleBlocks(state: PageState): BlockState[] {
  return state.blocks.filter((b) => !b.deleted);
}

/**
 * Find character by index in visible characters.
 * Returns the character and its position in the full chars array.
 */
export function findCharByVisibleIndex(
  block: BlockState,
  visibleIndex: number
): { char: Char; fullIndex: number } | null {
  // Image and Line blocks don't have text content
  if (block.type === "image" || block.type === "line" || !block.chars) {
    return null;
  }

  let visibleCount = 0;

  for (let i = 0; i < block.chars.length; i++) {
    const char = block.chars[i];
    if (!char.deleted) {
      if (visibleCount === visibleIndex) {
        return { char, fullIndex: i };
      }
      visibleCount++;
    }
  }

  return null;
}

/**
 * Find the character ID at a given visible text position.
 * Returns null if position is at the beginning.
 */
export function findCharIdAtPosition(
  block: BlockState,
  position: number
): string | null {
  if (position === 0) {
    return null;
  }

  const result = findCharByVisibleIndex(block, position - 1);
  return result?.char.id ?? null;
}

/**
 * Get character IDs for a range of visible text.
 */
export function getCharIdsInRange(
  block: BlockState,
  startIndex: number,
  endIndex: number
): string[] {
  // Image and Line blocks don't have text content
  if (block.type === "image" || block.type === "line" || !block.chars) {
    return [];
  }

  const ids: string[] = [];
  let visibleCount = 0;

  for (const char of block.chars) {
    if (!char.deleted) {
      if (visibleCount >= startIndex && visibleCount < endIndex) {
        ids.push(char.id);
      }
      visibleCount++;
      if (visibleCount >= endIndex) {
        break;
      }
    }
  }

  return ids;
}
