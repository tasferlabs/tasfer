/**
 * CharRun Utilities
 *
 * Functions for working with CharRun storage format.
 * CharRuns store consecutive characters from the same peer as a single object,
 * reducing memory usage by ~80-90% compared to individual Char objects.
 *
 * ID computation: Each character's ID = `${peerId}:${startCounter + offset}`
 */

import type { Block, Char, CharRun, TextualBlock } from "@/deserializer/loadPage";
import { isTextualBlock } from "@/deserializer/loadPage";
import { extractPeerId, extractCounter, compareIds } from "./id";

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
  charId: string
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
  visiblePosition: number
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
  charId: string
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
export function* iterateAllChars(
  runs: CharRun[] | undefined
): Generator<{ id: string; char: string; deleted: boolean; runIndex: number; offset: number }> {
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
  runs: CharRun[] | undefined
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
 * Insert characters into runs after a specific character ID.
 * If afterCharId is null, inserts at the beginning.
 *
 * This function handles the CRDT insertion logic:
 * - Finds the correct position based on afterCharId
 * - Creates a new run for the inserted characters
 * - May split an existing run if inserting in the middle
 *
 * @returns New runs array (does not mutate input)
 */
export function insertIntoRuns(
  runs: CharRun[] | undefined,
  afterCharId: string | null,
  newChars: Char[]
): CharRun[] {
  // Handle undefined or empty runs
  if (!runs || !Array.isArray(runs)) {
    runs = [];
  }

  if (newChars.length === 0) return runs;

  // Create a new run from the inserted characters
  const firstChar = newChars[0];
  const newRun: CharRun = {
    peerId: extractPeerId(firstChar.id),
    startCounter: extractCounter(firstChar.id),
    text: newChars.map((c) => c.char).join(""),
  };

  // Handle insertion at beginning
  if (afterCharId === null) {
    return [newRun, ...runs];
  }

  // Find the character to insert after
  const location = findCharInRuns(runs, afterCharId);
  if (!location) {
    // Character not found - append at end
    return [...runs, newRun];
  }

  const { runIndex, offset } = location;
  const targetRun = runs[runIndex];

  // If inserting at the end of a run
  if (offset === targetRun.text.length - 1) {
    const result = [...runs];
    result.splice(runIndex + 1, 0, newRun);
    return result;
  }

  // If inserting in the middle of a run, split it
  const beforeRun: CharRun = {
    peerId: targetRun.peerId,
    startCounter: targetRun.startCounter,
    text: targetRun.text.slice(0, offset + 1),
    deletedMask: targetRun.deletedMask
      ? sliceDeletedMask(targetRun.deletedMask, 0, offset + 1)
      : undefined,
  };

  const afterRun: CharRun = {
    peerId: targetRun.peerId,
    startCounter: targetRun.startCounter + offset + 1,
    text: targetRun.text.slice(offset + 1),
    deletedMask: targetRun.deletedMask
      ? sliceDeletedMask(targetRun.deletedMask, offset + 1, targetRun.text.length)
      : undefined,
  };

  const result = [...runs];
  result.splice(runIndex, 1, beforeRun, newRun, afterRun);
  return result;
}

/**
 * Slice a deleted mask for a portion of a run.
 */
function sliceDeletedMask(
  mask: number[],
  start: number,
  end: number
): number[] | undefined {
  const length = end - start;
  const requiredBytes = Math.ceil(length / 8);
  const result: number[] = new Array(requiredBytes).fill(0);

  let hasAnyDeleted = false;
  for (let i = 0; i < length; i++) {
    const srcByteIndex = Math.floor((start + i) / 8);
    const srcBitIndex = (start + i) % 8;
    const isDeleted = srcByteIndex < mask.length && (mask[srcByteIndex] & (1 << srcBitIndex)) !== 0;

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
  charIds: string[]
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
 * Get all character IDs in a range (inclusive, for visible chars only).
 */
export function getCharIdsInRange(
  runs: CharRun[] | undefined,
  startCharId: string,
  endCharId: string
): string[] {
  if (!runs || !Array.isArray(runs)) return [];

  const result: string[] = [];
  let inRange = false;

  for (const { id, deleted } of iterateAllChars(runs)) {
    if (id === startCharId) {
      inRange = true;
    }

    if (inRange && !deleted) {
      result.push(id);
    }

    if (id === endCharId) {
      break;
    }
  }

  return result;
}

/**
 * Check if a character ID is within a range (inclusive).
 */
export function isCharIdInRange(
  runs: CharRun[] | undefined,
  charId: string,
  startCharId: string,
  endCharId: string
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
// CRDT Ordering Helpers
// =============================================================================

/**
 * Find the correct insertion index for a new character after afterCharId.
 * Handles concurrent insertions by comparing IDs for deterministic ordering.
 *
 * This is the core CRDT logic for character ordering:
 * - Characters inserted after the same afterCharId are ordered by their ID
 * - This ensures all peers converge to the same order
 *
 * @returns The run index and offset where the new character should be inserted
 */
export function findInsertPosition(
  runs: CharRun[] | undefined,
  afterCharId: string | null,
  newCharId: string
): { runIndex: number; offset: number } {
  if (!runs || !Array.isArray(runs)) {
    return { runIndex: 0, offset: 0 };
  }

  // If afterCharId is null, find position at start based on ID comparison
  if (afterCharId === null) {
    // Find first char that should come after newCharId
    let insertBeforeRunIndex = 0;
    let insertBeforeOffset = 0;

    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
      const run = runs[runIndex];
      for (let offset = 0; offset < run.text.length; offset++) {
        const existingId = getCharIdFromRun(run, offset);
        // Skip chars that also have null afterCharId and should come before newCharId
        if (compareIds(existingId, newCharId) > 0) {
          return { runIndex: insertBeforeRunIndex, offset: insertBeforeOffset };
        }
        insertBeforeRunIndex = runIndex;
        insertBeforeOffset = offset + 1;
      }
    }

    return { runIndex: insertBeforeRunIndex, offset: insertBeforeOffset };
  }

  // Find afterCharId
  const afterLocation = findCharInRuns(runs, afterCharId);
  if (!afterLocation) {
    // afterCharId not found, append at end
    const lastRun = runs[runs.length - 1];
    return { runIndex: runs.length - 1, offset: lastRun ? lastRun.text.length : 0 };
  }

  // Start searching from right after afterCharId
  let { runIndex, offset } = afterLocation;
  offset++; // Move past afterCharId

  // Handle offset overflow to next run
  while (runIndex < runs.length && offset >= runs[runIndex].text.length) {
    offset = 0;
    runIndex++;
  }

  // Find the correct position among concurrent insertions
  // (chars that also have the same afterCharId)
  while (runIndex < runs.length) {
    const run = runs[runIndex];
    while (offset < run.text.length) {
      const existingId = getCharIdFromRun(run, offset);

      // Check if this char also had the same afterCharId
      // (would need to track this - for now, use ID comparison)
      if (compareIds(existingId, newCharId) > 0) {
        return { runIndex, offset };
      }

      offset++;
    }
    offset = 0;
    runIndex++;
  }

  // Insert at the end
  return {
    runIndex: runs.length > 0 ? runs.length - 1 : 0,
    offset: runs.length > 0 ? runs[runs.length - 1].text.length : 0,
  };
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
  maxLength: number = MAX_TITLE_LENGTH
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
