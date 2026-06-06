/**
 * Operation Inversion for User-Independent Undo/Redo
 *
 * Inverses are captured AT EMIT TIME (in `recordUndoOps`) against the page
 * state the user actually had, then stored on the UndoGroup. At undo time
 * the captured inverses are re-stamped with fresh id/clock via `refreshOp`
 * and applied directly. The undo path no longer recomputes inverses from
 * current state — that historically introduced bugs whenever the inverse
 * function and the apply function drifted (e.g. forgetting to copy a new
 * block field through into `initialProps` of the inverse block_insert).
 *
 * Per-op inverse functions therefore take the `Page` state that existed
 * IMMEDIATELY BEFORE the corresponding op was applied. `invertOperations`
 * folds `applyOp` through the batch to materialise these intermediate
 * states; callers pass `applyOp` in to avoid a circular import.
 */
import type { Block, Char, Page, TextFormat } from "./serlization/loadPage";
import { isTextualBlock } from "./serlization/loadPage";
import { getBlockDescriptor, getBlockFieldNames } from "./sync/block-registry";
import {
  charRunsToChars,
  charsToRuns,
  isCharIdInRange,
  iterateAllChars,
} from "./sync/char-runs";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  FormatSet,
  Operation,
  TextDelete,
  TextInsert,
} from "./sync/crdt-types";
import { getClock, nextId } from "./sync/sync";

// =============================================================================
// Per-op inversion
//
// Each inverter takes the Page as it existed BEFORE the corresponding op was
// applied. They read whatever prior state the inverse needs (deleted-char
// payload for TextDelete, prior format value for FormatSet, full block fields
// for BlockDelete, prior field value for BlockSet) and produce an op with a
// placeholder id/clock. The id/clock get re-stamped via refreshOp at the
// moment the inverse is applied so peers see the undo as a new event.
// =============================================================================

/**
 * Compute the inverse of a text insert operation.
 * Inverse: Delete the inserted characters.
 *
 * Doesn't depend on the pre-state — the inserted char IDs come directly from
 * the op's charRuns.
 */
function invertTextInsert(op: TextInsert): TextDelete | null {
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
 * Inverse: Re-insert the deleted characters.
 *
 * The chars being deleted are still visible in `pageBefore` (the op hasn't
 * been applied yet at this point), so we capture their content and position
 * directly. After this we don't need pageBefore again — the inverse carries
 * everything it needs.
 */
function invertTextDelete(op: TextDelete, pageBefore: Page): TextInsert | null {
  const block = pageBefore.blocks.find((b) => b.id === op.blockId);

  if (!block) return null;
  if (block.deleted) return null;
  if (!isTextualBlock(block)) return null;

  // Capture the chars that will be deleted (they're still visible).
  const charIdSet = new Set(op.charIds);
  const charsToReinsert: Char[] = [];
  for (const { id, char, deleted } of iterateAllChars(block.charRuns)) {
    if (charIdSet.has(id) && !deleted) {
      charsToReinsert.push({ id, char });
    }
  }

  if (charsToReinsert.length === 0) return null;

  // Determine the insertion position by looking at the char immediately
  // before the first reinserted char in the pre-state's full sequence
  // (including tombstones — tombstones preserve CRDT ordering).
  let afterCharId: string | null = null;
  const firstDeletedId = charsToReinsert[0].id;
  const sequenceIds: string[] = [];
  for (const { id } of iterateAllChars(block.charRuns)) {
    sequenceIds.push(id);
  }
  const firstDeletedIndex = sequenceIds.indexOf(firstDeletedId);
  if (firstDeletedIndex > 0) {
    afterCharId = sequenceIds[firstDeletedIndex - 1];
  }

  const charRuns = charsToRuns(charsToReinsert);

  return {
    op: "text_insert",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    blockId: op.blockId,
    afterCharId,
    charRuns,
  };
}

/**
 * Compute the inverse of a format set operation.
 *
 * For each affected char in `pageBefore`, find whether a span of the same
 * format type covered it; if so, what value did it have? Group consecutive
 * chars with the same prior value into a single inverse op so we emit one
 * op per contiguous run rather than one per char.
 *
 * Without a pre-state (shouldn't happen for ops captured by recordUndoOps)
 * this returns an empty array — there's no safe fallback if we don't know
 * the prior value, and undo failing loud is better than corrupting state.
 */
function invertFormatSet(op: FormatSet, pageBefore: Page): FormatSet[] {
  const block = pageBefore.blocks.find((b) => b.id === op.blockId);
  if (!block || block.deleted || !isTextualBlock(block)) return [];

  // Look up the prior value of `op.format.type` on each affected char.
  // For overlapping same-type spans we pick the one with the latest HLC
  // (LWW — matches how applyFormatSet computes the visible state).
  type Prior = { charId: string; priorFormat: TextFormat | null };
  const priors: Prior[] = [];
  for (const charId of op.charIds) {
    let priorFormat: TextFormat | null = null;
    let priorCounter = -1;
    let priorPeer = "";
    for (const span of block.formats) {
      if (span.format.type !== op.format.type) continue;
      if (
        !isCharIdInRange(
          block.charRuns,
          charId,
          span.startCharId,
          span.endCharId,
        )
      ) {
        continue;
      }
      if (
        span.clock.counter > priorCounter ||
        (span.clock.counter === priorCounter && span.clock.peerId > priorPeer)
      ) {
        priorFormat = span.format;
        priorCounter = span.clock.counter;
        priorPeer = span.clock.peerId;
      }
    }
    priors.push({ charId, priorFormat });
  }

  // Group consecutive entries by prior-format identity.
  const sameFormat = (a: TextFormat | null, b: TextFormat | null): boolean => {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.type !== b.type) return false;
    if (a.type === "link") return a.url === b.url;
    return true;
  };

  const inverses: FormatSet[] = [];
  let runStart = 0;
  while (runStart < priors.length) {
    const groupPrior = priors[runStart].priorFormat;
    let runEnd = runStart;
    while (
      runEnd + 1 < priors.length &&
      sameFormat(priors[runEnd + 1].priorFormat, groupPrior)
    ) {
      runEnd++;
    }
    const charIds = priors.slice(runStart, runEnd + 1).map((p) => p.charId);
    if (groupPrior === null) {
      // No prior format of this type on these chars — undo by removing.
      inverses.push({
        op: "format_set",
        id: nextId(),
        clock: getClock(),
        pageId: op.pageId,
        blockId: op.blockId,
        charIds,
        format: op.format,
        value: false,
      });
    } else {
      // Had a prior format (possibly with a different URL for links):
      // re-apply it so the original span is restored.
      inverses.push({
        op: "format_set",
        id: nextId(),
        clock: getClock(),
        pageId: op.pageId,
        blockId: op.blockId,
        charIds,
        format: groupPrior,
        value: true,
      });
    }
    runStart = runEnd + 1;
  }
  return inverses;
}

/**
 * Compute the inverse of a block insert operation.
 * Inverse: Delete the inserted block.
 */
function invertBlockInsert(op: BlockInsert): BlockDelete {
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
 *
 * Reads the block from `pageBefore` (where it still exists, not yet
 * tombstoned). Uses the block-type registry to extract every field's value
 * into `initialProps`, so adding a new field to a block type doesn't require
 * touching this function — the registry is the single source of truth.
 */
function invertBlockDelete(
  op: BlockDelete,
  pageBefore: Page,
): BlockInsert | null {
  const block: Block | undefined = pageBefore.blocks.find(
    (b) => b.id === op.blockId,
  );
  if (!block || block.deleted) return null;

  const descriptor = getBlockDescriptor(block.type);
  const initialProps: Record<string, unknown> = {};
  for (const fieldName of getBlockFieldNames(block.type)) {
    if (fieldName === "type") continue;
    initialProps[fieldName] =
      descriptor.fields[fieldName].extractForInverse(block);
  }

  return {
    op: "block_insert",
    id: nextId(),
    clock: getClock(),
    pageId: op.pageId,
    afterBlockId: block.afterId ?? null,
    blockId: op.blockId,
    blockType: block.type,
    initialProps,
  };
}

/**
 * Compute the inverse of a block set operation.
 *
 * Reads the prior value of the field from `pageBefore`. Uses the registry's
 * `extractForInverse` so type-specific extraction lives in one place.
 */
function invertBlockSet(op: BlockSet, pageBefore: Page): BlockSet | null {
  const block = pageBefore.blocks.find((b) => b.id === op.blockId);
  if (!block || block.deleted) return null;

  const descriptor = getBlockDescriptor(block.type);
  let previousValue: unknown;
  if (op.field === "type") {
    previousValue = block.type;
  } else {
    const fieldDesc = descriptor.fields[op.field];
    previousValue = fieldDesc ? fieldDesc.extractForInverse(block) : undefined;
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
 * Compute the inverse(s) of a single op against the page state before that
 * op was applied. Returns an empty array when the op cannot be inverted
 * (e.g. the original op was a no-op already).
 *
 * Some op kinds invert into multiple ops — format_set crossing pre-existing
 * formatting boundaries inverts into one op per prior segment.
 */
export function invertOperation(op: Operation, pageBefore: Page): Operation[] {
  switch (op.op) {
    case "text_insert": {
      const inv = invertTextInsert(op);
      return inv ? [inv] : [];
    }
    case "text_delete": {
      const inv = invertTextDelete(op, pageBefore);
      return inv ? [inv] : [];
    }
    case "format_set":
      return invertFormatSet(op, pageBefore);
    case "block_insert":
      return [invertBlockInsert(op)];
    case "block_delete": {
      const inv = invertBlockDelete(op, pageBefore);
      return inv ? [inv] : [];
    }
    case "block_set": {
      const inv = invertBlockSet(op, pageBefore);
      return inv ? [inv] : [];
    }
    default:
      return [];
  }
}

/**
 * Compute inverses for a batch of operations.
 *
 * Each op's inverse is computed against the page state IMMEDIATELY BEFORE
 * that op was applied. We fold `applyOp` through `pageBefore` to materialise
 * the per-op pre-state, then invert each op against its own pre-state. The
 * `applyOp` function is passed in to avoid a circular import (reducer →
 * crdt-helpers → inverse).
 *
 * Returned in REVERSE order so applying them in array order rolls back the
 * batch (last op undone first).
 */
export function invertOperations(
  ops: readonly Operation[],
  pageBefore: Page,
  applyOp: (page: Page, op: Operation) => Page,
): Operation[] {
  // Materialise the per-op pre-state.
  const preStates: Page[] = new Array(ops.length);
  let current = pageBefore;
  for (let i = 0; i < ops.length; i++) {
    preStates[i] = current;
    current = applyOp(current, ops[i]);
  }

  // Invert each op against its own pre-state, in reverse order.
  const inverses: Operation[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    for (const inv of invertOperation(ops[i], preStates[i])) {
      inverses.push(inv);
    }
  }
  return inverses;
}

// =============================================================================
// Re-stamping ops for replay
// =============================================================================

/**
 * Return a copy of an operation with a fresh id and clock so it appears as a
 * new event to peers.
 *
 * Used by both undo and redo:
 * - Undo applies stored inverses (captured with placeholder id/clock at emit
 *   time). Re-stamping promotes them to fresh events.
 * - Redo re-applies the original op, but the original id/clock is already
 *   in every peer's version vector from the first broadcast. Re-stamping
 *   makes the re-broadcast actually propagate.
 *
 * The semantic effect of the replayed op is identical because the payload
 * (charIds, blockId, format, value, afterCharId, etc.) is unchanged.
 */
export function refreshOps(ops: readonly Operation[]): Operation[] {
  return ops.map(refreshOp);
}

function refreshOp(op: Operation): Operation {
  return {
    ...op,
    id: nextId(),
    clock: getClock(),
  };
}
