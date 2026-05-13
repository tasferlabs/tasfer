/**
 * CRDT Helper Functions
 *
 * These helpers return BOTH the new data AND the CRDT operation atomically.
 * Also includes functions to apply remote CRDT operations to editor Page blocks.
 */

import type { Char, CharRun, FormatSpan, Page, TextFormat } from "../../deserializer/loadPage";
import { isTextualBlock } from "../../deserializer/loadPage";
import type {
  FormatSet,
  TextDelete,
  TextInsert
} from "../sync/types";
import { getPageId, nextId, getClock } from "./sync";
import { extractPeerId, extractCounter } from "./id";
import {
  insertIntoRuns,
  deleteFromRuns,
  getVisibleTextFromRuns,
  getVisibleLengthFromRuns,
  getCharIdAtVisiblePosition,
  iterateVisibleChars,
  isCharIdInRange,
  charRunsToChars,
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
  if (text.length === 0) {
    // No text to insert - return unchanged
    throw new Error("Cannot insert empty text");
  }

  const afterCharId = getCharIdAtVisiblePosition(charRuns, position);

  // Generate consecutive IDs for the text
  const firstId = nextId();
  const peerId = extractPeerId(firstId);
  const startCounter = extractCounter(firstId);

  // Pre-allocate remaining IDs to maintain sequence
  // This ensures IDs are consecutive: peerId:N, peerId:N+1, peerId:N+2, ...
  for (let i = 1; i < text.length; i++) {
    nextId(); // Consume ID to maintain counter sequence
  }

  // Create CharRun directly for the operation
  const newCharRun: CharRun = {
    peerId,
    startCounter,
    text,
    // deletedMask omitted (no deletions on new text)
  };

  // Create Char[] for insertion into existing runs
  // This is needed to work with insertIntoRuns()
  const newCharObjects: Char[] = Array.from(text).map((char, i) => ({
    id: `${peerId}:${startCounter + i}`,
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
    charRuns: [newCharRun], // NEW: Use CharRun instead of Char[]
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
    // Remove format: split spans that overlap with our range
    // Instead of removing entire spans, preserve parts outside the selection
    newFormats = [];
    const selectionCharIdSet = new Set(charIds);

    for (const span of formats) {
      if (span.format.type !== format.type) {
        // Different format type, keep as-is
        newFormats.push(span);
        continue;
      }

      // Check if this span overlaps with any of our charIds
      const overlaps = charIds.some(charId => isCharIdInSpan(charId, span, charRuns));
      if (!overlaps) {
        // No overlap, keep span as-is
        newFormats.push(span);
        continue;
      }

      // Span overlaps with selection - need to split it
      // Find chars in the span that are NOT in the selection
      const spanChars: string[] = [];
      let inSpan = false;
      for (const { id } of iterateVisibleChars(charRuns)) {
        if (id === span.startCharId) inSpan = true;
        if (inSpan) spanChars.push(id);
        if (id === span.endCharId) break;
      }

      // Build new spans for parts outside selection
      let currentSpanStart: string | null = null;
      let currentSpanEnd: string | null = null;

      for (const charId of spanChars) {
        if (!selectionCharIdSet.has(charId)) {
          // This char is in the span but NOT in selection - keep it formatted
          if (currentSpanStart === null) {
            currentSpanStart = charId;
          }
          currentSpanEnd = charId;
        } else {
          // This char IS in selection - close any open span
          if (currentSpanStart !== null && currentSpanEnd !== null) {
            newFormats.push({
              startCharId: currentSpanStart,
              endCharId: currentSpanEnd,
              format: span.format,
              clock: span.clock,
            });
            currentSpanStart = null;
            currentSpanEnd = null;
          }
        }
      }

      // Close final span if any
      if (currentSpanStart !== null && currentSpanEnd !== null) {
        newFormats.push({
          startCharId: currentSpanStart,
          endCharId: currentSpanEnd,
          format: span.format,
          clock: span.clock,
        });
      }
    }
  } else {
    // Add format: create a new span
    const newSpan: FormatSpan = {
      startCharId: charIds[0],
      endCharId: charIds[charIds.length - 1],
      format,
      clock: getClock(),
    };
    // Filter out existing spans of same format type that overlap with new range
    // This prevents format span accumulation
    const filteredFormats = formats.filter(span => {
      if (span.format.type !== format.type) return true;
      const overlaps = charIds.some(charId => isCharIdInSpan(charId, span, charRuns));
      return !overlaps;
    });
    newFormats = [...filteredFormats, newSpan];
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
 * Apply a text insert operation to a page.
 * Shared logic used by both local and remote text insert handlers.
 * Inserts characters after the specified character ID.
 * If chars already exist (as tombstones), un-tombstones them instead of duplicating.
 */
export function applyTextInsertOp(page: Page, op: TextInsert): Page {
  const blockIndex = page.blocks.findIndex((b) => b.id === op.blockId);

  if (blockIndex === -1) {
    // Block not found - this can happen if block insert is received later
    return page;
  }

  const block = page.blocks[blockIndex];

  // Skip operations on deleted blocks or blocks without text content
  if (!block || block.deleted || !isTextualBlock(block)) {
    return page;
  }

  // Convert CharRuns to Char[] for insertion
  const chars = charRunsToChars(op.charRuns);

  // Check if any chars already exist (as tombstones) - if so, un-tombstone them
  // This handles undo operations that restore deleted characters
  const existingCharIds = new Set<string>();
  for (const run of block.charRuns || []) {
    for (let i = 0; i < run.text.length; i++) {
      const charId = `${run.peerId}:${run.startCounter + i}`;
      existingCharIds.add(charId);
    }
  }

  const charsToRestore = chars.filter((c) => existingCharIds.has(c.id));
  const charsToInsert = chars.filter((c) => !existingCharIds.has(c.id));

  let newCharRuns = block.charRuns || [];

  // Un-tombstone existing chars (restore them)
  if (charsToRestore.length > 0) {
    const charIdsToRestore = new Set(charsToRestore.map((c) => c.id));
    newCharRuns = newCharRuns.map((run) => {
      let modified = false;
      let newMask = run.deletedMask ? [...run.deletedMask] : undefined;

      for (let i = 0; i < run.text.length; i++) {
        const charId = `${run.peerId}:${run.startCounter + i}`;
        if (charIdsToRestore.has(charId) && newMask) {
          const byteIndex = Math.floor(i / 8);
          const bitIndex = i % 8;
          if (byteIndex < newMask.length && (newMask[byteIndex] & (1 << bitIndex)) !== 0) {
            newMask[byteIndex] &= ~(1 << bitIndex);
            modified = true;
          }
        }
      }

      if (modified) {
        // Check if mask is all zeros now
        const hasAnyDeleted = newMask?.some((byte) => byte !== 0);
        return { ...run, deletedMask: hasAnyDeleted ? newMask : undefined };
      }
      return run;
    });
  }

  // Insert truly new chars
  if (charsToInsert.length > 0) {
    newCharRuns = insertIntoRuns(newCharRuns, op.afterCharId, charsToInsert);
  }

  const updatedBlock = { ...block, charRuns: newCharRuns };
  const newBlocks = [...page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...page, blocks: newBlocks };
}

