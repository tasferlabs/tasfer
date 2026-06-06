/**
 * CharRun Utilities
 *
 * Functions for working with CharRun storage format.
 * CharRuns store consecutive characters from the same peer as a single object,
 * reducing memory usage by ~80-90% compared to individual Char objects.
 *
 * ID computation: Each character's ID = `${peerId}:${startCounter + offset}`
 */

import type {
  Block,
  Char,
  CharRun,
  TextualBlock,
} from "../serlization/loadPage";
import { isTextualBlock } from "../serlization/loadPage";
import { compareIds, extractCounter, extractPeerId } from "./id";

// =============================================================================
// ID and Deletion Helpers
// =============================================================================

/**
 * Compute a character's ID from its run and offset.
 */
export function getCharIdFromRun(run: CharRun, offset: number): string {
  return `${run.peerId}:${run.startCounter + offset}`;
}

/**
 * Check if a character at a given offset in a run is deleted.
 */
export function isCharDeleted(run: CharRun, offset: number): boolean {
  if (!run.deletedMask) return false;
  const byteIndex = Math.floor(offset / 8);
  const bitIndex = offset % 8;
  if (byteIndex >= run.deletedMask.length) return false;
  return (run.deletedMask[byteIndex] & (1 << bitIndex)) !== 0;
}

/**
 * Check if all characters in a run are deleted.
 */
export function isRunFullyDeleted(run: CharRun): boolean {
  if (!run.deletedMask) return false;
  for (let i = 0; i < run.text.length; i++) {
    if (!isCharDeleted(run, i)) return false;
  }
  return true;
}

// =============================================================================
// Finding Characters
// =============================================================================

export interface CharLocation {
  runIndex: number;
  offset: number;
  char: string;
  deleted: boolean;
}

/**
 * Find a character by its ID in a list of runs.
 * Returns the run index, offset within run, character, and deletion status.
 */
export function findCharInRuns(
  runs: CharRun[] | undefined,
  charId: string,
): CharLocation | null {
  if (!runs || !Array.isArray(runs)) return null;

  const targetPeerId = extractPeerId(charId);
  const targetCounter = extractCounter(charId);

  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex];
    if (run.peerId !== targetPeerId) continue;

    const runEndCounter = run.startCounter + run.text.length - 1;
    if (targetCounter >= run.startCounter && targetCounter <= runEndCounter) {
      const offset = targetCounter - run.startCounter;
      return {
        runIndex,
        offset,
        char: run.text[offset],
        deleted: isCharDeleted(run, offset),
      };
    }
  }

  return null;
}

/**
 * Get the character ID at a visible position (ignoring deleted chars).
 * Returns null if position is out of bounds, or the ID of the char before if position is 0.
 */
export function getCharIdAtVisiblePosition(
  runs: CharRun[] | undefined,
  visiblePosition: number,
): string | null {
  if (!runs || visiblePosition <= 0) return null;

  let visibleCount = 0;
  for (const run of runs) {
    for (let offset = 0; offset < run.text.length; offset++) {
      if (!isCharDeleted(run, offset)) {
        visibleCount++;
        if (visibleCount === visiblePosition) {
          return getCharIdFromRun(run, offset);
        }
      }
    }
  }

  return null;
}

/**
 * Get the visible position of a character by its ID.
 * Returns -1 if not found or if the character is deleted.
 */
export function getVisiblePositionOfChar(
  runs: CharRun[] | undefined,
  charId: string,
): number {
  if (!runs || !Array.isArray(runs)) return -1;

  const targetPeerId = extractPeerId(charId);
  const targetCounter = extractCounter(charId);

  let visiblePosition = 0;
  for (const run of runs) {
    for (let offset = 0; offset < run.text.length; offset++) {
      const isTarget =
        run.peerId === targetPeerId &&
        run.startCounter + offset === targetCounter;

      if (isTarget) {
        return isCharDeleted(run, offset) ? -1 : visiblePosition;
      }

      if (!isCharDeleted(run, offset)) {
        visiblePosition++;
      }
    }
  }

  return -1;
}

// =============================================================================
// Text Extraction
// =============================================================================

/**
 * Get the visible (non-deleted) text from runs.
 */
export function getVisibleTextFromRuns(runs: CharRun[] | undefined): string {
  if (!runs) return "";
  let result = "";
  for (const run of runs) {
    for (let offset = 0; offset < run.text.length; offset++) {
      if (!isCharDeleted(run, offset)) {
        result += run.text[offset];
      }
    }
  }
  return result;
}

/**
 * Get the visible character count from runs.
 */
export function getVisibleLengthFromRuns(runs: CharRun[] | undefined): number {
  if (!runs) return 0;
  let count = 0;
  for (const run of runs) {
    for (let offset = 0; offset < run.text.length; offset++) {
      if (!isCharDeleted(run, offset)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Iterate over all characters (including deleted) with their metadata.
 */
export function* iterateAllChars(runs: CharRun[] | undefined): Generator<{
  id: string;
  char: string;
  deleted: boolean;
  runIndex: number;
  offset: number;
}> {
  if (!runs || !Array.isArray(runs)) return;

  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex];
    for (let offset = 0; offset < run.text.length; offset++) {
      yield {
        id: getCharIdFromRun(run, offset),
        char: run.text[offset],
        deleted: isCharDeleted(run, offset),
        runIndex,
        offset,
      };
    }
  }
}

/**
 * Iterate over visible (non-deleted) characters.
 */
export function* iterateVisibleChars(
  runs: CharRun[] | undefined,
): Generator<{ id: string; char: string; runIndex: number; offset: number }> {
  if (!runs) return;
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex];
    for (let offset = 0; offset < run.text.length; offset++) {
      if (!isCharDeleted(run, offset)) {
        yield {
          id: getCharIdFromRun(run, offset),
          char: run.text[offset],
          runIndex,
          offset,
        };
      }
    }
  }
}

// =============================================================================
// Insertion
// =============================================================================

/**
 * Insert characters into runs after a specific character ID (RGA insert).
 * If afterCharId is null, inserts at the beginning.
 *
 * Local-RGA invariant: among concurrent inserts that share the same anchor,
 * the char with the higher ID lands closer to the anchor. We start at the
 * position immediately after afterCharId, then skip forward past any
 * existing chars whose ID is greater than the new run's first ID — the
 * standard RGA "skip-greater-ids" rule. This makes the mergeOps fast path
 * convergent for concurrent same-anchor inserts; reorderings that violate
 * causality (afterCharId references a char from a not-yet-applied op) are
 * still handled by the mergeOps slow-path rebuild.
 *
 * @returns New runs array (does not mutate input)
 */
export function insertIntoRuns(
  runs: CharRun[] | undefined,
  afterCharId: string | null,
  newChars: Char[],
): CharRun[] {
  if (!runs || !Array.isArray(runs)) {
    runs = [];
  }

  if (newChars.length === 0) return runs;

  const firstChar = newChars[0];
  const newRun: CharRun = {
    peerId: extractPeerId(firstChar.id),
    startCounter: extractCounter(firstChar.id),
    text: newChars.map((c) => c.char).join(""),
  };
  const newFirstId = firstChar.id;

  // Locate the position immediately after afterCharId (or at the start).
  let runIdx: number;
  let offset: number;
  if (afterCharId === null) {
    runIdx = 0;
    offset = 0;
  } else {
    const location = findCharInRuns(runs, afterCharId);
    if (!location) {
      return [...runs, newRun];
    }
    runIdx = location.runIndex;
    offset = location.offset + 1;
  }

  // Normalize past the end of a run.
  while (runIdx < runs.length && offset >= runs[runIdx].text.length) {
    runIdx++;
    offset = 0;
  }

  // Skip past existing chars with ID strictly greater than the new run's
  // first ID (RGA: higher IDs at the same anchor are placed first).
  while (runIdx < runs.length) {
    const existingId = getCharIdFromRun(runs[runIdx], offset);
    if (compareIds(existingId, newFirstId) <= 0) break;
    offset++;
    if (offset >= runs[runIdx].text.length) {
      runIdx++;
      offset = 0;
    }
  }

  // Splice at (runIdx, offset).
  if (runIdx >= runs.length) {
    return [...runs, newRun];
  }
  if (offset === 0) {
    const result = [...runs];
    result.splice(runIdx, 0, newRun);
    return result;
  }

  const targetRun = runs[runIdx];
  const beforeRun: CharRun = {
    peerId: targetRun.peerId,
    startCounter: targetRun.startCounter,
    text: targetRun.text.slice(0, offset),
    deletedMask: targetRun.deletedMask
      ? sliceDeletedMask(targetRun.deletedMask, 0, offset)
      : undefined,
  };
  const afterRun: CharRun = {
    peerId: targetRun.peerId,
    startCounter: targetRun.startCounter + offset,
    text: targetRun.text.slice(offset),
    deletedMask: targetRun.deletedMask
      ? sliceDeletedMask(targetRun.deletedMask, offset, targetRun.text.length)
      : undefined,
  };

  const result = [...runs];
  result.splice(runIdx, 1, beforeRun, newRun, afterRun);
  return result;
}

/**
 * Slice a deleted mask for a portion of a run.
 */
function sliceDeletedMask(
  mask: number[],
  start: number,
  end: number,
): number[] | undefined {
  const length = end - start;
  const requiredBytes = Math.ceil(length / 8);
  const result: number[] = new Array(requiredBytes).fill(0);

  let hasAnyDeleted = false;
  for (let i = 0; i < length; i++) {
    const srcByteIndex = Math.floor((start + i) / 8);
    const srcBitIndex = (start + i) % 8;
    const isDeleted =
      srcByteIndex < mask.length &&
      (mask[srcByteIndex] & (1 << srcBitIndex)) !== 0;

    if (isDeleted) {
      hasAnyDeleted = true;
      const dstByteIndex = Math.floor(i / 8);
      const dstBitIndex = i % 8;
      result[dstByteIndex] |= 1 << dstBitIndex;
    }
  }

  return hasAnyDeleted ? result : undefined;
}

// =============================================================================
// Deletion
// =============================================================================

/**
 * Mark characters as deleted in runs.
 * Sets the deletion bits for the specified character IDs.
 *
 * @returns New runs array (does not mutate input)
 */
export function deleteFromRuns(
  runs: CharRun[] | undefined,
  charIds: string[],
): CharRun[] {
  // Handle undefined or empty runs
  if (!runs || !Array.isArray(runs)) {
    runs = [];
  }

  if (charIds.length === 0) return runs;

  // Build a set of IDs to delete for fast lookup
  const toDelete = new Set(charIds);

  // Clone runs and update deletion masks
  return runs.map((run) => {
    let newMask: number[] | undefined = run.deletedMask
      ? [...run.deletedMask]
      : undefined;
    let modified = false;

    for (let offset = 0; offset < run.text.length; offset++) {
      const charId = getCharIdFromRun(run, offset);
      if (toDelete.has(charId) && !isCharDeleted(run, offset)) {
        if (!newMask) {
          newMask = new Array(Math.ceil(run.text.length / 8)).fill(0);
        }
        const byteIndex = Math.floor(offset / 8);
        const bitIndex = offset % 8;
        newMask[byteIndex] |= 1 << bitIndex;
        modified = true;
      }
    }

    if (modified) {
      return { ...run, deletedMask: newMask };
    }
    return run;
  });
}

// =============================================================================
// Run Merging and Optimization
// =============================================================================

/**
 * Check if two runs can be merged (same peer, consecutive counters).
 */
function canMergeRuns(run1: CharRun, run2: CharRun): boolean {
  if (run1.peerId !== run2.peerId) return false;
  const run1EndCounter = run1.startCounter + run1.text.length;
  return run1EndCounter === run2.startCounter;
}

/**
 * Merge two adjacent runs into one.
 */
function mergeTwoRuns(run1: CharRun, run2: CharRun): CharRun {
  const text = run1.text + run2.text;

  // Merge deletion masks
  let deletedMask: number[] | undefined;
  if (run1.deletedMask || run2.deletedMask) {
    const requiredBytes = Math.ceil(text.length / 8);
    deletedMask = new Array(requiredBytes).fill(0);

    // Copy run1's mask
    if (run1.deletedMask) {
      for (let i = 0; i < run1.text.length; i++) {
        if (isCharDeleted(run1, i)) {
          const byteIndex = Math.floor(i / 8);
          const bitIndex = i % 8;
          deletedMask[byteIndex] |= 1 << bitIndex;
        }
      }
    }

    // Copy run2's mask (offset by run1.text.length)
    if (run2.deletedMask) {
      for (let i = 0; i < run2.text.length; i++) {
        if (isCharDeleted(run2, i)) {
          const newOffset = run1.text.length + i;
          const byteIndex = Math.floor(newOffset / 8);
          const bitIndex = newOffset % 8;
          deletedMask[byteIndex] |= 1 << bitIndex;
        }
      }
    }

    // Check if mask is all zeros
    let hasAnyDeleted = false;
    for (const byte of deletedMask) {
      if (byte !== 0) {
        hasAnyDeleted = true;
        break;
      }
    }
    if (!hasAnyDeleted) {
      deletedMask = undefined;
    }
  }

  return {
    peerId: run1.peerId,
    startCounter: run1.startCounter,
    text,
    deletedMask,
  };
}

/**
 * Merge adjacent runs from the same peer to optimize storage.
 * This should be called periodically to consolidate fragmented runs.
 *
 * @returns New runs array (does not mutate input)
 */
export function mergeAdjacentRuns(runs: CharRun[] | undefined): CharRun[] {
  if (!runs || !Array.isArray(runs)) return [];
  if (runs.length <= 1) return runs;

  const result: CharRun[] = [];
  let current = runs[0];

  for (let i = 1; i < runs.length; i++) {
    const next = runs[i];
    if (canMergeRuns(current, next)) {
      current = mergeTwoRuns(current, next);
    } else {
      result.push(current);
      current = next;
    }
  }

  result.push(current);
  return result;
}

// =============================================================================
// Character ID Range Helpers (for FormatSpan)
// =============================================================================

/**
 * Get the visible character IDs in a range, addressed by visible index
 * (startIndex inclusive, endIndex exclusive).
 */
export function getCharIdsInRangeFromRuns(
  runs: CharRun[] | undefined,
  startIndex: number,
  endIndex: number,
): string[] {
  if (!runs) return [];

  const ids: string[] = [];
  let visibleCount = 0;

  for (const { id } of iterateVisibleChars(runs)) {
    if (visibleCount >= startIndex && visibleCount < endIndex) {
      ids.push(id);
    }
    visibleCount++;
    if (visibleCount >= endIndex) break;
  }

  return ids;
}

/**
 * Check if a character ID is within a range (inclusive).
 */
export function isCharIdInRange(
  runs: CharRun[] | undefined,
  charId: string,
  startCharId: string,
  endCharId: string,
): boolean {
  if (!runs || !Array.isArray(runs)) return false;

  let foundStart = false;
  let foundTarget = false;

  for (const { id } of iterateAllChars(runs)) {
    if (id === startCharId) {
      foundStart = true;
    }

    if (foundStart && id === charId) {
      foundTarget = true;
    }

    if (id === endCharId) {
      return foundTarget;
    }
  }

  return false;
}

// =============================================================================
// Conversion Utilities
// =============================================================================

/**
 * Convert CharRuns to Char[] array for operation application.
 * Used when applying TextInsert operations to existing state.
 *
 * Each character's ID is computed as `${peerId}:${startCounter + offset}`.
 * Preserves deletion flags from the deletedMask bitmap.
 */
export function charRunsToChars(runs: CharRun[]): Char[] {
  const chars: Char[] = [];

  for (const run of runs) {
    for (let i = 0; i < run.text.length; i++) {
      const id = getCharIdFromRun(run, i);
      const deleted = isCharDeleted(run, i);

      chars.push({
        id,
        char: run.text[i],
        ...(deleted ? { deleted: true } : {}),
      });
    }
  }

  return chars;
}

// =============================================================================
// Title Extraction
// =============================================================================

const MAX_TITLE_LENGTH = 100;

/**
 * Extract a title from blocks by finding the first non-empty text block.
 * Prefers headings over paragraphs/lists.
 * Returns empty string if no suitable title is found.
 *
 * @param blocks - Array of blocks to search
 * @param maxLength - Maximum title length (default: 100)
 */
export function extractTitleFromBlocks(
  blocks: Block[] | undefined,
  maxLength: number = MAX_TITLE_LENGTH,
): string {
  if (!blocks || blocks.length === 0) return "";

  // First pass: look for first non-empty heading
  for (const block of blocks) {
    if (block.deleted) continue;
    if (
      block.type === "heading1" ||
      block.type === "heading2" ||
      block.type === "heading3"
    ) {
      const text = getVisibleTextFromRuns((block as TextualBlock).charRuns);
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        return truncateTitle(trimmed, maxLength);
      }
    }
  }

  // Second pass: look for first non-empty text block (paragraph or list)
  for (const block of blocks) {
    if (block.deleted) continue;
    if (isTextualBlock(block)) {
      const text = getVisibleTextFromRuns((block as TextualBlock).charRuns);
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        return truncateTitle(trimmed, maxLength);
      }
    }
  }

  return "";
}

/**
 * Truncate title to max length, breaking at word boundary if possible.
 */
function truncateTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) return title;

  // Try to break at a word boundary
  const truncated = title.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLength * 0.6) {
    // Only break at space if it's not too far back
    return truncated.slice(0, lastSpace);
  }

  return truncated;
}

/**
 * Get visible text from Char[] array (filters out deleted chars)
 */
export function getVisibleTextFromChars(chars: Char[]): string {
  return getVisibleTextFromRuns(charsToRuns(chars));
}

/**
 * Convert Char[] to CharRun[] for storage
 */
export function charsToRuns(chars: Char[]): CharRun[] {
  if (chars.length === 0) return [];
  const runs: CharRun[] = [];
  let currentPeerId = extractPeerId(chars[0].id);
  let currentStartCounter = extractCounter(chars[0].id);
  let currentText = "";
  let currentDeletedMask: number[] | undefined = undefined;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const peerId = extractPeerId(char.id);
    const counter = extractCounter(char.id);
    const expectedCounter = currentStartCounter + currentText.length;

    // Check if this char continues the current run
    if (peerId === currentPeerId && counter === expectedCounter) {
      currentText += char.char;
      if (char.deleted) {
        if (!currentDeletedMask) {
          currentDeletedMask = new Array(
            Math.ceil(currentText.length / 8),
          ).fill(0);
        }
        const offset = currentText.length - 1;
        const byteIndex = Math.floor(offset / 8);
        const bitIndex = offset % 8;
        if (byteIndex >= currentDeletedMask.length) {
          // Expand mask if needed
          const newMask = new Array(Math.ceil(currentText.length / 8)).fill(0);
          for (let j = 0; j < currentDeletedMask.length; j++) {
            newMask[j] = currentDeletedMask[j];
          }
          currentDeletedMask = newMask;
        }
        currentDeletedMask[byteIndex] |= 1 << bitIndex;
      }
    } else {
      // Save current run if non-empty
      if (currentText.length > 0) {
        runs.push({
          peerId: currentPeerId,
          startCounter: currentStartCounter,
          text: currentText,
          deletedMask: currentDeletedMask,
        });
      }
      // Start new run
      currentPeerId = peerId;
      currentStartCounter = counter;
      currentText = char.char;
      if (char.deleted) {
        currentDeletedMask = [1];
      } else {
        currentDeletedMask = undefined;
      }
    }
  }

  // Save final run
  if (currentText.length > 0) {
    runs.push({
      peerId: currentPeerId,
      startCounter: currentStartCounter,
      text: currentText,
      deletedMask: currentDeletedMask,
    });
  }

  return runs;
}
