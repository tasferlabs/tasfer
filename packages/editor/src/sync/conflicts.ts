/**
 * Conflict Resolution Helpers
 *
 * Provides deterministic conflict resolution for concurrent operations:
 * - Character ordering for concurrent text inserts
 * - Block ordering for concurrent block inserts
 * - Format merging with Last-Writer-Wins (LWW)
 */

import type {
  Block,
  Char,
  FormatSpan,
  TextFormat,
} from "../serlization/loadPage";
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
export function compareBlocks(a: Block, b: Block): number {
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
  newCharId: string,
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
 * Merge format spans using Last-Writer-Wins (LWW).
 * For overlapping formats of the same type, the one with the latest HLC wins.
 *
 * @param spans - Array of format spans to merge
 * @returns Merged array of format spans
 */
export function mergeFormatSpans(spans: FormatSpan[]): FormatSpan[] {
  if (spans.length === 0) return [];

  // Group spans by format type
  const byFormat = new Map<TextFormat, FormatSpan[]>();

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
    const sorted = [...formatSpans].sort((a, b) =>
      compareHLC(a.clock, b.clock),
    );
    result.push(...sorted);
  }

  return result;
}

/**
 * Resolve block ordering from linked list representation.
 * Handles concurrent inserts and deleted blocks.
 *
 * Orphan blocks — those whose `afterId` references a block not present in
 * the input (typically because a `block_insert` for the parent has yet to
 * arrive) — are emitted at the end in deterministic ID order so that all
 * peers agree on placement even before the missing parent has been
 * received. They migrate into the correct position once the parent block
 * is applied.
 *
 * @param blocks - All blocks (unordered, may include deleted)
 * @returns Ordered array of all blocks (including tombstones)
 */
export function resolveBlockOrder(blocks: Block[]): Block[] {
  if (blocks.length === 0) return [];

  // Build adjacency map: afterId -> blocks that come after it
  const afterMap = new Map<string | null, Block[]>();

  for (const block of blocks) {
    const key = block.afterId || null;
    const existing = afterMap.get(key) || [];
    existing.push(block);
    afterMap.set(key, existing);
  }

  // RGA sibling rule: among blocks sharing the same `afterId`, the one with
  // the HIGHER id (the later/newer insert) lands closer to the anchor. This
  // matches the char-level rule in `insertIntoRuns` (skip-greater-ids), and
  // makes it so that pressing Enter in the middle of a document — which
  // emits a block_insert with `afterBlockId = currentBlock.id` — places the
  // new block immediately after the current one, ahead of any pre-existing
  // sibling that also targets the same anchor.
  //
  // The orphan walk below intentionally keeps ascending order: orphans
  // need deterministic placement but have no anchor-relative semantics.
  for (const [key, blocksAtPosition] of afterMap) {
    blocksAtPosition.sort((a, b) => -compareBlocks(a, b));
    afterMap.set(key, blocksAtPosition);
  }

  // Walk the linked list starting from null (beginning)
  const ordered: Block[] = [];
  const visited = new Set<string>();

  function visit(afterId: string | null) {
    const blocksHere = afterMap.get(afterId) || [];

    for (const block of blocksHere) {
      if (visited.has(block.id)) continue;
      visited.add(block.id);

      ordered.push(block);
      visit(block.id);
    }
  }

  visit(null);

  // Emit orphans (afterId points at a block not in the input) at the end
  // in deterministic ID order so peers don't silently lose them.
  if (visited.size < blocks.length) {
    const orphans = blocks
      .filter((b) => !visited.has(b.id))
      .sort(compareBlocks);
    ordered.push(...orphans);
  }

  return ordered;
}
