/**
 * CRDT Helper Functions
 * 
 * These helpers return BOTH the new data AND the CRDT operation atomically.
 */

import type { Char, FormatSpan, TextFormat } from "../deserializer/loadPage";
import type {
  FormatSet,
  TextDelete,
  TextInsert
} from "../sync/types";
import type { CRDTContext } from "./types";

export interface InsertCharsResult {
  newChars: Char[];
  op: TextInsert;
}

export interface DeleteCharsResult {
  newChars: Char[];
  op: TextDelete;
}

export interface FormatCharsResult {
  newFormats: FormatSpan[];
  op: FormatSet;
}

/**
 * Insert text at a position - returns new chars AND the operation
 */
export function insertCharsAtPosition(
  chars: Char[],
  position: number,
  text: string,
  blockId: string,
  crdt: CRDTContext
): InsertCharsResult {
  const afterCharId = findCharIdAtPosition(chars, position);
  
  const newCharObjects: Char[] = Array.from(text).map(char => ({
    id: crdt.idGen(),
    char,
    deleted: false,
  }));
  
  const insertIndex = findInsertIndex(chars, position);
  const newChars = [...chars];
  newChars.splice(insertIndex, 0, ...newCharObjects);
  
  const op: TextInsert = {
    op: "text_insert",
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId,
    afterCharId,
    chars: newCharObjects.map(c => ({ id: c.id, char: c.char })),
  };
  
  return { newChars, op };
}

/**
 * Delete text in a range - returns new chars AND the operation
 */
export function deleteCharsInRange(
  chars: Char[],
  startIndex: number,
  endIndex: number,
  blockId: string,
  crdt: CRDTContext,
): DeleteCharsResult {
  const deletedIds: string[] = [];
  let visibleCount = 0;
  
  const newChars = chars.map(char => {
    if (!char.deleted) {
      if (visibleCount >= startIndex && visibleCount < endIndex) {
        deletedIds.push(char.id);
        return { ...char, deleted: true };
      }
      visibleCount++;
    }
    return char;
  });
  
  const op: TextDelete = {
    op: "text_delete",
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId,
    charIds: deletedIds,
  };
  
  return { newChars, op };
}

/**
 * Check if a character ID is within a format span
 */
function isCharIdInSpan(charId: string, span: FormatSpan, chars: Char[]): boolean {
  const startIdx = chars.findIndex(c => c.id === span.startCharId);
  const endIdx = chars.findIndex(c => c.id === span.endCharId);
  const charIdx = chars.findIndex(c => c.id === charId);
  
  if (startIdx === -1 || endIdx === -1 || charIdx === -1) return false;
  
  return charIdx >= startIdx && charIdx <= endIdx;
}

/**
 * Apply formatting to a range - returns new formats AND the operation
 * When value is false, removes the format from the range
 */
export function formatCharsInRange(
  chars: Char[],
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
  blockId: string,
  format: TextFormat,
  value: boolean | string,
  crdt: CRDTContext
): FormatCharsResult {
  const charIds = getCharIdsInRange(chars, startIndex, endIndex);
  
  if (charIds.length === 0) {
    return {
      newFormats: formats,
      op: {
        op: "format_set",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
        blockId,
        charIds: [],
        format: format.type as any,
        value,
      },
    };
  }
  
  let newFormats: FormatSpan[];
  
  if (value === false) {
    // Remove format: filter out spans that match this format type and overlap with our range
    newFormats = formats.filter(span => {
      if (span.format.type !== format.type) return true;
      
      // Check if this span overlaps with any of our charIds
      const overlaps = charIds.some(charId => isCharIdInSpan(charId, span, chars));
      return !overlaps;
    });
  } else {
    // Add format: create a new span
    const newSpan: FormatSpan = {
      startCharId: charIds[0],
      endCharId: charIds[charIds.length - 1],
      format,
      clock: crdt.clock().wall,
    };
    newFormats = [...formats, newSpan];
  }
  
  const op: FormatSet = {
    op: "format_set",
    id: crdt.idGen(),
    clock: crdt.clock(),
    pageId: crdt.pageId,
    blockId,
    charIds,
    format: format.type as any,
    value,
  };
  
  return { newFormats, op };
}

export function getVisibleText(chars: Char[]): string {
  return chars.filter(c => !c.deleted).map(c => c.char).join("");
}

export function getVisibleLength(chars: Char[]): number {
  return chars.filter(c => !c.deleted).length;
}

export function getCharIdsInRange(
  chars: Char[],
  startIndex: number,
  endIndex: number
): string[] {
  const ids: string[] = [];
  let visibleCount = 0;
  
  for (const char of chars) {
    if (!char.deleted) {
      if (visibleCount >= startIndex && visibleCount < endIndex) {
        ids.push(char.id);
      }
      visibleCount++;
      if (visibleCount >= endIndex) break;
    }
  }
  
  return ids;
}

function findCharIdAtPosition(chars: Char[], position: number): string | null {
  if (position === 0) return null;
  
  let visibleCount = 0;
  for (const char of chars) {
    if (!char.deleted) {
      visibleCount++;
      if (visibleCount === position) {
        return char.id;
      }
    }
  }
  return null;
}

function findInsertIndex(chars: Char[], visiblePosition: number): number {
  let visibleCount = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].deleted) {
      if (visibleCount === visiblePosition) return i;
      visibleCount++;
    }
  }
  return chars.length;
}

/**
 * Check if all characters in a range have a specific format
 */
export function allCharsHaveFormat(
  chars: Char[],
  formats: FormatSpan[],
  startIndex: number,
  endIndex: number,
  formatType: TextFormat["type"]
): boolean {
  const charIds = getCharIdsInRange(chars, startIndex, endIndex);
  if (charIds.length === 0) return false;
  
  // Check if all char IDs are covered by format spans of the given type
  return charIds.every(charId => 
    formats.some(span => 
      span.format.type === formatType && 
      isCharIdInSpan(charId, span, chars)
    )
  );
}

/**
 * Get formats at a specific position (for cursor)
 */
export function getFormatsAtCharPosition(
  chars: Char[],
  formats: FormatSpan[],
  position: number
): TextFormat[] {
  if (position === 0) return [];
  
  // Get the char ID at position - 1 (inherit from previous char)
  const charId = findCharIdAtPosition(chars, position);
  if (!charId) return [];
  
  // Find all format spans that include this char
  const activeFormats: TextFormat[] = [];
  for (const span of formats) {
    if (isCharIdInSpan(charId, span, chars)) {
      activeFormats.push(span.format);
    }
  }
  
  return activeFormats;
}
