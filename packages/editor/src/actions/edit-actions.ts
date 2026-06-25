/**
 * Editor **edit actions** — the content-mutating and selection-clearing
 * actions the key handlers used to inline, lifted into named, dispatchable
 * {@link StateAction}s. Sibling to `keyboard-actions.ts` (which holds the
 * cursor/selection moves); this file holds the ones that emit CRDT ops
 * (insert/delete/split/format/indent) plus the op-free Escape clear.
 *
 * A state action is the low-level action shape: its default behavior is a
 * pure `(state) => { state, ops }` transform (see `action-bus.ts`), which is
 * exactly the currency the event pipeline already trades in. Each action here
 * wraps the matching pure action in `actions.ts` so hosts/plugins can observe
 * or override the edit, and the engine's logic lives in one named place instead
 * of being scattered across the switch statements in `keysEvents.ts`.
 *
 * This module also exports the shared arrow-key edge helpers
 * ({@link selectVisualBlockAfterMove}, {@link createParagraphAbove},
 * {@link createParagraphBelow}, {@link removeAutoCreatedParagraph}) that the six
 * arrow/page branches used to copy-paste verbatim — extracted so all six share
 * one implementation without changing behavior.
 */

import { action, stateAction, type StateResult } from "../action-bus";
import type { ChangeApi, DocRange } from "../entries/editor";
import { invalidateBlockCache } from "../rendering/renderer";
import { getTextDirection } from "../rtl";
import { clearSelection, moveCursorToPosition } from "../selection";
import type { Block, Mark } from "../serlization/loadPage";
import type { EditorState, Operation } from "../state-types";
import { clearAutoCreatedParagraph, getBlockTextContent } from "../state-utils";
import { findBlock } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { markCharsInRange } from "../sync/crdt-utils";
import { findPreviousVisibleBlockIndex } from "../sync/reducer";
import {
  deleteForward,
  deleteText,
  deleteWordBackward,
  deleteWordForward,
  insertText,
  mergeBlocksOps,
  selectAll,
  splitBlock,
} from "./actions";

// ─── Block conversion ─────────────────────────────────────────────────────────

/**
 * Convert the block at the caret to a different type — the dispatchable
 * **command** form of {@link ChangeApi.setBlock}. Its default mutation routes
 * through the unified change API (one undoable step), so a host drives block
 * changes by dispatching this rather than calling a bespoke method, and other
 * handlers can observe/override it. `strip` optionally deletes an inline range
 * first (a slash plugin passes its "/filter" trigger range as a {@link DocRange}).
 */
export const CONVERT_BLOCK = action<{
  type: Block["type"];
  strip?: DocRange;
}>("convert-block", (c: ChangeApi, { type, strip }) => {
  if (strip) c.deleteRange(strip);
  c.setBlock({ type });
});

// ─── Text input ──────────────────────────────────────────────────────────────

/**
 * Insert a string at the caret (or over the selection). Wraps `insertText` —
 * used by the Space branch (payload `" "`) and the default single-character
 * branch (payload the typed key). Emits the resulting CRDT text/format ops.
 */
export const INSERT_TEXT = stateAction<{ text: string }>(
  "insert-text",
  (state, { text }) => {
    const result = insertText(state, text);
    return { state: result.state, ops: result.ops };
  },
);

// ─── Deletion (Backspace / Delete, with Ctrl word variants) ──────────────────
//
// Each delete also clears the auto-created-paragraph tracking afterwards, just
// as the inline handler did, so the tracking can't outlive the block it points
// at.

/**
 * Stable context for a backward deletion at a block boundary. IDs let handlers
 * re-resolve against the threaded state; indexes are included for convenient
 * cursor and view decisions.
 */
export interface BlockBoundaryContext {
  readonly currentBlockId: string;
  readonly currentBlockIndex: number;
  readonly previousBlockId: string;
  readonly previousBlockIndex: number;
}

function backwardBoundaryContext(
  state: EditorState,
): BlockBoundaryContext | null {
  const cursor = state.document.cursor;
  if (
    !cursor ||
    cursor.position.textIndex !== 0 ||
    state.ui.composition ||
    (state.document.selection && !state.document.selection.isCollapsed)
  ) {
    return null;
  }

  const currentBlockIndex = cursor.position.blockIndex;
  const currentBlock = state.document.page.blocks[currentBlockIndex];
  if (!currentBlock || currentBlock.deleted) return null;
  const previousBlockIndex = findPreviousVisibleBlockIndex(
    state.document.page.blocks,
    currentBlockIndex,
  );
  if (previousBlockIndex === null) return null;
  const previousBlock = state.document.page.blocks[previousBlockIndex];
  if (!previousBlock || previousBlock.deleted) return null;

  return {
    currentBlockId: currentBlock.id,
    currentBlockIndex,
    previousBlockId: previousBlock.id,
    previousBlockIndex,
  };
}

function sameBoundary(
  left: BlockBoundaryContext | null,
  right: BlockBoundaryContext,
): boolean {
  return (
    left !== null &&
    left.currentBlockId === right.currentBlockId &&
    left.currentBlockIndex === right.currentBlockIndex &&
    left.previousBlockId === right.previousBlockId &&
    left.previousBlockIndex === right.previousBlockIndex
  );
}

/**
 * Semantic boundary action emitted by Backspace at offset zero when a previous
 * visible block exists. Nodes and consumers may claim this to define their own
 * cross-block behavior; the default preserves the editor's generic merge,
 * outdent, conversion, and atomic-block handling.
 */
export const JOIN_WITH_PREVIOUS_BLOCK = stateAction<BlockBoundaryContext>(
  "join-with-previous-block",
  (state, boundary) => {
    // The action is public and may be dispatched directly. Reject stale or
    // fabricated contexts instead of letting its fallback delete unrelated
    // content after the document or caret has moved.
    if (!sameBoundary(backwardBoundaryContext(state), boundary)) {
      return { state, ops: [] };
    }
    const result = deleteText(state);
    return { state: result.state, ops: result.ops };
  },
);

/**
 * Default reusable implementation for a node that joins into the previous
 * block. Passing a mark converts all transferred content to that inline form.
 */
export function joinWithPreviousBlock(
  state: EditorState,
  boundary: BlockBoundaryContext,
  mark?: Mark,
): StateResult | null {
  if (!sameBoundary(backwardBoundaryContext(state), boundary)) return null;
  const source = findBlock(state.document.page, boundary.currentBlockId);
  const target = findBlock(state.document.page, boundary.previousBlockId);
  if (!source || source.deleted || !target || target.deleted) return null;
  if (!isTextualBlock(source) || !isTextualBlock(target)) return null;

  const joined = mergeBlocksOps(
    state.document.page,
    source,
    target,
    state.CRDTbinding,
    false,
  );
  let newPage = joined.newPage;
  const ops = [...joined.ops];
  if (mark && joined.insertedRange) {
    const { blockId, from, to } = joined.insertedRange;
    const marked = markCharsInRange(
      newPage,
      blockId,
      from,
      to,
      mark,
      true,
      state.CRDTbinding,
    );
    newPage = marked.newPage;
    ops.push(marked.op);
  }

  const survivingBlockIndex = newPage.blocks.findIndex(
    (block) => block.id === target.id && !block.deleted,
  );
  if (survivingBlockIndex === -1) return null;
  const survivingBlock = newPage.blocks[survivingBlockIndex];
  invalidateBlockCache(survivingBlock);
  const next = moveCursorToPosition(
    {
      ...state,
      document: { ...state.document, page: newPage },
    },
    survivingBlockIndex,
    joined.joinPoint,
  );
  return { state: next, ops };
}

/** Delete backward one position / the selection (Backspace). */
export const DELETE_BACKWARD = stateAction("delete-backward", (state) => {
  const boundary = backwardBoundaryContext(state);
  const result = boundary
    ? state.actionBus.dispatchState(JOIN_WITH_PREVIOUS_BLOCK, state, boundary)
    : deleteText(state);
  return { state: clearAutoCreatedParagraph(result.state), ops: result.ops };
});

/** Delete backward to the previous word boundary (Ctrl/Cmd+Backspace). */
export const DELETE_WORD_BACKWARD = stateAction(
  "delete-word-backward",
  (state) => {
    const result = deleteWordBackward(state);
    return { state: clearAutoCreatedParagraph(result.state), ops: result.ops };
  },
);

/** Delete forward one position / the selection (Delete). */
export const DELETE_FORWARD = stateAction("delete-forward", (state) => {
  const result = deleteForward(state);
  return { state: clearAutoCreatedParagraph(result.state), ops: result.ops };
});

/** Delete forward to the next word boundary (Ctrl/Cmd+Delete). */
export const DELETE_WORD_FORWARD = stateAction(
  "delete-word-forward",
  (state) => {
    const result = deleteWordForward(state);
    return { state: clearAutoCreatedParagraph(result.state), ops: result.ops };
  },
);

// ─── Block structure ─────────────────────────────────────────────────────────

/**
 * Split the current block at the caret (Enter), then clear the auto-created
 * paragraph tracking just as the inline handler did.
 */
export const SPLIT_BLOCK = stateAction("split-block", (state) => {
  const result = splitBlock(state);
  return { state: clearAutoCreatedParagraph(result.state), ops: result.ops };
});

// The list indent/outdent actions (INDENT_LIST_ITEM / OUTDENT_LIST_ITEM) and the
// mark toggles (TOGGLE_STRONG, …) are co-located with the node/mark they act on:
// see `nodes/ListNode.ts` and `rendering/marks/*Mark.ts`.

// ─── Selection ───────────────────────────────────────────────────────────────

/** Select the whole document (Ctrl/Cmd+A). Pure selection change, no ops. */
export const SELECT_ALL = stateAction("select-all", (state) => ({
  state: selectAll(state),
  ops: [],
}));

/** Collapse any active selection to the caret (Escape). Pure, no ops. */
export const CLEAR_SELECTION = stateAction("clear-selection", (state) => ({
  state: clearSelection(state),
  ops: [],
}));

// ─── Shared arrow-key edge helpers ───────────────────────────────────────────
//
// The six non-shift arrow/page branches in `keysEvents.ts` (ArrowLeft,
// ArrowRight, ArrowUp, ArrowDown, PageUp, PageDown) each used to copy-paste two
// blocks of logic verbatim. These helpers hold the single implementation; the
// branches feed them the values they compute differently (e.g. how "first
// block" or selection direction is derived) and act on the result.

/**
 * After a caret move, run the two trailing effects every non-shift arrow/page
 * branch shared:
 *  1. if the caret landed on a visual (non-textual) block, select that block;
 *  2. clear auto-created-paragraph tracking if the caret moved off the tracked
 *     block.
 *
 * `prevState` is the pre-move state (the source of `autoCreatedParagraph`);
 * `newState` is the post-move state. Pure cursor/selection effect — no ops.
 */
export function selectVisualBlockAfterMove(
  prevState: EditorState,
  newState: EditorState,
): EditorState {
  if (newState.document.cursor) {
    const targetBlock =
      newState.document.page.blocks[
        newState.document.cursor.position.blockIndex
      ];
    if (targetBlock && !isTextualBlock(targetBlock)) {
      const visualBlockPosition = {
        blockIndex: newState.document.cursor.position.blockIndex,
        textIndex: 0,
      };
      newState = {
        ...newState,
        document: {
          ...newState.document,
          selection: {
            anchor: visualBlockPosition,
            focus: visualBlockPosition,
            isForward: true,
            isCollapsed: false,
            lastUpdate: Date.now(),
          },
        },
      };
    }

    // Clear auto-created paragraph tracking only if we moved away from it
    if (
      prevState.ui.autoCreatedParagraph &&
      newState.document.cursor &&
      newState.document.cursor.position.blockIndex !==
        prevState.ui.autoCreatedParagraph.blockIndex
    ) {
      newState = clearAutoCreatedParagraph(newState);
    }
  }
  return newState;
}

/**
 * Outcome of an edge helper. `kind: "break"` means the helper handled the
 * keypress (the caller should stop and commit `state`/`ops`); `kind:
 * "fallthrough"` means no edge case applied (the caller proceeds with its
 * normal move). The `ops` carry the `block_insert` / `block_delete` the helper
 * emitted, to be appended to the handler's op list.
 */
export type EdgeOutcome =
  | { kind: "break"; state: EditorState; ops: Operation[] }
  | { kind: "fallthrough" };

/**
 * Auto-create an empty paragraph *above* a visual block sitting at the document
 * edge, then move the caret into it. Shared by ArrowLeft (no tracking),
 * ArrowUp / PageUp (tracking). The caller passes:
 *  - `isFirstBlock` — its own notion of "the visual block is first" (ArrowLeft
 *    compares ids against the first visible block; ArrowUp/PageUp test index 0);
 *  - `currentBlock` — the block the caret is on;
 *  - `track` — whether to record the new paragraph in `autoCreatedParagraph`
 *    (ArrowUp/PageUp do; ArrowLeft does not).
 *
 * Returns `fallthrough` unless the edge applies.
 */
export function createParagraphAbove(
  state: EditorState,
  isFirstBlock: boolean,
  currentBlock: Block | undefined,
  track: boolean,
): EdgeOutcome {
  if (!(isFirstBlock && currentBlock && !isTextualBlock(currentBlock))) {
    return { kind: "fallthrough" };
  }

  const ops: Operation[] = [];

  // Create a new paragraph above the visual block
  const newParagraphId = state.CRDTbinding.nextId();
  const newParagraph: Block = {
    id: newParagraphId,
    afterId: null,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };

  const blockInsertOp: Operation = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    afterBlockId: null,
    blockId: newParagraphId,
    blockType: "paragraph",
  };

  const newBlocks = [newParagraph, ...state.document.page.blocks];
  const newPage = { ...state.document.page, blocks: newBlocks };

  let newState: EditorState = track
    ? {
        ...state,
        document: { ...state.document, page: newPage },
        ui: {
          ...state.ui,
          autoCreatedParagraph: {
            blockIndex: 0,
            blockId: newParagraph.id,
          },
        },
      }
    : {
        ...state,
        document: { ...state.document, page: newPage },
      };

  // Broadcast the operation
  ops.push(blockInsertOp);

  newState = clearSelection(newState);
  newState = moveCursorToPosition(newState, 0, 0);

  return { kind: "break", state: newState, ops };
}

/**
 * Auto-create an empty paragraph *below* a visual block sitting at the document
 * edge, then move the caret into it. Shared, identically, by ArrowRight,
 * ArrowDown and PageDown (none of which set tracking). `isLastBlock` /
 * `currentBlock` are the caller's edge test. Returns `fallthrough` unless the
 * edge applies.
 */
export function createParagraphBelow(
  state: EditorState,
  isLastBlock: boolean,
  currentBlock: Block | undefined,
): EdgeOutcome {
  if (!(isLastBlock && currentBlock && !isTextualBlock(currentBlock))) {
    return { kind: "fallthrough" };
  }

  const ops: Operation[] = [];

  // Create a new paragraph below the visual block
  const newParagraphId = state.CRDTbinding.nextId();
  const newParagraph: Block = {
    id: newParagraphId,
    afterId: currentBlock.id,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };

  const blockInsertOp: Operation = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    afterBlockId: currentBlock.id,
    blockId: newParagraphId,
    blockType: "paragraph",
  };

  const newBlocks = [...state.document.page.blocks, newParagraph];
  const newPage = { ...state.document.page, blocks: newBlocks };

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };
  newState = clearSelection(newState);
  newState = moveCursorToPosition(newState, newBlocks.length - 1, 0);

  // Broadcast the operation
  ops.push(blockInsertOp);

  return { kind: "break", state: newState, ops };
}

/**
 * Remove the empty auto-created paragraph the caret is sitting on, then move to
 * (and select) the visual block that was below it. Shared by ArrowLeft,
 * ArrowRight, ArrowDown and PageDown.
 *
 * `requireDirection` gates the emptiness check on the paragraph's text
 * direction: ArrowLeft passes `"rtl"` (left = forward in RTL), ArrowRight passes
 * `"ltr"` (right = forward in LTR), and ArrowDown / PageDown pass `null` (no
 * direction constraint). Returns `fallthrough` unless the paragraph matches.
 */
export function removeAutoCreatedParagraph(
  state: EditorState,
  requireDirection: "rtl" | "ltr" | null,
): EdgeOutcome {
  if (!(state.ui.autoCreatedParagraph && state.document.cursor)) {
    return { kind: "fallthrough" };
  }

  const { blockIndex, blockId } = state.ui.autoCreatedParagraph;
  const currentBlock =
    state.document.page.blocks[state.document.cursor.position.blockIndex];

  // Cursor must be on the auto-created paragraph and it must still be empty
  // (and, when required, of the matching text direction).
  const matches =
    state.document.cursor.position.blockIndex === blockIndex &&
    currentBlock?.id === blockId &&
    currentBlock.type === "paragraph" &&
    isTextualBlock(currentBlock) &&
    getBlockTextContent(currentBlock) === "" &&
    (requireDirection === null ||
      getTextDirection(getBlockTextContent(currentBlock)) === requireDirection);

  if (!matches) {
    return { kind: "fallthrough" };
  }

  const ops: Operation[] = [];

  // Remove the auto-created paragraph and move to the image below
  const blockToDelete = state.document.page.blocks[blockIndex];

  const blockDeleteOp: Operation = {
    op: "block_delete",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId: blockToDelete.id,
  };
  ops.push(blockDeleteOp);

  const newBlocks = state.document.page.blocks.filter(
    (_, i) => i !== blockIndex,
  );
  const newPage = { ...state.document.page, blocks: newBlocks };

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
    ui: {
      ...state.ui,
      autoCreatedParagraph: null,
    },
  };

  // Broadcast the operation
  // Move cursor to the visual block that was below
  newState = clearSelection(newState);
  newState = moveCursorToPosition(newState, 0, 0);

  // Select the visual block (image/line)
  const visibleBlocks = newState.view.visibleBlocks;
  const firstBlock = visibleBlocks.length > 0 ? visibleBlocks[0] : null;
  if (firstBlock && !isTextualBlock(firstBlock)) {
    newState = {
      ...newState,
      document: {
        ...newState.document,
        selection: {
          anchor: { blockIndex: 0, textIndex: 0 },
          focus: { blockIndex: 0, textIndex: 0 },
          isForward: true,
          isCollapsed: false,
          lastUpdate: Date.now(),
        },
      },
    };
  }

  return { kind: "break", state: newState, ops };
}
