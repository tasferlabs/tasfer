/**
 * CRDT Reducer
 *
 * Applies operations to state and rebuilds state from operations.
 * This is the core of the CRDT engine - all state changes flow through here.
 */

import {
  isTextualBlock,
  type Block,
  type Char,
  type FormatSpan,
  type Page,
} from "@/deserializer/loadPage";
import { findBlockInsertIndex, resolveBlockOrder } from "./conflicts";
import { compareHLC } from "./hlc";
import {
  deleteFromRuns,
  getVisibleTextFromRuns,
  getCharIdAtVisiblePosition,
  iterateVisibleChars,
} from "./char-runs";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  BlockType,
  FormatSet,
  Operation,
  TextDelete,
  TextInsert,
} from "./types";
import { applyTextInsertOp } from "./crdt-helpers";

/**
 * Create an empty page state.
 */
export function createEmptyPageState(pageId: string): Page {
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
  type: BlockType
): Block {
  const base = {
    id,
    afterId,
    deleted: false,
  };

  switch (type) {
    case "heading1":
    case "heading2":
    case "heading3":
    case "paragraph":
      return {
        ...base,
        type,
        charRuns: [],
        formats: [],
      };
    case "bullet_list":
      return {
        ...base,
        type: "bullet_list",
        charRuns: [],
        formats: [],
        indent: 0,
      };
    case "numbered_list":
      return {
        ...base,
        type: "numbered_list",
        charRuns: [],
        formats: [],
        indent: 0,
      };
    case "todo_list":
      return {
        ...base,
        type: "todo_list",
        charRuns: [],
        formats: [],
        checked: false,
        indent: 0,
      };
    case "image":
      return {
        ...base,
        type: "image",
        url: "",
      };
    case "line":
      return {
        ...base,
        type: "line",
      };
  }
}

/**
 * Find a block by ID in the state.
 * Returns undefined if not found.
 */
function findBlock(state: Page, blockId: string): Block | undefined {
  return state.blocks.find((b) => b.id === blockId);
}

/**
 * Find block index by ID in the state.
 * Returns -1 if not found.
 */
function findBlockIndex(state: Page, blockId: string): number {
  return state.blocks.findIndex((b) => b.id === blockId);
}

/**
 * Apply a text insert operation.
 * Inserts characters after the specified character ID.
 * If chars already exist (as tombstones), un-tombstones them instead of duplicating.
 */
function applyTextInsert(state: Page, op: TextInsert): Page {
  return applyTextInsertOp(state, op);
}

/**
 * Apply a text delete operation.
 * Marks characters as deleted (tombstone).
 */
function applyTextDelete(state: Page, op: TextDelete): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  // Skip operations on deleted blocks or blocks without text content
  if (!block || block.deleted || !isTextualBlock(block)) {
    return state;
  }

  // Delete chars from runs
  const newCharRuns = deleteFromRuns(block.charRuns, op.charIds);

  const updatedBlock: Block = {
    ...block,
    charRuns: newCharRuns,
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
function applyFormatSet(state: Page, op: FormatSet): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  // Skip operations on deleted blocks or blocks without text content
  if (!block || block.deleted || !isTextualBlock(block)) {
    return state;
  }

  // Create a new format span
  const newSpan: FormatSpan = {
    startCharId: op.charIds[0],
    endCharId: op.charIds[op.charIds.length - 1],
    format: op.format,
    clock: op.clock,
  };

  // Check if this exact span already exists (idempotency check)
  // Use clock as unique identifier - same clock means same operation
  const spanExists = block.formats.some(
    (span) =>
      span.clock.counter === op.clock.counter &&
      span.clock.peerId === op.clock.peerId
  );

  if (spanExists) {
    return state;
  }

  // Add to formats (LWW will be resolved when reading)
  const updatedBlock: Block = {
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
 * If block already exists as tombstone, restores it.
 */
function applyBlockInsert(state: Page, op: BlockInsert): Page {
  // Check if block already exists
  const existingBlock = findBlock(state, op.blockId);
  if (existingBlock) {
    // Block exists - if it's tombstoned, restore it; otherwise it's idempotent (no-op)
    if (existingBlock.deleted) {
      // Restore the tombstoned block by marking it as not deleted
      const blockIndex = findBlockIndex(state, op.blockId);
      const restoredBlock = { ...existingBlock, deleted: false };
      const newBlocks = [...state.blocks];
      newBlocks[blockIndex] = restoredBlock;
      return { ...state, blocks: newBlocks };
    }
    // Block already exists and is not deleted - idempotent, do nothing
    return state;
  }

  // Create the new block
  const baseBlock = createEmptyBlock(op.blockId, op.afterBlockId, op.blockType);

  // Apply initial props if provided
  const newBlock = op.initialProps
    ? { ...baseBlock, ...op.initialProps }
    : baseBlock;

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
function applyBlockDelete(state: Page, op: BlockDelete): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];
  if (!block) {
    return state;
  }

  // Note: We don't check block.deleted here because block_delete can be idempotent
  const updatedBlock: Block = {
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
function applyBlockSet(state: Page, op: BlockSet): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];
  if (!block || block.deleted) {
    return state;
  }

  // Handle 'type' field specially - need to rebuild block with proper shape
  if (op.field === "type") {
    const newType = op.value as BlockType;
    const newBlock = createEmptyBlock(block.id, block.afterId ?? null, newType);

    // Preserve charRuns and formats for textual blocks
    const updatedBlock: Block =
      isTextualBlock(block) && isTextualBlock(newBlock)
        ? {
            ...newBlock,
            charRuns: block.charRuns,
            formats: block.formats,
            cachedHeight: block.cachedHeight,
            cachedWidth: block.cachedWidth,
          }
        : newBlock;

    const newBlocks = [...state.blocks];
    newBlocks[blockIndex] = updatedBlock;

    return {
      ...state,
      blocks: newBlocks,
    };
  }

  // Apply the field update
  const updatedBlock: Block = {
    ...block,
    [op.field]: op.value,
  } as Block;

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
export function applyOp(state: Page, op: Operation): Page {
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
export function rebuildState(pageId: string, ops: Operation[]): Page {
  // Sort operations by HLC
  const sorted = [...ops].sort((a, b) => compareHLC(a.clock, b.clock));

  // Track which char IDs have been inserted so far, so we can detect
  // text_delete ops that reference chars not yet inserted (due to HLC
  // ordering not matching causal order when clocks weren't advanced).
  const insertedCharIds = new Set<string>();
  const deferredOps: Operation[] = [];

  // Apply operations in order
  let state = createEmptyPageState(pageId);

  for (const op of sorted) {
    // Track inserted char IDs
    if (op.op === "text_insert") {
      for (const run of op.charRuns) {
        for (let i = 0; i < run.text.length; i++) {
          insertedCharIds.add(`${run.peerId}:${run.startCounter + i}`);
        }
      }
    }

    // Defer text_delete if any referenced chars haven't been inserted yet
    if (op.op === "text_delete" && !op.charIds.every((id) => insertedCharIds.has(id))) {
      deferredOps.push(op);
      continue;
    }

    state = applyOp(state, op);
  }

  // Apply deferred deletes — the chars they reference should now exist
  for (const op of deferredOps) {
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
export function getVisibleText(block: Block): string {
  // Image and Line blocks don't have text content
  if (!isTextualBlock(block)) {
    return "";
  }

  return getVisibleTextFromRuns(block.charRuns);
}

/**
 * Get visible blocks from state (excluding deleted blocks).
 * Each block includes its originalIndex in the full blocks array.
 */
export function getVisibleBlocks(
  state: Page
): (Block & { originalIndex: number })[] {
  return state.blocks
    .map((b, i) => Object.assign(b, { originalIndex: i }))
    .filter((b) => !b.deleted);
}

/**
 * Returns blocks for saving. Tombstones (deleted blocks/chars) are preserved
 * to support offline sync - peers need tombstone info to properly merge.
 * Pruning of old tombstones can be done separately.
 */
export function cleanSnapshotForSave(blocks: Block[]): Block[] {
  return blocks;
}

// Helper functions to find next/previous visible block
export function findNextVisibleBlockIndex(
  blocks: Block[],
  startIndex: number
): number | null {
  for (let i = startIndex + 1; i < blocks.length; i++) {
    if (!blocks[i].deleted) {
      return i;
    }
  }
  return null;
}

export function findPreviousVisibleBlockIndex(
  blocks: Block[],
  startIndex: number
): number | null {
  for (let i = startIndex - 1; i >= 0; i--) {
    if (!blocks[i].deleted) {
      return i;
    }
  }
  return null;
}

/**
 * Find character by index in visible characters.
 * Returns the character info and its location in the runs.
 */
export function findCharByVisibleIndex(
  block: Block,
  visibleIndex: number
): { char: Char; runIndex: number; offset: number } | null {
  // Image and Line blocks don't have text content
  if (!isTextualBlock(block)) {
    return null;
  }

  let visibleCount = 0;

  for (const { id, char, runIndex, offset } of iterateVisibleChars(
    block.charRuns
  )) {
    if (visibleCount === visibleIndex) {
      return {
        char: { id, char },
        runIndex,
        offset,
      };
    }
    visibleCount++;
  }

  return null;
}

/**
 * Find the character ID at a given visible text position.
 * Returns null if position is at the beginning.
 */
export function findCharIdAtPosition(
  block: Block,
  position: number
): string | null {
  if (!isTextualBlock(block)) {
    return null;
  }

  return getCharIdAtVisiblePosition(block.charRuns, position);
}

/**
 * Get character IDs for a range of visible text.
 */
export function getCharIdsInRange(
  block: Block,
  startIndex: number,
  endIndex: number
): string[] {
  // Image and Line blocks don't have text content
  if (!isTextualBlock(block)) {
    return [];
  }

  const ids: string[] = [];
  let visibleCount = 0;

  for (const { id } of iterateVisibleChars(block.charRuns)) {
    if (visibleCount >= startIndex && visibleCount < endIndex) {
      ids.push(id);
    }
    visibleCount++;
    if (visibleCount >= endIndex) {
      break;
    }
  }

  return ids;
}
