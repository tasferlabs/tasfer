/**
 * Operation Inversion for User-Independent Undo/Redo
 *
 * This module computes inverse operations for each operation type.
 * When undoing, we apply the inverse operation instead of restoring state snapshots.
 * This allows undo/redo to work independently per user in a CRDT environment.
 */

import type { Block, Char, CharRun, TextFormat } from "@/deserializer/loadPage";
import { getClock, nextId } from "./sync/sync";
import {
  iterateAllChars,
  charRunsToChars,
} from "./sync/char-runs";
import { extractPeerId, extractCounter } from "./sync/id";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  FormatSet,
  Operation,
  TextDelete,
  TextInsert
} from "./sync/types";
import type { EditorState, PriorFormatEntry } from "./types";

/**
 * Convert Char[] to CharRun[] (for inverse operations).
 * Handles chars from multiple peers by splitting into separate runs.
 */
function charsToCharRuns(chars: Char[]): CharRun[] {
  if (chars.length === 0) return [];

  const runs: CharRun[] = [];
  let currentPeerId = extractPeerId(chars[0].id);
  let currentStartCounter = extractCounter(chars[0].id);
  let currentText = "";
  let currentDeleted: boolean[] = [];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const peerId = extractPeerId(char.id);
    const counter = extractCounter(char.id);

    // Check if continues current run (same peer, consecutive counter)
    if (
      peerId === currentPeerId &&
      counter === currentStartCounter + currentText.length
    ) {
      currentText += char.char;
      currentDeleted.push(char.deleted ?? false);
    } else {
      // Finish current run
      if (currentText.length > 0) {
        runs.push(
          createCharRunFromDeleted(
            currentPeerId,
            currentStartCounter,
            currentText,
            currentDeleted
          )
        );
      }

      // Start new run
      currentPeerId = peerId;
      currentStartCounter = counter;
      currentText = char.char;
      currentDeleted = [char.deleted ?? false];
    }
  }

  // Finish last run
  if (currentText.length > 0) {
    runs.push(
      createCharRunFromDeleted(
        currentPeerId,
        currentStartCounter,
        currentText,
        currentDeleted
      )
    );
  }

  return runs;
}

/**
 * Helper to create CharRun with optional deletedMask
 */
function createCharRunFromDeleted(
  peerId: string,
  startCounter: number,
  text: string,
  deleted: boolean[]
): CharRun {
  const hasDeleted = deleted.some((d) => d);

  if (!hasDeleted) {
    return { peerId, startCounter, text };
  }

  // Create deletedMask bitmap
  const deletedMask: number[] = new Array(Math.ceil(deleted.length / 8)).fill(0);
  deleted.forEach((isDeleted, i) => {
    if (isDeleted) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      deletedMask[byteIndex] |= 1 << bitIndex;
    }
  });

  return { peerId, startCounter, text, deletedMask };
}

/**
 * Compute the inverse of a text insert operation.
 * Inverse: Delete the inserted characters.
 */
function invertTextInsert(
  op: TextInsert,
  _state: EditorState
): TextDelete | null {
  // To invert a text insert, we need to delete the characters that were inserted
  // Convert charRuns back to chars to get the IDs
  const chars = charRunsToChars(op.charRuns);
  const charIds = chars.map((c) => c.id);

  if (charIds.length === 0) {
    return null;
  }

  return {
    op: "text_delete",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
    charIds,
  };
}

/**
 * Compute the inverse of a text delete operation.
 * Inverse: Re-insert the deleted characters (tombstones).
 */
function invertTextDelete(
  op: TextDelete,
  state: EditorState
): TextInsert | null {
  // Find the block (including tombstoned blocks)
  const block = state.document.page.blocks.find((b) => b.id === op.blockId);

  if (!block) {
    return null;
  }

  // Skip if block itself is tombstoned (deleted by someone else)
  if (block.deleted) {
    return null;
  }

  // Skip blocks without text content
  if (block.type === "image" || block.type === "line" || block.type === "math") {
    return null;
  }

  // Find the tombstoned (deleted) characters in the block
  const charsToReinsert: Char[] = [];
  const charIdSet = new Set(op.charIds);

  // Iterate through all chars (including deleted) to find tombstoned ones
  for (const { id, char, deleted } of iterateAllChars(block.charRuns)) {
    if (charIdSet.has(id) && deleted) {
      charsToReinsert.push({
        id,
        char,
      });
    }
  }

  if (charsToReinsert.length === 0) {
    return null; // All chars already restored or missing
  }

  // Find the position to insert after
  // Look for the character IMMEDIATELY BEFORE the first char to restore in the charRuns sequence
  // This preserves the original CRDT position regardless of tombstone status
  let afterCharId: string | null = null;
  const firstDeletedId = charsToReinsert[0].id;

  // Get all chars in order to find the preceding char
  const allChars: Array<{ id: string; deleted: boolean }> = [];
  for (const { id, deleted } of iterateAllChars(block.charRuns)) {
    allChars.push({ id, deleted });
  }

  const firstDeletedIndex = allChars.findIndex((c) => c.id === firstDeletedId);
  if (firstDeletedIndex > 0) {
    // Use the character immediately before (regardless of its deleted status)
    // This preserves the original CRDT ordering
    afterCharId = allChars[firstDeletedIndex - 1].id;
  }
  // If firstDeletedIndex is 0 or -1, afterCharId stays null (insert at beginning)

  // Convert to CharRuns
  const charRuns = charsToCharRuns(charsToReinsert);

  return {
    op: "text_insert",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
    afterCharId,
    charRuns: charRuns,
  };
}

/**
 * Compute the inverse of a format set operation.
 *
 * If priorEntries is provided (captured by recordUndoOps at the time the op
 * was applied), we restore the per-char prior state: contiguous runs of chars
 * that had the same prior format become one format_set op, preserving link
 * URLs and any other format-specific data.
 *
 * Without priorEntries we fall back to a naive toggle (the legacy behavior
 * before per-char prior state was captured).
 */
function invertFormatSet(
  op: FormatSet,
  state: EditorState,
  priorEntries: readonly PriorFormatEntry[] | undefined
): FormatSet[] {
  const block = state.document.page.blocks.find((b) => b.id === op.blockId);
  if (!block || block.deleted) return [];

  if (!priorEntries || priorEntries.length === 0) {
    // Fallback: legacy toggle. Loses prior URL on link, prior state under
    // overlapping spans, etc. — only used when prior-format snapshot is
    // missing (shouldn't happen for ops recorded after this commit).
    const inverseValue: boolean | string =
      typeof op.value === "boolean" ? !op.value : false;
    return [
      {
        op: "format_set",
        id: nextId(),
        clock: getClock(),
        pageId: op.pageId,
        blockId: op.blockId,
        charIds: op.charIds,
        format: op.format,
        value: inverseValue,
      },
    ];
  }

  // Group consecutive entries by prior-format identity so we emit one op per
  // contiguous run rather than per char. Two priorFormats are "the same" if
  // they're both null OR both have the same type and (for link) the same url.
  const sameFormat = (a: TextFormat | null, b: TextFormat | null): boolean => {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.type !== b.type) return false;
    if (a.type === "link") return a.url === b.url;
    return true;
  };

  const groups: { priorFormat: TextFormat | null; charIds: string[] }[] = [];
  for (const entry of priorEntries) {
    const last = groups[groups.length - 1];
    if (last && sameFormat(last.priorFormat, entry.priorFormat)) {
      last.charIds.push(entry.charId);
    } else {
      groups.push({ priorFormat: entry.priorFormat, charIds: [entry.charId] });
    }
  }

  const ops: FormatSet[] = [];
  for (const group of groups) {
    if (group.priorFormat === null) {
      // No prior format of this type: remove it across this run.
      ops.push({
        op: "format_set",
        id: nextId(),
        clock: getClock(),
        pageId: op.pageId,
        blockId: op.blockId,
        charIds: group.charIds,
        format: op.format,
        value: false,
      });
    } else {
      // Had a prior format (potentially with different url for links):
      // re-apply that format across this run. value just needs to be truthy
      // for applyRemoteFormatSet to take the "add" path; the format object
      // carries the meaningful data (type, url).
      ops.push({
        op: "format_set",
        id: nextId(),
        clock: getClock(),
        pageId: op.pageId,
        blockId: op.blockId,
        charIds: group.charIds,
        format: group.priorFormat,
        value: true,
      });
    }
  }
  return ops;
}

/**
 * Compute the inverse of a block insert operation.
 * Inverse: Delete the inserted block.
 */
function invertBlockInsert(
  op: BlockInsert,
  _state: EditorState
): BlockDelete | null {
  return {
    op: "block_delete",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
  };
}

/**
 * Compute the inverse of a block delete operation.
 * Inverse: Re-insert the deleted block (tombstone).
 */
function invertBlockDelete(
  op: BlockDelete,
  state: EditorState
): BlockInsert | null {
  // Find the tombstoned block in the current state
  const block: Block | undefined = state.document.page.blocks.find(
    (b) => b.id === op.blockId && b.deleted
  );

  if (!block) {
    return null; // Block not found or already restored
  }

  // Use the block's afterId directly (tombstone preserves position)
  const afterBlockId = block.afterId;

  // Build initial props based on block type
  let initialProps: any = {};
  if (block.type === "bullet_list" || block.type === "numbered_list") {
    initialProps.indent = block.indent;
  } else if (block.type === "todo_list") {
    initialProps.checked = block.checked;
    initialProps.indent = block.indent;
  } else if (block.type === "image") {
    initialProps.url = block.url;
    initialProps.alt = block.alt;
    initialProps.width = block.width;
    initialProps.height = block.height;
    initialProps.objectFit = block.objectFit;
  }

  return {
    op: "block_insert",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    afterBlockId: afterBlockId || null,
    blockId: op.blockId,
    blockType: block.type,
    initialProps,
  };
}

/**
 * Compute the inverse of a block set operation.
 * Inverse: Set the property back to its previous value.
 */
function invertBlockSet(op: BlockSet, state: EditorState): BlockSet | null {
  // To invert a block set, we need to know the previous value
  const block = state.document.page.blocks.find((b) => b.id === op.blockId);

  if (!block || block.deleted) {
    return null;
  }

  // Get the current value (which is the previous value before this op was applied)
  let previousValue: unknown;

  if (op.field === "type") {
    previousValue = block.type;
  } else {
    // Access the field directly on the block (for indent, checked, url, etc.)
    previousValue = (block as any)[op.field];
  }

  return {
    op: "block_set",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
    field: op.field,
    value: previousValue,
  };
}

/**
 * Compute the inverse of any operation. Returns an array because some op
 * types (format_set) may need multiple inverses to restore per-char prior
 * state. Returns an empty array if the operation cannot be inverted.
 */
export function invertOperation(
  op: Operation,
  state: EditorState,
  priorFormats?: ReadonlyMap<string, readonly PriorFormatEntry[]>
): Operation[] {
  switch (op.op) {
    case "text_insert": {
      const inv = invertTextInsert(op, state);
      return inv ? [inv] : [];
    }
    case "text_delete": {
      const inv = invertTextDelete(op, state);
      return inv ? [inv] : [];
    }
    case "format_set":
      return invertFormatSet(op, state, priorFormats?.get(op.id));
    case "block_insert": {
      const inv = invertBlockInsert(op, state);
      return inv ? [inv] : [];
    }
    case "block_delete": {
      const inv = invertBlockDelete(op, state);
      return inv ? [inv] : [];
    }
    case "block_set": {
      const inv = invertBlockSet(op, state);
      return inv ? [inv] : [];
    }
    default:
      return [];
  }
}

/**
 * Compute inverses for a batch of operations (in reverse order).
 * When undoing multiple operations, we need to invert them in reverse order.
 */
export function invertOperations(
  ops: readonly Operation[],
  state: EditorState,
  priorFormats?: ReadonlyMap<string, readonly PriorFormatEntry[]>
): Operation[] {
  const inverses: Operation[] = [];

  // Process in reverse order
  for (let i = ops.length - 1; i >= 0; i--) {
    for (const inverse of invertOperation(ops[i], state, priorFormats)) {
      inverses.push(inverse);
    }
  }

  return inverses;
}

/**
 * Return a copy of an operation with a fresh id and clock so it appears as a
 * new event to peers. Used by redo: the original op's id/clock is already in
 * every peer's version vector, so re-broadcasting it would be silently
 * dropped. Replaying it with a fresh stamp re-applies the change everywhere
 * (un-tombstoning chars/blocks for inserts, re-tombstoning for deletes,
 * creating a new span for format_set, and overwriting fields for block_set).
 */
export function refreshOp(op: Operation): Operation {
  return {
    ...op,
    id: nextId(),
    clock: getClock(),
  };
}

export function refreshOps(ops: readonly Operation[]): Operation[] {
  return ops.map(refreshOp);
}
