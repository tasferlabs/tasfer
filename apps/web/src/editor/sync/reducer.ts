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
import { resolveBlockOrder } from "./conflicts";
import { compareHLC } from "./hlc";
import {
  deleteFromRuns,
  getVisibleTextFromRuns,
  getCharIdAtVisiblePosition,
  isCharIdInRange,
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
import {
  canMorphTo,
  createDefaultBlock,
  validateBlockField,
} from "./block-registry";

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

export function createEmptyBlock(
  id: string,
  afterId: string | null,
  type: BlockType
): Block {
  return createDefaultBlock(type, id, afterId);
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
 *
 * When op.value === false, splits any same-type spans that overlap the
 * affected range so that only the parts outside the selection remain.
 *
 * When op.value !== false, drops any same-type spans overlapping the new
 * range and appends a fresh span for it.
 *
 * The local-emit path in crdt-helpers::formatCharsInRange uses the same
 * algorithm — they must stay in sync, otherwise the locally-rendered state
 * diverges from what remote peers compute from the same op.
 */
function applyFormatSet(state: Page, op: FormatSet): Page {
  const blockIndex = findBlockIndex(state, op.blockId);

  if (blockIndex === -1) {
    return state;
  }

  const block = state.blocks[blockIndex];

  if (!block || block.deleted || !isTextualBlock(block)) {
    return state;
  }

  if (op.charIds.length === 0) {
    return state;
  }

  let newFormats: FormatSpan[];

  if (op.value === false) {
    newFormats = [];
    const selectionSet = new Set(op.charIds);

    for (const span of block.formats) {
      if (span.format.type !== op.format.type) {
        newFormats.push(span);
        continue;
      }

      const overlaps = op.charIds.some((charId) =>
        isCharIdInRange(block.charRuns, charId, span.startCharId, span.endCharId)
      );
      if (!overlaps) {
        newFormats.push(span);
        continue;
      }

      const spanCharIds: string[] = [];
      let inSpan = false;
      for (const { id } of iterateVisibleChars(block.charRuns)) {
        if (id === span.startCharId) inSpan = true;
        if (inSpan) spanCharIds.push(id);
        if (id === span.endCharId) break;
      }

      let runStart: string | null = null;
      let runEnd: string | null = null;
      for (const charId of spanCharIds) {
        if (!selectionSet.has(charId)) {
          if (runStart === null) runStart = charId;
          runEnd = charId;
        } else if (runStart !== null && runEnd !== null) {
          newFormats.push({
            startCharId: runStart,
            endCharId: runEnd,
            format: span.format,
            clock: span.clock,
          });
          runStart = null;
          runEnd = null;
        }
      }
      if (runStart !== null && runEnd !== null) {
        newFormats.push({
          startCharId: runStart,
          endCharId: runEnd,
          format: span.format,
          clock: span.clock,
        });
      }
    }
  } else {
    const alreadyApplied = block.formats.some(
      (span) =>
        span.clock.counter === op.clock.counter &&
        span.clock.peerId === op.clock.peerId
    );
    if (alreadyApplied) {
      return state;
    }

    const filtered = block.formats.filter((span) => {
      if (span.format.type !== op.format.type) return true;
      const overlaps = op.charIds.some((charId) =>
        isCharIdInRange(block.charRuns, charId, span.startCharId, span.endCharId)
      );
      return !overlaps;
    });

    const newSpan: FormatSpan = {
      startCharId: op.charIds[0],
      endCharId: op.charIds[op.charIds.length - 1],
      format: op.format,
      clock: op.clock,
    };
    newFormats = [...filtered, newSpan];
  }

  const updatedBlock: Block = {
    ...block,
    formats: newFormats,
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
 *
 * The new block is appended to the array and the full order is recomputed
 * via `resolveBlockOrder`. The previous splice-based approach used a
 * shallow scan that disagreed with `resolveBlockOrder` whenever a new
 * sibling was inserted alongside an existing block that already had
 * descendants — the splice would land mid-subtree while the tree walk
 * places siblings after their predecessor's full subtree. Routing every
 * insert through the same canonical order ensures local-emit and remote
 * apply (and rebuild) all converge on the same block array.
 */
function applyBlockInsert(state: Page, op: BlockInsert): Page {
  const existingBlock = findBlock(state, op.blockId);
  if (existingBlock) {
    if (existingBlock.deleted) {
      const blockIndex = findBlockIndex(state, op.blockId);
      const restoredBlock = { ...existingBlock, deleted: false };
      const newBlocks = [...state.blocks];
      newBlocks[blockIndex] = restoredBlock;
      return { ...state, blocks: newBlocks };
    }
    return state;
  }

  const baseBlock = createEmptyBlock(op.blockId, op.afterBlockId, op.blockType);
  const newBlock = op.initialProps
    ? { ...baseBlock, ...op.initialProps }
    : baseBlock;

  const newBlocks = resolveBlockOrder([...state.blocks, newBlock]);

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

  if (!validateBlockField(block.type, op.field, op.value)) {
    return state;
  }

  if (op.field === "type") {
    const newType = op.value as BlockType;
    const newBlock = createEmptyBlock(block.id, block.afterId ?? null, newType);

    const updatedBlock: Block =
      canMorphTo(block.type, newType) &&
      isTextualBlock(block) &&
      isTextualBlock(newBlock)
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
 * Apply a batch of operations sequentially.
 */
export function applyOps(state: Page, ops: Operation[]): Page {
  let result = state;
  for (const op of ops) {
    result = applyOp(result, op);
  }
  return result;
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
