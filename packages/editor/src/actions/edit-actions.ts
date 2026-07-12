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
 * {@link createParagraphBelow}, and the self-contained-block escapes
 * {@link escapeAboveSelfContainedBlock} / {@link escapeBelowSelfContainedBlock})
 * that the arrow/page branches used to copy-paste verbatim — extracted so they
 * share one implementation.
 */

import {
  action,
  type ActionBus,
  CONTENT_DELETED,
  stateAction,
  type StateResult,
} from "../action-bus";
import type { ChangeApi, DocRange } from "../entries/editor";
import { invalidateBlockCache } from "../rendering/renderer";
import type { AnySchemaDefinition } from "../schema-types";
import {
  caretAtBlockBottom,
  caretAtBlockTop,
  clearSelection,
  isPointAboveContent,
  isPointBelowContent,
  moveCursorToPosition,
} from "../selection";
import type { Block, Mark } from "../serlization/loadPage";
import type { EditorState, Operation, ViewportState } from "../state-types";
import { getBlockTextContent } from "../state-utils";
import { findBlock } from "../sync/block-lookup";
import {
  isPreformattedType,
  isSelfContained,
  isTextualBlock,
} from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { markCharsInRange, orderKeyAfter } from "../sync/crdt-utils";
import { applyOps, findPreviousVisibleBlockIndex } from "../sync/reducer";
import {
  deleteForward,
  deleteText,
  deleteWordBackward,
  deleteWordForward,
  insertText,
  mergeBlocksOps,
  moveBlock,
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
  type: string;
  strip?: DocRange;
}>("convert-block", (c: ChangeApi, { type, strip }) => {
  if (strip) c.deleteRange(strip);
  // The action vocabulary is schema-open: optional/custom feature types are
  // validated by the receiving editor's runtime schema. Erase the base-schema
  // default only at this internal dispatch boundary.
  (c as ChangeApi<AnySchemaDefinition>).setBlock({ type });
});

// ─── Text input ──────────────────────────────────────────────────────────────

/**
 * Insert a string at the caret (or over the selection). Wraps `insertText` —
 * used by the Space branch (payload `" "`) and the default single-character
 * branch (payload the typed key). Emits the resulting CRDT text/format ops.
 *
 * This is the *typing* path, so it opts into selection wrapping: a typed
 * bracket/quote or markdown delimiter over a held selection encloses it
 * (literally, or by applying the delimiter's mark) instead of replacing it —
 * see `wrap-selection.ts`. Direct `insertText` callers (IME commit, hosts)
 * keep plain replace semantics.
 */
export const INSERT_TEXT = stateAction<{ text: string }>(
  "insert-text",
  (state, { text }) => {
    const result = insertText(state, text, { wrapSelection: true });
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

  // A single-block surface never merges its block into a neighbour outside the
  // window — Backspace at offset 0 has no "previous block" to join, so the
  // boundary is treated as the document edge.
  if (state.view.window?.singleBlock) return null;

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
    const selected = selectPreviousContainedBlockAtBoundary(state, boundary);
    if (selected) return selected;
    const result = deleteText(state);
    return { state: result.state, ops: result.ops };
  },
);

function selectPreviousContainedBlockAtBoundary(
  state: EditorState,
  boundary: BlockBoundaryContext,
): StateResult | null {
  const currentBlock = state.document.page.blocks[boundary.currentBlockIndex];
  const previousBlock = state.document.page.blocks[boundary.previousBlockIndex];
  if (
    !currentBlock ||
    currentBlock.deleted ||
    !previousBlock ||
    previousBlock.deleted ||
    !isTextualBlock(currentBlock) ||
    !isPreformattedType(previousBlock.type)
  ) {
    return null;
  }

  const ops: Operation[] = [];
  let next = state;
  if (getBlockTextContent(currentBlock).length === 0) {
    const blockDeleteOp: Operation = {
      op: "block_delete",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: currentBlock.id,
    };
    ops.push(blockDeleteOp);
    next = {
      ...next,
      document: {
        ...next.document,
        page: applyOps(next.document.page, [blockDeleteOp], state.schema),
      },
    };
  }

  const position = { blockIndex: boundary.previousBlockIndex, textIndex: 0 };
  next = moveCursorToPosition(next, position.blockIndex, position.textIndex);
  next = {
    ...next,
    document: {
      ...next.document,
      selection: {
        anchor: position,
        focus: position,
        isForward: true,
        isCollapsed: false,
        lastUpdate: Date.now(),
      },
    },
  };

  return { state: next, ops };
}

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
    state.schema,
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

/**
 * Fire the post-delete {@link CONTENT_DELETED} normalization on the result of a
 * deletion, folding any ops an observer emits into the same transaction (one
 * undo entry / broadcast) — the Backspace/Delete counterpart to the
 * {@link TEXT_INPUTTED} pass `insertText` runs. No-ops when the caret is gone.
 */
function withContentDeleted(result: StateResult): StateResult {
  const pos = result.state.document.cursor?.position;
  if (!pos) return result;
  const settled = result.state.actionBus.dispatchState(
    CONTENT_DELETED,
    result.state,
    { blockIndex: pos.blockIndex, textIndex: pos.textIndex },
  );
  return { state: settled.state, ops: [...result.ops, ...settled.ops] };
}

/** Delete backward one position / the selection (Backspace). */
export const DELETE_BACKWARD = stateAction("delete-backward", (state) => {
  const boundary = backwardBoundaryContext(state);
  const result = boundary
    ? state.actionBus.dispatchState(JOIN_WITH_PREVIOUS_BLOCK, state, boundary)
    : deleteText(state);
  return withContentDeleted(result);
});

/**
 * Make Backspace at the very start of an *empty* block exit it to a plain
 * paragraph instead of merging it into the previous block. Custom text blocks
 * (quote, code, …) opt in from their own `registerActions` by passing the block
 * types they own; once a block has content the normal cross-block join applies.
 *
 * Claims {@link DELETE_BACKWARD} directly at priority 50 (ahead of the default
 * boundary join) so it also fires when the block is the first visible one and
 * has no previous block to merge into.
 */
export function registerEmptyBlockBackspaceExit(
  bus: ActionBus,
  types: readonly string[],
): void {
  bus.registerState(
    DELETE_BACKWARD,
    (state) => {
      const cursor = state.document.cursor;
      if (!cursor || cursor.position.textIndex !== 0) return;
      if (state.ui.composition) return;
      if (state.document.selection && !state.document.selection.isCollapsed) {
        return;
      }

      const blockIndex = cursor.position.blockIndex;
      const block = state.document.page.blocks[blockIndex];
      if (!block || block.deleted || !isTextualBlock(block)) return;
      if (!types.includes(block.type)) return;
      if (getVisibleTextFromRuns(block.charRuns).length !== 0) return;

      const op: Operation = {
        op: "block_set",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId: block.id,
        field: "type",
        value: "paragraph",
      };
      const page = applyOps(state.document.page, [op], state.schema);
      invalidateBlockCache(page.blocks[blockIndex]);
      const next = clearSelection(state);
      return {
        state: { ...next, document: { ...next.document, page } },
        ops: [op],
        handled: true,
      };
    },
    50,
  );
}

/** Delete backward to the previous word boundary (Ctrl/Cmd+Backspace). */
export const DELETE_WORD_BACKWARD = stateAction(
  "delete-word-backward",
  (state) => withContentDeleted(deleteWordBackward(state)),
);

/** Delete forward one position / the selection (Delete). */
export const DELETE_FORWARD = stateAction("delete-forward", (state) =>
  withContentDeleted(deleteForward(state)),
);

/** Delete forward to the next word boundary (Ctrl/Cmd+Delete). */
export const DELETE_WORD_FORWARD = stateAction("delete-word-forward", (state) =>
  withContentDeleted(deleteWordForward(state)),
);

// ─── Block structure ─────────────────────────────────────────────────────────

/** Split the current block at the caret (Enter). */
export const SPLIT_BLOCK = stateAction("split-block", (state) => {
  const result = splitBlock(state);
  return { state: result.state, ops: result.ops };
});

/**
 * Reposition a block to sit immediately after `afterBlockId` (null = head),
 * emitting a single `block_set` of the block's fractional-index `orderKey`. The
 * dispatchable form of {@link moveBlock} so hosts/plugins (e.g. a
 * drag-to-reorder gesture) can drive and observe block moves without reaching
 * into the engine.
 */
export const MOVE_BLOCK = stateAction<{
  blockId: string;
  afterBlockId: string | null;
}>("move-block", (state, { blockId, afterBlockId }) =>
  moveBlock(state, blockId, afterBlockId),
);

// Re-exported alongside its StateAction so a host can call the pure transform
// directly, mirroring `joinWithPreviousBlock` / `JOIN_WITH_PREVIOUS_BLOCK`.
export { moveBlock } from "./actions";

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
 * After a caret move, if the caret landed on a visual (non-textual) block,
 * select that block. Pure cursor/selection effect — no ops.
 */
export function selectVisualBlockAfterMove(newState: EditorState): EditorState {
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
 * Auto-create an empty paragraph *above* a *visual* block sitting at the document
 * edge, then move the caret into it. Shared, identically, by ArrowLeft, ArrowUp
 * and PageUp. `isFirstBlock` / `currentBlock` are the caller's edge test (ArrowLeft
 * compares ids against the first visible block; ArrowUp/PageUp test index 0).
 *
 * Only visual void blocks (image / line) escape here, so it applies to horizontal
 * *and* vertical moves alike. The vertical-only escape for self-contained text
 * blocks (code / math / quote) lives in {@link escapeAboveSelfContainedBlock}.
 * Returns `fallthrough` unless the edge applies.
 */
export function createParagraphAbove(
  state: EditorState,
  isFirstBlock: boolean,
  currentBlock: Block | undefined,
): EdgeOutcome {
  if (!(isFirstBlock && currentBlock && !isTextualBlock(currentBlock))) {
    return { kind: "fallthrough" };
  }
  return prependLeadingParagraph(state);
}

/**
 * Append an empty paragraph after `afterBlock` (assumed to be the last block),
 * move the caret into it, and emit the `block_insert`. The shared body behind
 * every "escape into a trailing paragraph" edge; callers do the gating. Always
 * returns `break`.
 */
function appendTrailingParagraph(
  state: EditorState,
  afterBlock: Block,
): EdgeOutcome {
  const ops: Operation[] = [];

  const newParagraphId = state.CRDTbinding.nextId();
  const orderKey = orderKeyAfter(state.document.page.blocks, afterBlock.id);
  const newParagraph: Block = {
    id: newParagraphId,
    orderKey,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };

  const blockInsertOp: Operation = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    orderKey,
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
 * Prepend an empty paragraph at the head of the document (before the current
 * first block), move the caret into it, and emit the `block_insert`. The
 * upward-escape counterpart to {@link appendTrailingParagraph}; callers do the
 * gating. Always returns `break`.
 */
function prependLeadingParagraph(state: EditorState): EdgeOutcome {
  const ops: Operation[] = [];

  const newParagraphId = state.CRDTbinding.nextId();
  const orderKey = orderKeyAfter(state.document.page.blocks, null);
  const newParagraph: Block = {
    id: newParagraphId,
    orderKey,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };

  const blockInsertOp: Operation = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    orderKey,
    blockId: newParagraphId,
    blockType: "paragraph",
  };

  const newBlocks = [newParagraph, ...state.document.page.blocks];
  const newPage = { ...state.document.page, blocks: newBlocks };

  let newState: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };
  newState = clearSelection(newState);
  newState = moveCursorToPosition(newState, 0, 0);

  // Broadcast the operation
  ops.push(blockInsertOp);

  return { kind: "break", state: newState, ops };
}

/**
 * Auto-create an empty paragraph *below* a *visual* block sitting at the
 * document edge, then move the caret into it. Shared, identically, by ArrowRight,
 * ArrowDown and PageDown (none of which set tracking). `isLastBlock` /
 * `currentBlock` are the caller's edge test.
 *
 * Only visual void blocks (image / line) — which have no continuable text —
 * escape here, so it applies to horizontal *and* vertical moves alike. The
 * vertical-only escape for self-contained text blocks (code / math / quote)
 * lives in {@link escapeBelowSelfContainedBlock}. Returns `fallthrough` unless
 * the edge applies.
 */
export function createParagraphBelow(
  state: EditorState,
  isLastBlock: boolean,
  currentBlock: Block | undefined,
): EdgeOutcome {
  if (!(isLastBlock && currentBlock && !isTextualBlock(currentBlock))) {
    return { kind: "fallthrough" };
  }
  return appendTrailingParagraph(state, currentBlock);
}

/**
 * Vertical-move counterpart to {@link createParagraphBelow} for *text* blocks:
 * when the caret is on the last line of a trailing self-contained block
 * (`selfContained` — code / math / quote), ArrowDown / PageDown start a fresh
 * paragraph below and move into it instead of clamping to the block's end. The
 * last-line gate (`viewport` sizes the line layout) means an inner ArrowDown
 * still steps between the block's own lines first. Kept separate from the
 * horizontal escape so ArrowRight inside such a block keeps moving through its
 * text. Returns `fallthrough` unless the edge applies.
 */
export function escapeBelowSelfContainedBlock(
  state: EditorState,
  isLastBlock: boolean,
  currentBlock: Block | undefined,
  viewport: ViewportState,
): EdgeOutcome {
  if (
    !(
      isLastBlock &&
      currentBlock &&
      isTextualBlock(currentBlock) &&
      isSelfContained(currentBlock) &&
      caretAtBlockBottom(state, viewport)
    )
  ) {
    return { kind: "fallthrough" };
  }
  return appendTrailingParagraph(state, currentBlock);
}

/**
 * Upward mirror of {@link escapeBelowSelfContainedBlock}: when the caret is on
 * the first line of a leading self-contained block (`selfContained` — code /
 * math / quote), ArrowUp / PageUp start a fresh paragraph above and move into it
 * instead of clamping to the block's start. The first-line gate means an inner
 * ArrowUp still steps between the block's own lines first. Returns `fallthrough`
 * unless the edge applies.
 */
export function escapeAboveSelfContainedBlock(
  state: EditorState,
  isFirstBlock: boolean,
  currentBlock: Block | undefined,
  viewport: ViewportState,
): EdgeOutcome {
  if (
    !(
      isFirstBlock &&
      currentBlock &&
      isTextualBlock(currentBlock) &&
      isSelfContained(currentBlock) &&
      caretAtBlockTop(state, viewport)
    )
  ) {
    return { kind: "fallthrough" };
  }
  return prependLeadingParagraph(state);
}

/**
 * Pointer counterpart to {@link escapeBelowSelfContainedBlock}: a click/tap in
 * the empty area below the last block, when that block is a self-contained text
 * block (`selfContained` — code / math / quote), starts a fresh trailing
 * paragraph and places the caret there instead of clamping it to the block's
 * end. Clicks that land on the block's own content fall through (`canvasY` is
 * tested against the content's bottom edge). Visual void blocks keep their
 * existing node-level click handling and are not considered here. Returns
 * `fallthrough` unless the edge applies.
 */
export function createParagraphBelowOnClick(
  state: EditorState,
  canvasY: number,
  viewport: ViewportState,
): EdgeOutcome {
  const visibleBlocks = state.view.visibleBlocks;
  if (visibleBlocks.length === 0) return { kind: "fallthrough" };

  const lastVisible = visibleBlocks[visibleBlocks.length - 1];
  const lastBlock = state.document.page.blocks[lastVisible.originalIndex];
  if (!lastBlock || !isSelfContained(lastBlock)) return { kind: "fallthrough" };
  if (!isPointBelowContent(canvasY, state, viewport)) {
    return { kind: "fallthrough" };
  }

  return appendTrailingParagraph(state, lastBlock);
}

/**
 * Upward mirror of {@link createParagraphBelowOnClick}: a click/tap in the empty
 * area above the first block (the top padding), when that block is a
 * self-contained text block (`selfContained` — code / math / quote), starts a
 * fresh leading paragraph and places the caret there. Returns `fallthrough`
 * unless the edge applies.
 */
export function createParagraphAboveOnClick(
  state: EditorState,
  canvasY: number,
  viewport: ViewportState,
): EdgeOutcome {
  const visibleBlocks = state.view.visibleBlocks;
  if (visibleBlocks.length === 0) return { kind: "fallthrough" };

  const firstBlock = state.document.page.blocks[visibleBlocks[0].originalIndex];
  if (!firstBlock || !isSelfContained(firstBlock)) {
    return { kind: "fallthrough" };
  }
  if (!isPointAboveContent(canvasY, state, viewport)) {
    return { kind: "fallthrough" };
  }

  return prependLeadingParagraph(state);
}
