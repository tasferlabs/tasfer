import { updateCursor } from "../selection";
import { updateSelection } from "../selection";
import {
  type Block,
  type CharRun,
  type Mark,
  type MarkSpan,
  type Page,
} from "../serlization/loadPage";
import type {
  CRDTbinding,
  CRDTCursorState,
  CRDTPosition,
  CRDTSelectionState,
  EditorState,
  Position,
} from "../state-types";
import type { MarkSet, TextDelete, TextInsert } from "../state-types";
import { isTextualBlock } from "./block-registry";
import {
  findCharInRuns,
  getCharIdAtVisiblePosition,
  getCharIdsInRangeFromRuns,
  getVisibleLengthFromRuns,
  isCharIdInRange,
  iterateVisibleChars,
} from "./char-runs";
import { compareBlocks, extractCounter, extractPeerId } from "./id";
import { applyOp } from "./reducer";

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
export interface InsertCharsResult {
  newPage: Page;
  op: TextInsert;
}

export interface DeleteCharsResult {
  newPage: Page;
  op: TextDelete;
}

export interface FormatCharsResult {
  newPage: Page;
  op: MarkSet;
}
/**
 * Insert text at a position in a block's visible content.
 */

export function insertCharsAtPosition(
  page: Page,
  blockId: string,
  position: number,
  text: string,
  binding: CRDTbinding,
): InsertCharsResult {
  if (text.length === 0) {
    throw new Error("Cannot insert empty text");
  }

  const block = page.blocks.find((b) => b.id === blockId);
  const charRuns = block && isTextualBlock(block) ? block.charRuns : undefined;
  const afterCharId = getCharIdAtVisiblePosition(charRuns, position);

  // Pre-allocate consecutive IDs for the inserted chars so they form a
  // single CharRun. The op id is allocated after the char IDs so its
  // counter never collides with the chars it references.
  const firstId = binding.nextId();
  const peerId = extractPeerId(firstId);
  const startCounter = extractCounter(firstId);
  for (let i = 1; i < text.length; i++) {
    binding.nextId();
  }

  const newCharRun: CharRun = {
    peerId,
    startCounter,
    text,
  };

  const op: TextInsert = {
    op: "text_insert",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId: binding.pageId,
    blockId,
    afterCharId,
    charRuns: [newCharRun],
  };

  return { newPage: applyOp(page, op), op };
}
/**
 * Delete a range of visible characters from a block.
 */

export function deleteCharsInRange(
  page: Page,
  blockId: string,
  startIndex: number,
  endIndex: number,
  binding: CRDTbinding,
): DeleteCharsResult {
  const block = page.blocks.find((b) => b.id === blockId);
  const charRuns = block && isTextualBlock(block) ? block.charRuns : undefined;
  const charIds = getCharIdsInRangeFromRuns(charRuns, startIndex, endIndex);

  const op: TextDelete = {
    op: "text_delete",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId: binding.pageId,
    blockId,
    charIds,
  };

  return { newPage: applyOp(page, op), op };
}
/**
 * Apply (or remove, when `value === false`) a format to a visible range.
 */

export function markCharsInRange(
  page: Page,
  blockId: string,
  startIndex: number,
  endIndex: number,
  format: Mark,
  value: boolean | string,
  binding: CRDTbinding,
): FormatCharsResult {
  const block = page.blocks.find((b) => b.id === blockId);
  const charRuns = block && isTextualBlock(block) ? block.charRuns : undefined;
  const charIds = getCharIdsInRangeFromRuns(charRuns, startIndex, endIndex);

  const op: MarkSet = {
    op: "mark_set",
    id: binding.nextId(),
    clock: binding.getClock(),
    pageId: binding.pageId,
    blockId,
    charIds,
    format,
    value,
  };

  return { newPage: applyOp(page, op), op };
}

export function getVisibleLength(charRuns: CharRun[]): number {
  return getVisibleLengthFromRuns(charRuns);
}
function isCharIdInSpan(
  charId: string,
  span: MarkSpan,
  charRuns: CharRun[] | undefined,
): boolean {
  if (!charRuns) return false;
  return isCharIdInRange(charRuns, charId, span.startCharId, span.endCharId);
}
/**
 * Check if all characters in a range have a specific format
 */

export function allCharsHaveFormat(
  charRuns: CharRun[] | undefined,
  formats: MarkSpan[],
  startIndex: number,
  endIndex: number,
  formatType: Mark["type"],
): boolean {
  if (!charRuns) return false;

  const charIds = getCharIdsInRangeFromRuns(charRuns, startIndex, endIndex);
  if (charIds.length === 0) return false;

  return charIds.every((charId) =>
    formats.some(
      (span) =>
        span.format.type === formatType &&
        isCharIdInSpan(charId, span, charRuns),
    ),
  );
}
/**
 * Get formats at a specific position (for cursor)
 */

export function getFormatsAtCharPosition(
  charRuns: CharRun[],
  formats: MarkSpan[],
  position: number,
): Mark[] {
  if (position === 0) return [];

  const charId = getCharIdAtVisiblePosition(charRuns, position);
  if (!charId) return [];

  const activeMarks: Mark[] = [];
  for (const span of formats) {
    if (isCharIdInSpan(charId, span, charRuns)) {
      activeMarks.push(span.format);
    }
  }

  return activeMarks;
}
