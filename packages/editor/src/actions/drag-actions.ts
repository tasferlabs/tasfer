/**
 * Editor **drag actions** — the content edits a native HTML5 drop commits.
 *
 * Text drag-and-drop is the platform's, not the editor's: the browser owns the
 * gesture, the drag image, the cursor, and the copy-vs-move decision, and hands
 * the content over on a `DataTransfer`. What is left for the engine is the two
 * document edits a drop can imply — insert what was dropped, and (for a move)
 * remove what was dragged — which is what lives here.
 *
 * Kept in its own module rather than folded into `edit-actions.ts` because a
 * drop reconstructs content through the clipboard parser, and `clipboard.ts`
 * sits downstream of the node layer — which itself imports `edit-actions.ts`.
 *
 * Geometry policy is the same as the other pointer actions: these stay pure over
 * `EditorState` and never hit-test. The drag event layer resolves the drop
 * position against the viewport and passes it in.
 */

import { stateAction } from "../action-bus";
import { clearSelection, updateCursor } from "../selection";
import type { EditorState, Operation, Position } from "../state-types";
import { getBlockTextLength, updateMode } from "../state-utils";
import { deleteSelectedText } from "./actions";
import { type ClipboardPayload, insertClipboardPayload } from "./clipboard";

/** A document range, as a drag records the text it picked up. */
export interface DragRange {
  readonly start: Position;
  readonly end: Position;
}

/**
 * Whether `p` lies within `[start, end]` inclusive, in document order. Shared
 * with the drag event layer, which shows no insertion caret for a drop aimed
 * inside the text being carried — the same positions {@link DROP_TEXT} refuses.
 */
export function positionWithinRange(
  p: Position,
  start: Position,
  end: Position,
) {
  const afterStart =
    p.blockIndex > start.blockIndex ||
    (p.blockIndex === start.blockIndex && p.textIndex >= start.textIndex);
  const beforeEnd =
    p.blockIndex < end.blockIndex ||
    (p.blockIndex === end.blockIndex && p.textIndex <= end.textIndex);
  return afterStart && beforeEnd;
}

/**
 * Re-point a drop target after the dragged range was deleted out from under it.
 *
 * Deletion only ever moves what FOLLOWS the range, and blocks are tombstoned in
 * place — indices never shift — so the only target that needs adjusting is one
 * in the block the range ended in, past its end. There the surviving tail has
 * been pulled back to start at the post-delete caret (a multi-block delete
 * merges it into the start block; a single-block delete just closes the gap), so
 * a target `n` characters past the range's end lands `n` characters past the
 * caret. Reading the caret rather than recomputing from `start` also absorbs the
 * markdown prefix promotion the delete may have re-run on the start block.
 */
function retargetAfterDeletion(
  target: Position,
  range: DragRange,
  caret: Position,
): Position {
  // Before the range — untouched.
  if (
    target.blockIndex < range.start.blockIndex ||
    (target.blockIndex === range.start.blockIndex &&
      target.textIndex < range.start.textIndex)
  ) {
    return target;
  }
  // Past the range's end, in the block it ended in — follows the merged tail.
  if (
    target.blockIndex === range.end.blockIndex &&
    target.textIndex >= range.end.textIndex
  ) {
    return {
      blockIndex: caret.blockIndex,
      textIndex: caret.textIndex + (target.textIndex - range.end.textIndex),
    };
  }
  // In a later block — untouched, indices being tombstone-stable.
  if (target.blockIndex > range.end.blockIndex) return target;
  // Inside the range. DROP_TEXT refuses these, so this is only a backstop.
  return caret;
}

/** Clamp a position onto a live block, or `null` if that block is gone. */
function clampToBlock(state: EditorState, p: Position): Position | null {
  const block = state.document.page.blocks[p.blockIndex];
  if (!block || block.deleted) return null;
  const length = getBlockTextLength(block);
  return {
    blockIndex: p.blockIndex,
    textIndex: Math.max(0, Math.min(p.textIndex, length)),
  };
}

/** Put the selection on `range` so the range-based edits below address it. */
function selectRange(state: EditorState, range: DragRange): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      cursor: { position: range.end, lastUpdate: Date.now() },
      selection: {
        anchor: range.start,
        focus: range.end,
        isForward: true,
        isCollapsed: false,
        lastUpdate: Date.now(),
      },
    },
  };
}

/**
 * Commit a native drop at `target`.
 *
 * `payload` is what the browser handed over on the `DataTransfer`, in the same
 * flavors a copy writes to the clipboard — so a drop reconstructs marks, block
 * types and math through exactly the same parser a paste uses, whether the text
 * came from this editor, another editor on the page, or another application.
 *
 * `source` is set only when THIS editor started the drag and the browser
 * resolved it to a move: the range is then removed and the insert re-pointed
 * across that removal, both in one transaction so the whole move is a single
 * undo step. A copy (or a drag from elsewhere) passes `null` and only inserts.
 */
export const DROP_TEXT = stateAction<{
  source: DragRange | null;
  target: Position;
  payload: ClipboardPayload;
}>("drop-text", (state, { source, target, payload }) => {
  const ops: Operation[] = [];
  let next = state;
  let insertAt = target;

  if (source) {
    // A move onto itself has nowhere to go.
    if (positionWithinRange(target, source.start, source.end)) {
      return { state, ops: [] };
    }
    const removed = deleteSelectedText(selectRange(next, source));
    if (removed.ops.length === 0) return { state, ops: [] };
    ops.push(...removed.ops);
    next = removed.state;
    insertAt = retargetAfterDeletion(
      target,
      source,
      next.document.cursor?.position ?? source.start,
    );
  }

  const anchor = clampToBlock(next, insertAt);
  if (!anchor) return { state, ops: [] };
  next = clearSelection(updateCursor(next, anchor));

  const inserted = insertClipboardPayload(next, payload);
  // Nothing parsed back out of the payload — abandon the drop rather than
  // commit a deletion on its own.
  if (!inserted) return { state, ops: [] };
  ops.push(...inserted.ops);
  next = inserted.state;

  // Leave the dropped text selected: the caret sits at its far end, and an
  // insert always runs forward from where it started.
  const landed = next.document.cursor?.position;
  if (
    landed &&
    (landed.blockIndex !== anchor.blockIndex ||
      landed.textIndex !== anchor.textIndex)
  ) {
    next = {
      ...next,
      document: {
        ...next.document,
        selection: {
          anchor,
          focus: landed,
          isForward: true,
          isCollapsed: false,
          lastUpdate: Date.now(),
        },
      },
    };
  }

  return { state: updateMode(next, "edit"), ops };
});

/**
 * Remove the range a drag carried away, when the browser reports on `dragend`
 * that it completed as a move into a target this editor never saw a drop for —
 * another application, or another editor on the page. The insert side happened
 * over there; only the removal is ours.
 *
 * A move that landed back inside this editor is committed wholesale by
 * {@link DROP_TEXT} instead, so the drag layer only reaches for this when its
 * own drop handler never ran.
 */
export const REMOVE_DRAGGED_TEXT = stateAction<{ source: DragRange }>(
  "remove-dragged-text",
  (state, { source }) => {
    const removed = deleteSelectedText(selectRange(state, source));
    if (removed.ops.length === 0) return { state, ops: [] };
    return { state: updateMode(removed.state, "edit"), ops: removed.ops };
  },
);
