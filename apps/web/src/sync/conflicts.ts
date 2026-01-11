/**
 * Conflict Resolution Helpers
 *
 * Provides deterministic conflict resolution for concurrent operations:
 * - Character ordering for concurrent text inserts
 * - Block ordering for concurrent block inserts
 * - Format merging with Last-Writer-Wins (LWW)
 */

import type { Char, BlockState, FormatSpan } from "./types";
import { compareHLC } from "./hlc";
import { compareIds } from "./id";

/**
 * Compare two characters for ordering.
 * Used to resolve concurrent inserts at the same position.
 * Orders by character ID for deterministic results.
 *
 * @returns negative if a < b, positive if a > b, 0 if equal
 */
export function compareChars(a: Char, b: Char): number {
  return compareIds(a.id, b.id);
}

/**
 * Compare two blocks for ordering.
 * Used to resolve concurrent inserts after the same block.
 * Orders by block ID for deterministic results.
 *
 * @returns negative if a < b, positive if a > b, 0 if equal
 */
export function compareBlocks(a: BlockState, b: BlockState): number {
  return compareIds(a.id, b.id);
}

/**
 * Find insertion index for a new character in sorted char array.
 * Characters with the same afterCharId are sorted by their own ID.
 *
 * @param chars - Existing characters array
 * @param afterCharId - ID of character to insert after (null = beginning)
 * @param newCharId - ID of the new character being inserted
 * @returns Index where the new character should be inserted
 */
export function findCharInsertIndex(
  chars: Char[],
  afterCharId: string | null,
  newCharId: string
): number {
  if (afterCharId === null) {
    // Insert at beginning, but after any other chars also inserted at beginning
    // that have a smaller ID (for deterministic ordering)
    let index = 0;
    while (index < chars.length) {
      // Check if this char was also inserted at beginning
      // We determine this by checking if there's no char before it
      // or if the char before it is at a different "position"
      // For simplicity, we just sort concurrent beginning inserts by ID
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
    // afterCharId not found - this shouldn't happen in normal operation
    // Insert at the end as fallback
    return chars.length;
  }

  // Insert after afterIndex, but respect ordering of concurrent inserts
  let insertIndex = afterIndex + 1;

  // Skip past any characters that were also inserted after afterCharId
  // but have a smaller ID than newCharId
  while (insertIndex < chars.length) {
    const existingChar = chars[insertIndex];
    // If this char was inserted after a different char, stop
    // (We'd need to track this - for now, use ID comparison)
    if (compareIds(existingChar.id, newCharId) >= 0) {
      break;
    }
    insertIndex++;
  }

  return insertIndex;
}

/**
 * Find insertion index for a new block in the linked list.
 * Blocks with the same afterBlockId are sorted by their own ID.
 *
 * @param blocks - All blocks (including deleted)
 * @param afterBlockId - ID of block to insert after (null = beginning)
 * @param newBlockId - ID of the new block being inserted
 * @returns Index where the new block should be inserted
 */
export function findBlockInsertIndex(
  blocks: BlockState[],
  afterBlockId: string | null,
  newBlockId: string
): number {
  if (afterBlockId === null) {
    // Insert at beginning
    let index = 0;
    while (index < blocks.length && blocks[index].afterId === null) {
      if (compareIds(blocks[index].id, newBlockId) >= 0) {
        break;
      }
      index++;
    }
    return index;
  }

  // Find blocks that come after afterBlockId
  const afterIndex = blocks.findIndex((b) => b.id === afterBlockId);

  if (afterIndex === -1) {
    // afterBlockId not found - insert at end as fallback
    return blocks.length;
  }

  // Insert after afterIndex, respecting ordering
  let insertIndex = afterIndex + 1;

  while (insertIndex < blocks.length) {
    const existingBlock = blocks[insertIndex];
    // If this block was inserted after a different block, stop
    if (existingBlock.afterId !== afterBlockId) {
      break;
    }
    // Both inserted after same block - use ID for ordering
    if (compareIds(existingBlock.id, newBlockId) >= 0) {
      break;
    }
    insertIndex++;
  }

  return insertIndex;
}

/**
 * Merge format spans using Last-Writer-Wins (LWW).
 * For overlapping formats of the same type, the one with the latest HLC wins.
 *
 * @param spans - Array of format spans to merge
 * @returns Merged array of format spans
 */
export function mergeFormatSpans(spans: FormatSpan[]): FormatSpan[] {
  if (spans.length === 0) return [];

  // Group spans by format type
  const byFormat = new Map<string, FormatSpan[]>();

  for (const span of spans) {
    const key = span.format;
    const existing = byFormat.get(key) || [];
    existing.push(span);
    byFormat.set(key, existing);
  }

  const result: FormatSpan[] = [];

  // For each format type, keep spans sorted by clock (LWW)
  // Later spans override earlier ones for the same char range
  for (const [, formatSpans] of byFormat) {
    // Sort by clock (oldest first)
    const sorted = [...formatSpans].sort((a, b) => compareHLC(a.clock, b.clock));
    result.push(...sorted);
  }

  return result;
}

/**
 * Get the effective format value for a character.
 * Uses LWW - the format span with the latest clock wins.
 *
 * @param charId - Character ID to check
 * @param spans - All format spans
 * @param formatType - Format type to check
 * @returns The format value (boolean or string) or undefined if not formatted
 */
export function getEffectiveFormat(
  _charId: string,
  spans: FormatSpan[],
  formatType: string
): boolean | string | undefined {
  // Find all spans of this format type that include this character
  const relevantSpans = spans.filter((s) => s.format === formatType);

  if (relevantSpans.length === 0) {
    return undefined;
  }

  // Find the span with the latest clock (LWW)
  let latestSpan: FormatSpan | null = null;

  for (const span of relevantSpans) {
    // Check if charId is in this span's range
    // This requires knowing the char order - simplified check for now
    if (!latestSpan || compareHLC(span.clock, latestSpan.clock) > 0) {
      latestSpan = span;
    }
  }

  return latestSpan?.value;
}

/**
 * Resolve block ordering from linked list representation.
 * Handles concurrent inserts and deleted blocks.
 *
 * @param blocks - All blocks (unordered, may include deleted)
 * @returns Ordered array of non-deleted blocks
 */
export function resolveBlockOrder(blocks: BlockState[]): BlockState[] {
  if (blocks.length === 0) return [];

  // Build adjacency map: afterId -> blocks that come after it
  const afterMap = new Map<string | null, BlockState[]>();

  for (const block of blocks) {
    const key = block.afterId;
    const existing = afterMap.get(key) || [];
    existing.push(block);
    afterMap.set(key, existing);
  }

  // Sort blocks with same afterId by their own ID
  for (const [key, blocksAtPosition] of afterMap) {
    blocksAtPosition.sort(compareBlocks);
    afterMap.set(key, blocksAtPosition);
  }

  // Walk the linked list starting from null (beginning)
  const ordered: BlockState[] = [];
  const visited = new Set<string>();

  function visit(afterId: string | null) {
    const blocksHere = afterMap.get(afterId) || [];

    for (const block of blocksHere) {
      if (visited.has(block.id)) continue;
      visited.add(block.id);

      // Add this block (even if deleted, for now)
      ordered.push(block);

      // Visit blocks that come after this one
      visit(block.id);
    }
  }

  visit(null);

  // Filter out deleted blocks for the final result
  return ordered.filter((b) => !b.deleted);
}
