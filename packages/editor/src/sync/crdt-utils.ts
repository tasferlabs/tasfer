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
import { findBlock } from "./block-lookup";
import { isTextualBlock } from "./block-registry";
import {
  findCharInRuns,
  getCharIdAtVisiblePosition,
  getCharIdsInRangeFromRuns,
  getVisibleLengthFromRuns,
  isCharIdInRange,
  iterateVisibleChars,
} from "./char-runs";
import { generateKeyBetween } from "./fractional-index";
import { extractCounter, extractPeerId } from "./id";
import { applyOp } from "./reducer";
import { sortBlocksByOrder } from "./block-order";
import { invariant } from "@shared/invariant";

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
 * Order blocks by their fractional-index `orderKey`.
 *
 * Document order is a pure function of per-block `orderKey` values, so it
 * converges trivially under concurrency (every peer applies the same
 * `(blockId → orderKey)` map and sorts identically). Tombstones are kept in
 * place — callers filter them when projecting visible blocks.
 *
 * Ties (two blocks minted the same key by concurrent inserts after the same
 * anchor) break by `-compareBlocks`: the HIGHER id (newer insert) sorts first,
 * so pressing Enter in the middle of a document lands the fresh block
 * immediately after the current one, ahead of a pre-existing sibling. This
 * mirrors the char-level rule in `insertIntoRuns` (skip-greater-ids).
 *
 * @param blocks - All blocks (any order, may include deleted)
 * @returns Ordered array of all blocks (including tombstones)
 *
 * Implemented in the DOM-free `./block-order` module (imported above for
 * `orderKeyAfter` and re-exported here for existing consumers) so headless hosts
 * can sort blocks without this module's selection/rendering dependencies.
 */
export { sortBlocksByOrder };

/**
 * Mint an `orderKey` that places a new block immediately after `afterBlockId`
 * (null = head of the document). `blocks` is assumed sorted by `orderKey`
 * (the canonical state invariant); the upper bound is the next block in that
 * order, including tombstones, so the new key always lands in the intended gap.
 */
export function orderKeyAfter(
  blocks: Block[],
  afterBlockId: string | null,
): string {
  const ordered = sortBlocksByOrder(blocks);
  // Treat an empty/absent orderKey as "no bound". `""` is the documented
  // placeholder a freshly-parsed/pasted block carries until the caller assigns
  // a real fractional-index key (see `defineCustomBlockCodec` in schema.ts); if
  // one ever survives into a live mutation, feeding it to `generateKeyBetween`
  // would throw ("invalid order key head:"). Coercing it to null instead mints a
  // valid key relative to the remaining bounds rather than crashing the edit.
  const keyAt = (i: number): string | null => ordered[i].orderKey || null;

  let lower: string | null;
  let from: number; // search for the upper bound strictly after this index
  if (afterBlockId === null) {
    lower = null;
    from = -1;
  } else {
    const index = ordered.findIndex((b) => b.id === afterBlockId);
    if (index === -1) {
      // Anchor not present — append at the end so the block stays placeable.
      const last = ordered.length > 0 ? keyAt(ordered.length - 1) : null;
      return generateKeyBetween(last, null);
    }
    lower = keyAt(index);
    from = index;
  }

  // Upper bound is the first key strictly greater than `lower`. Concurrent
  // inserts can mint duplicate keys (a tie-group resolved by id), so we must
  // skip over equal keys — otherwise we'd ask for a key between two identical
  // bounds. The new block then lands after the whole tie-group, i.e. after the
  // anchor.
  let upper: string | null = null;
  for (let i = from + 1; i < ordered.length; i++) {
    const k = keyAt(i);
    if (k !== null && (lower === null || k > lower)) {
      upper = k;
      break;
    }
  }
  return generateKeyBetween(lower, upper);
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
 *
 * Precondition: `text` is non-empty. An empty insert has no meaningful op to
 * emit (the result type promises one), so "nothing to insert" is the caller's
 * to handle by skipping the call — every caller guards on `text.length` before
 * invoking. The check below is a defensive backstop against a future caller
 * forgetting and silently logging/broadcasting an empty `text_insert` op; it is
 * not a user-reachable error, so it stays an `invariant` (a bug backstop)
 * rather than a recoverable, host-catchable error.
 */

export function insertCharsAtPosition(
  page: Page,
  blockId: string,
  position: number,
  text: string,
  binding: CRDTbinding,
): InsertCharsResult {
  invariant(
    text.length > 0,
    "insertCharsAtPosition: empty text in block %s (caller must guard)",
    blockId,
  );

  const block = findBlock(page, blockId);
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
  const block = findBlock(page, blockId);
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
  value: boolean,
  binding: CRDTbinding,
): FormatCharsResult {
  const block = findBlock(page, blockId);
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
