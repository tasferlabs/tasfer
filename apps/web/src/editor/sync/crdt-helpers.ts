/**
 * CRDT Helper Functions
 *
 * Local-emit helpers that construct an Operation and apply it via the same
 * reducer path remote ops take. This keeps local apply and remote apply
 * algorithmically identical — see `applyOp` in `reducer.ts`.
 */

import type { CharRun, FormatSpan, Page, TextFormat } from "../../deserializer/loadPage";
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
  getVisibleTextFromRuns,
  getVisibleLengthFromRuns,
  getCharIdAtVisiblePosition,
  iterateVisibleChars,
  isCharIdInRange,
  charRunsToChars,
} from "./char-runs";
import { applyOp } from "./reducer";

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
  op: FormatSet;
}

/**
 * Insert text at a position in a block's visible content.
 */
export function insertCharsAtPosition(
  page: Page,
  blockId: string,
  position: number,
  text: string
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
  const firstId = nextId();
  const peerId = extractPeerId(firstId);
  const startCounter = extractCounter(firstId);
  for (let i = 1; i < text.length; i++) {
    nextId();
  }

  const newCharRun: CharRun = {
    peerId,
    startCounter,
    text,
  };

  const op: TextInsert = {
    op: "text_insert",
    id: nextId(),
    clock: getClock(),
    pageId: getPageId(),
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
  endIndex: number
): DeleteCharsResult {
  const block = page.blocks.find((b) => b.id === blockId);
  const charRuns = block && isTextualBlock(block) ? block.charRuns : undefined;
  const charIds = getCharIdsInRangeFromRuns(charRuns, startIndex, endIndex);

  const op: TextDelete = {
    op: "text_delete",
    id: nextId(),
    clock: getClock(),
    pageId: getPageId(),
    blockId,
    charIds,
  };

  return { newPage: applyOp(page, op), op };
}

/**
 * Apply (or remove, when `value === false`) a format to a visible range.
 */
export function formatCharsInRange(
  page: Page,
  blockId: string,
  startIndex: number,
  endIndex: number,
  format: TextFormat,
  value: boolean | string
): FormatCharsResult {
  const block = page.blocks.find((b) => b.id === blockId);
  const charRuns = block && isTextualBlock(block) ? block.charRuns : undefined;
  const charIds = getCharIdsInRangeFromRuns(charRuns, startIndex, endIndex);

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

  return { newPage: applyOp(page, op), op };
}

export function getVisibleText(charRuns: CharRun[]): string {
  return getVisibleTextFromRuns(charRuns);
}

export function getVisibleLength(charRuns: CharRun[]): number {
  return getVisibleLengthFromRuns(charRuns);
}

function getCharIdsInRangeFromRuns(
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

function isCharIdInSpan(charId: string, span: FormatSpan, charRuns: CharRun[] | undefined): boolean {
  if (!charRuns) return false;
  return isCharIdInRange(charRuns, charId, span.startCharId, span.endCharId);
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

  const charIds = getCharIdsInRangeFromRuns(charRuns, startIndex, endIndex);
  if (charIds.length === 0) return false;

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

  const charId = getCharIdAtVisiblePosition(charRuns, position);
  if (!charId) return [];

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
 * Shared by `applyOp` (reducer) — handles both fresh inserts and un-tombstoning
 * chars that already exist (e.g. undo restoring a deleted character).
 */
export function applyTextInsertOp(page: Page, op: TextInsert): Page {
  const blockIndex = page.blocks.findIndex((b) => b.id === op.blockId);

  if (blockIndex === -1) {
    return page;
  }

  const block = page.blocks[blockIndex];

  if (!block || block.deleted || !isTextualBlock(block)) {
    return page;
  }

  const chars = charRunsToChars(op.charRuns);

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
        const hasAnyDeleted = newMask?.some((byte) => byte !== 0);
        return { ...run, deletedMask: hasAnyDeleted ? newMask : undefined };
      }
      return run;
    });
  }

  if (charsToInsert.length > 0) {
    newCharRuns = insertIntoRuns(newCharRuns, op.afterCharId, charsToInsert);
  }

  const updatedBlock = { ...block, charRuns: newCharRuns };
  const newBlocks = [...page.blocks];
  newBlocks[blockIndex] = updatedBlock;

  return { ...page, blocks: newBlocks };
}
