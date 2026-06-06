import { updateCursor } from "../selection";
import { type Block, isTextualBlock, type Page } from "../serlization/loadPage";
import type {
  CRDTCursorState,
  CRDTPosition,
  CRDTSelectionState,
  EditorState,
  Position,
} from "../state-types";
import { updateSelection } from "../updateSelection";
import { findCharInRuns, iterateVisibleChars } from "./char-runs";
import { compareBlocks } from "./id";

/**
 * Convert a Position (index-based) to a CRDTPosition (ID-based).
 * Returns null if the position cannot be converted (e.g., block doesn't exist).
 */

export function positionToCRDT(
  page: Page,
  position: Position,
): CRDTPosition | null {
  const block = page.blocks[position.blockIndex];
  if (!block || block.deleted) return null;

  // For non-textual blocks (images, lines), cursor is always at position 0
  if (!isTextualBlock(block)) {
    return {
      blockId: block.id,
      afterCharId: null,
    };
  }

  // Find the character ID at the given text index
  const visibleChars: Array<{ id: string }> = [];
  for (const { id } of iterateVisibleChars(block.charRuns)) {
    visibleChars.push({ id });
  }

  if (position.textIndex === 0) {
    return {
      blockId: block.id,
      afterCharId: null,
    };
  }

  // textIndex is 1-based for "after" position, so textIndex N means after the Nth visible char
  const charIndex = position.textIndex - 1;
  if (charIndex >= 0 && charIndex < visibleChars.length) {
    return {
      blockId: block.id,
      afterCharId: visibleChars[charIndex].id,
    };
  }

  // If textIndex is beyond the end, use the last character
  if (visibleChars.length > 0) {
    return {
      blockId: block.id,
      afterCharId: visibleChars[visibleChars.length - 1].id,
    };
  }

  return {
    blockId: block.id,
    afterCharId: null,
  };
}
/**
 * Convert a CRDTPosition (ID-based) to a Position (index-based).
 * Returns null if the position cannot be converted (e.g., block was deleted).
 */

export function crdtToPosition(
  page: Page,
  crdtPos: CRDTPosition,
): Position | null {
  // Find block by ID
  const blockIndex = page.blocks.findIndex(
    (b) => b.id === crdtPos.blockId && !b.deleted,
  );
  if (blockIndex === -1) return null;

  const block = page.blocks[blockIndex];
  if (!block || block.deleted) return null;

  // For non-textual blocks, always return position 0
  if (!isTextualBlock(block)) {
    return {
      blockIndex: blockIndex,
      textIndex: 0,
    };
  }

  // If no afterCharId, cursor is at position 0
  if (crdtPos.afterCharId === null) {
    return {
      blockIndex: blockIndex,
      textIndex: 0,
    };
  }

  // Find the visible index of the character
  const visibleChars: Array<{ id: string }> = [];
  let charVisibleIndex = -1;
  let visibleIndex = 0;
  for (const { id } of iterateVisibleChars(block.charRuns)) {
    visibleChars.push({ id });
    if (id === crdtPos.afterCharId) {
      charVisibleIndex = visibleIndex;
    }
    visibleIndex++;
  }

  if (charVisibleIndex !== -1) {
    // textIndex is the position after the character, so add 1
    return {
      blockIndex: blockIndex,
      textIndex: charVisibleIndex + 1,
    };
  }

  // Character was deleted - find the best fallback position
  // Look for the character in all chars (including deleted) to find its neighbors
  const charResult = findCharInRuns(block.charRuns, crdtPos.afterCharId);

  if (charResult) {
    // Find the nearest visible character before this position
    // We need to count visible chars before this one
    let visibleCountBefore = 0;
    for (const { id } of iterateVisibleChars(block.charRuns)) {
      if (id === crdtPos.afterCharId) {
        break;
      }
      visibleCountBefore++;
    }
    return {
      blockIndex: blockIndex,
      textIndex: visibleCountBefore,
    };
  }

  // Character ID not found at all, default to end of block
  return {
    blockIndex: blockIndex,
    textIndex: visibleChars.length,
  };
}
/**
 * Convert a selection range (index-based) to CRDT positions (ID-based).
 * Returns null if either position cannot be converted.
 */

export function selectionRangeToCRDT(
  page: Page,
  range: { start: Position; end: Position },
): { start: CRDTPosition; end: CRDTPosition } | null {
  const startCRDT = positionToCRDT(page, range.start);
  const endCRDT = positionToCRDT(page, range.end);
  if (!startCRDT || !endCRDT) return null;
  return { start: startCRDT, end: endCRDT };
}
/**
 * Convert CRDT selection range (ID-based) to index-based positions.
 * Returns null if either position cannot be converted.
 */

export function crdtToSelectionRange(
  page: Page,
  crdtRange: { start: CRDTPosition; end: CRDTPosition },
): { start: Position; end: Position } | null {
  const start = crdtToPosition(page, crdtRange.start);
  const end = crdtToPosition(page, crdtRange.end);
  if (!start || !end) return null;
  return { start, end };
}
/**
 * Capture current cursor state as CRDT-compatible state.
 */
export function captureCRDTCursor(state: EditorState): CRDTCursorState | null {
  const cursor = state.document.cursor;
  if (!cursor) return null;

  const crdtPos = positionToCRDT(state.document.page, cursor.position);
  if (!crdtPos) return null;

  return { position: crdtPos };
}
/**
 * Capture current selection state as CRDT-compatible state.
 */
export function captureCRDTSelection(
  state: EditorState,
): CRDTSelectionState | null {
  const selection = state.document.selection;
  if (!selection) return null;

  const anchorCRDT = positionToCRDT(state.document.page, selection.anchor);
  const focusCRDT = positionToCRDT(state.document.page, selection.focus);

  if (!anchorCRDT || !focusCRDT) return null;

  return {
    anchor: anchorCRDT,
    focus: focusCRDT,
  };
}
/**
 * Restore cursor from CRDT state.
 */
export function restoreCursor(
  state: EditorState,
  crdtCursor: CRDTCursorState | null,
): EditorState {
  if (!crdtCursor) {
    return updateCursor(state, null);
  }

  const position = crdtToPosition(state.document.page, crdtCursor.position);
  return updateCursor(state, position);
}
/**
 * Restore selection from CRDT state.
 */
export function restoreSelection(
  state: EditorState,
  crdtSelection: CRDTSelectionState | null,
): EditorState {
  if (!crdtSelection) {
    return updateSelection(state, null);
  }

  const anchor = crdtToPosition(state.document.page, crdtSelection.anchor);
  const focus = crdtToPosition(state.document.page, crdtSelection.focus);

  if (!anchor || !focus) {
    return updateSelection(state, null);
  }

  return updateSelection(state, { anchor, focus });
} /**
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
