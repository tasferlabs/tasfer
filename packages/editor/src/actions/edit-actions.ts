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
import {
  contentAllowsRemove,
  contentInsertType,
  documentBlockTypes,
  visibleIndex,
} from "../schema-content";
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
import { findBlock, findBlockIndex } from "../sync/block-lookup";
import {
  escapesAtDocumentEdge,
  isPreformattedType,
  isSelfContained,
  isTextualBlock,
} from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { markCharsInRange, orderKeyAfter } from "../sync/crdt-utils";
import { applyOps } from "../sync/reducer";
import { previousBlockInWindow } from "../view-window";
import {
  deleteForward,
  deleteSelectedText,
  deleteText,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  deleteWordForward,
  insertText,
  mergeBlocksOps,
  moveBlock,
  moveBlocks,
  revertInputRule,
  selectAll,
  splitBlock,
} from "./actions";

// ─── Block conversion ─────────────────────────────────────────────────────────

/**
 * Change the block at the caret to another type, as one undo step. It is the
 * action form of {@link ChangeApi.setBlock}: dispatch it to change a block, and
 * other handlers can watch or override it. Pass `strip` to delete a text range
 * first, such as the "/filter" text a slash menu typed (a {@link DocRange}).
 *
 * ```ts
 * editor.dispatch(CONVERT_BLOCK, { type: "quote" });
 * ```
 *
 * @group Built-in actions
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
 * Insert one indent level (two spaces) at the caret. Dispatched from the Tab
 * key handler when the caret sits in a preformatted block — the capability gate
 * lives in `events/keysEvents`, so any block type that declares itself verbatim
 * gets this for free. A plain state action so a host can observe or override
 * the indent behavior per instance.
 */
export const INSERT_TAB = stateAction("insert-tab", (state) => {
  const r = insertText(state, "  ");
  return { state: r.state, ops: r.ops };
});

/**
 * Insert text at the caret, or in place of the selection. This is what typing
 * dispatches: Space and single-character keys send it with the typed text.
 *
 * When text is selected, typing a bracket, quote or Markdown delimiter wraps
 * the selection instead of replacing it. Brackets and quotes go around it. A
 * delimiter gives it its mark. To replace the selection with plain text, use
 * {@link ChangeApi.insertText}.
 *
 * @group Built-in actions
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
 * Where Backspace hit the start of a block: the current block and the block
 * above it, by id and by index. Use the ids to find the blocks again in the
 * latest state. The indexes are there for convenience.
 *
 * @group Actions
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
  // A block outside the view window counts as none: the window edge is this
  // editor's document start.
  const previousBlockIndex = previousBlockInWindow(
    state.view.window,
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
 * Backspace at the very start of a block dispatches this when there is a block
 * above. Claim it from a node to decide what joining into the block above means
 * for that node. The default does the editor's usual Backspace: it merges the
 * blocks, outdents, converts the block, or selects the block above when that
 * block is not text, such as an image. When `boundary` no longer matches the
 * caret, it does nothing.
 *
 * @group Built-in actions
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
 * Merge the current block into the block above. Use it in a node's own
 * {@link JOIN_WITH_PREVIOUS_BLOCK} handler. Pass a `mark` to give all the moved
 * text that mark. Returns `null` and changes nothing when `boundary` no longer
 * matches the caret, when either block is not a text block, or when the schema
 * does not allow removing the current block.
 *
 * @group Actions
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

  // The merge removes `source` from the document. Refuse it when that would
  // leave the block sequence unable to satisfy the schema's `content`
  // expression — Backspace at the boundary then just does nothing. No-op for a
  // schema with no expression.
  const sourceIndex = state.document.page.blocks.findIndex(
    (block) => block.id === source.id,
  );
  if (
    sourceIndex !== -1 &&
    !contentAllowsRemove(state, visibleIndex(state.document.page, sourceIndex))
  ) {
    return null;
  }

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

/**
 * Undo the Markdown shortcut the last keystroke triggered, and keep the typed
 * characters. For example, after `# ` turns a line into a heading, this turns
 * it back into the text `# `. Undo and Backspace try this first. When there is
 * nothing to take back, it makes no edits, and those keys do their usual job.
 *
 * @group Built-in actions
 */
export const REVERT_INPUT_RULE = stateAction(
  "revert-input-rule",
  (state) => revertInputRule(state) ?? { state, ops: [] },
);

/**
 * Delete backward one position / the selection (Backspace).
 *
 * @group Built-in actions
 */
export const DELETE_BACKWARD = stateAction("delete-backward", (state) => {
  const boundary = backwardBoundaryContext(state);
  const result = boundary
    ? state.actionBus.dispatchState(JOIN_WITH_PREVIOUS_BLOCK, state, boundary)
    : deleteText(state);
  return withContentDeleted(result);
});

/**
 * Make Backspace at the start of an empty block turn it into a plain paragraph,
 * instead of merging it into the block above. Call it from your node's
 * `registerActions` with the block types your node owns. Once the block has
 * text, Backspace merges as usual. It also works when the block is the first
 * one in the document. It handles {@link DELETE_BACKWARD} at priority 50.
 *
 * ```ts
 * registerActions(bus: ActionBus): void {
 *   registerEmptyBlockBackspaceExit(bus, this.types);
 * }
 * ```
 *
 * @group Actions
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

/**
 * Delete backward to the previous word boundary (Ctrl/Cmd+Backspace).
 *
 * @group Built-in actions
 */
export const DELETE_WORD_BACKWARD = stateAction(
  "delete-word-backward",
  (state) => withContentDeleted(deleteWordBackward(state)),
);

/**
 * Delete forward one position / the selection (Delete).
 *
 * @group Built-in actions
 */
export const DELETE_FORWARD = stateAction("delete-forward", (state) =>
  withContentDeleted(deleteForward(state)),
);

/**
 * Delete forward to the next word boundary (Ctrl/Cmd+Delete).
 *
 * @group Built-in actions
 */
export const DELETE_WORD_FORWARD = stateAction("delete-word-forward", (state) =>
  withContentDeleted(deleteWordForward(state)),
);

/**
 * Delete back to the line start (⌘+Backspace on macOS).
 *
 * @group Built-in actions
 */
export const DELETE_TO_LINE_START = stateAction(
  "delete-to-line-start",
  (state) => withContentDeleted(deleteToLineStart(state)),
);

/**
 * Delete forward to the line end (⌘+Delete / ⌃K on macOS).
 *
 * @group Built-in actions
 */
export const DELETE_TO_LINE_END = stateAction("delete-to-line-end", (state) =>
  withContentDeleted(deleteToLineEnd(state)),
);

// ─── Block structure ─────────────────────────────────────────────────────────

// Enter / Shift+Enter policy for every block type — what each key does when the
// block is empty or the caret is at its start, middle or end — is written down
// in `dev-docs/enter-key.md`. Every SPLIT_BLOCK / EXIT_BLOCK handler follows
// that table; change the table first when the policy changes.

/**
 * Split the current block at the caret (Enter). Blocks can handle Enter their
 * own way: a code block adds a new line, and a table moves down a row. Enter
 * on an empty heading, list item, quote or equation turns it into a paragraph.
 * Selected text is deleted first.
 *
 * @group Built-in actions
 */
export const SPLIT_BLOCK = stateAction("split-block", (state) => {
  const result = splitBlock(state);
  return { state: result.state, ops: result.ops };
});

/**
 * Leave the current block (Shift+Enter). A block that holds several lines of
 * its own — a code block, an equation, a table — claims this to start a
 * paragraph below from anywhere inside it. Every other block has nothing to
 * leave, so the default is the ordinary Enter split.
 *
 * @group Built-in actions
 */
export const EXIT_BLOCK = stateAction("exit-block", (state) => {
  const result = splitBlock(state);
  return { state: result.state, ops: result.ops };
});

/**
 * Make Enter and Shift+Enter over selected text delete that text first, the way
 * typing does. The block's own Enter handler then sees a plain caret. Every
 * editor registers this already.
 *
 * When a whole block is selected, Enter is left alone and adds a paragraph
 * below. When the selected text cannot be deleted (it cuts through a formula),
 * the key does nothing. Selections inside a table cell or a formula are left to
 * that block.
 */
export function registerBreakReplacesSelection(bus: ActionBus): void {
  const replace = (state: EditorState) => {
    const selection = state.document.selection;
    if (!selection || selection.isCollapsed || state.ui.composition) return;
    const { anchor, focus } = selection;
    if (
      anchor.blockIndex === focus.blockIndex &&
      anchor.textIndex === focus.textIndex
    ) {
      return;
    }
    const deleted = deleteSelectedText(state);
    // A range the delete refuses (it clips an atomic formula) must not reach a
    // split that would ignore it: swallow the key instead.
    const stillRanged =
      deleted.state.document.selection &&
      !deleted.state.document.selection.isCollapsed;
    if (deleted.ops.length === 0 || stillRanged) {
      return { state, ops: [], handled: true };
    }
    return { state: deleted.state, ops: deleted.ops };
  };
  bus.registerState(SPLIT_BLOCK, replace, 1000);
  bus.registerState(EXIT_BLOCK, replace, 1000);
}

/**
 * Insert an empty paragraph below (`side: "after"`) or above (`side: "before"`)
 * the block at `blockIndex`. With `caret: "new"`, the caret moves into the new
 * paragraph, as when Enter leaves a block. With `caret: "keep"`, the caret
 * stays where it was, as when Enter at the start of an equation pushes it down.
 * If the schema does not allow a paragraph there, the first allowed block type
 * is used. Returns `undefined` when no block is allowed there, or when the
 * block at `blockIndex` is missing or deleted.
 *
 * @group Actions
 */
// The shared body behind the Enter exits in dev-docs/enter-key.md, so the order
// key, schema clamp and caret hand-off live in one place.
export function insertParagraphBeside(
  state: EditorState,
  blockIndex: number,
  side: "before" | "after",
  caret: "new" | "keep",
): StateResult | undefined {
  const page = state.document.page;
  const block = page.blocks[blockIndex];
  if (!block || block.deleted) return undefined;

  const at = visibleIndex(page, blockIndex) + (side === "after" ? 1 : 0);
  const type = contentInsertType(state, at, "paragraph");
  if (type === undefined) return undefined;

  const previousId =
    side === "after" ? block.id : (page.blocks[blockIndex - 1]?.id ?? null);
  const newParagraphId = state.CRDTbinding.nextId();
  const op: Operation = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    orderKey: orderKeyAfter(page.blocks, previousId),
    blockId: newParagraphId,
    blockType: type as Block["type"],
  };
  // Replay the op so the paragraph lands where every replica sorts it (a
  // tombstone tied on a neighbour's orderKey shifts the position), then find
  // blocks by id instead of assuming an index.
  const newPage = applyOps(page, [op], state.schema);
  let next: EditorState = {
    ...state,
    document: { ...state.document, page: newPage },
  };
  if (caret === "new") {
    next = clearSelection(next);
    next = moveCursorToPosition(
      next,
      findBlockIndex(newPage, newParagraphId),
      0,
    );
  } else if (next.document.cursor) {
    // The flat caret addresses its block by index; follow the block it was in.
    const shifted = findBlockIndex(newPage, block.id);
    next = {
      ...next,
      document: {
        ...next.document,
        cursor: {
          ...next.document.cursor,
          position: { ...next.document.cursor.position, blockIndex: shifted },
        },
      },
    };
  }
  return { state: next, ops: [op] };
}

/**
 * Move a block so it sits right after `afterBlockId`. Pass `null` to move it to
 * the top of the document. It is the action form of {@link moveBlock}, so a
 * drag-to-reorder gesture can dispatch it and other handlers can watch block
 * moves. Nothing changes when the block is missing or already there, or when
 * `afterBlockId` is the block itself, missing or deleted.
 *
 * @group Built-in actions
 */
export const MOVE_BLOCK = stateAction<{
  blockId: string;
  afterBlockId: string | null;
}>("move-block", (state, { blockId, afterBlockId }) =>
  moveBlock(state, blockId, afterBlockId),
);

/**
 * Move several blocks so they sit right after `afterBlockId`. Pass `null` to
 * move them to the top of the document. They keep the order they have in the
 * document, not the order of `blockIds`. The gutter drag handle dispatches this
 * when the selection spans several lines. Nothing changes when `afterBlockId`
 * is one of the moved blocks, is missing or deleted, or the blocks are already
 * there.
 *
 * @group Built-in actions
 */
export const MOVE_BLOCKS = stateAction<{
  blockIds: readonly string[];
  afterBlockId: string | null;
}>("move-blocks", (state, { blockIds, afterBlockId }) =>
  moveBlocks(state, blockIds, afterBlockId),
);

// Re-exported alongside its StateAction so a host can call the pure transform
// directly, mirroring `joinWithPreviousBlock` / `JOIN_WITH_PREVIOUS_BLOCK`.
export { moveBlock, moveBlocks } from "./actions";

// The list indent/outdent actions (INDENT_LIST_ITEM / OUTDENT_LIST_ITEM) and the
// mark toggles (TOGGLE_STRONG, …) are co-located with the node/mark they act on:
// see `nodes/ListNode.ts` and `rendering/marks/*Mark.ts`.

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Select the whole document (Ctrl/Cmd+A). Pure selection change, no ops.
 *
 * @group Built-in actions
 */
export const SELECT_ALL = stateAction("select-all", (state) => ({
  state: selectAll(state),
  ops: [],
}));

/**
 * Collapse any active selection to the caret (Escape). Pure, no ops.
 *
 * @group Built-in actions
 */
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
 * What an edge helper, such as {@link appendTrailingParagraph}, did. These
 * helpers add an empty paragraph when the caret leaves a block at the edge of
 * the document.
 *
 * - `kind: "break"`: the helper handled the key or click. Stop, use its
 *   `state`, and add its `ops` to your own.
 * - `kind: "fallthrough"`: nothing applied. Do your normal move.
 *
 * @group Actions
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
 *
 * A live nested selection means the caret is inside a block that runs its own
 * caret model (a table cell), even though the flat cursor still names that
 * block. Its first row is not the document's edge, so the escape belongs to
 * that block's own handler, not here — see `exitTable` in `@tasfer/table`.
 */
export function createParagraphAbove(
  state: EditorState,
  isFirstBlock: boolean,
  currentBlock: Block | undefined,
): EdgeOutcome {
  if (state.document.contentSelection) return { kind: "fallthrough" };
  if (!(isFirstBlock && currentBlock && !isTextualBlock(currentBlock))) {
    return { kind: "fallthrough" };
  }
  return prependLeadingParagraph(state);
}

/**
 * Add an empty paragraph after `afterBlock`, which must be the last block, and
 * move the caret into it. Use it from a block that handles its own arrow keys,
 * like a table, when the caret moves past its end. You decide when to call it.
 *
 * If the schema does not allow a paragraph at the end, the first allowed block
 * type is used. Returns `fallthrough` and changes nothing when no block is
 * allowed there. Otherwise returns `break` with the new block's edit.
 *
 * @group Actions
 */
// Growing the paragraph here keeps one implementation of the schema clamp, the
// order key and the caret hand-off.
export function appendTrailingParagraph(
  state: EditorState,
  afterBlock: Block,
): EdgeOutcome {
  const ops: Operation[] = [];

  // Clamp the escape block to the document's shape: `paragraph` when the schema
  // has no `content` expression or permits one here, else the first type it does
  // permit at the tail, else no escape block at all (the edge stops being an
  // escape and the caret simply stays put).
  const type = contentInsertType(
    state,
    documentBlockTypes(state.document.page).length,
    "paragraph",
  );
  if (type === undefined) return { kind: "fallthrough" };

  const newParagraphId = state.CRDTbinding.nextId();
  const orderKey = orderKeyAfter(state.document.page.blocks, afterBlock.id);
  const newParagraph = state.schema.createDefaultBlock(
    type,
    newParagraphId,
    orderKey,
  );
  if (!newParagraph) return { kind: "fallthrough" };

  const blockInsertOp: Operation = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    orderKey,
    blockId: newParagraphId,
    blockType: type as Block["type"],
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
 * Add an empty paragraph at the top of the document and move the caret into it.
 * It works like {@link appendTrailingParagraph}: you decide when to call it,
 * and if the schema does not allow a paragraph at the top, the first allowed
 * block type is used. Returns `fallthrough` and changes nothing when no block
 * is allowed there. Otherwise returns `break`.
 *
 * @group Actions
 */
export function prependLeadingParagraph(state: EditorState): EdgeOutcome {
  const ops: Operation[] = [];

  // Same shape clamp as {@link appendTrailingParagraph}, at the head.
  const type = contentInsertType(state, 0, "paragraph");
  if (type === undefined) return { kind: "fallthrough" };

  const newParagraphId = state.CRDTbinding.nextId();
  const orderKey = orderKeyAfter(state.document.page.blocks, null);
  const newParagraph = state.schema.createDefaultBlock(
    type,
    newParagraphId,
    orderKey,
  );
  if (!newParagraph) return { kind: "fallthrough" };

  const blockInsertOp: Operation = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    orderKey,
    blockId: newParagraphId,
    blockType: type as Block["type"],
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
 *
 * Nested selections are left to their owner, for the reason given on
 * {@link createParagraphAbove}.
 */
export function createParagraphBelow(
  state: EditorState,
  isLastBlock: boolean,
  currentBlock: Block | undefined,
): EdgeOutcome {
  if (state.document.contentSelection) return { kind: "fallthrough" };
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
  if (!(
    isLastBlock &&
    currentBlock &&
    isTextualBlock(currentBlock) &&
    isSelfContained(currentBlock) &&
    caretAtBlockBottom(state, viewport)
  )) {
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
  if (!(
    isFirstBlock &&
    currentBlock &&
    isTextualBlock(currentBlock) &&
    isSelfContained(currentBlock) &&
    caretAtBlockTop(state, viewport)
  )) {
    return { kind: "fallthrough" };
  }
  return prependLeadingParagraph(state);
}

/**
 * Pointer counterpart to the keyboard escapes: a click/tap in the empty area
 * below the last block, when that block does not want the caret at its edge
 * (`escapesAtDocumentEdge` — the self-contained text blocks code / math / quote,
 * every non-textual block such as image / line / table, and any block a host
 * registers), starts a fresh trailing paragraph and places the caret there
 * instead of clamping it into the block.
 *
 * This is what keeps a document whose only block is a quote, an image or a
 * table writable: clicking the empty page below it gives you somewhere to type.
 * Clicks that land on the block's own content fall through (`canvasY` is tested
 * against the content's bottom edge), as do ordinary trailing paragraphs and
 * headings, whose end is a perfectly good place for the caret. Returns
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
  if (!lastBlock || !escapesAtDocumentEdge(lastBlock)) {
    return { kind: "fallthrough" };
  }
  if (!isPointBelowContent(canvasY, state, viewport)) {
    return { kind: "fallthrough" };
  }

  return appendTrailingParagraph(state, lastBlock);
}

/**
 * Upward mirror of {@link createParagraphBelowOnClick}: a click/tap in the empty
 * area above the first block (the top padding), when that block escapes at the
 * document edge, starts a fresh leading paragraph and places the caret there.
 * Returns `fallthrough` unless the edge applies.
 */
export function createParagraphAboveOnClick(
  state: EditorState,
  canvasY: number,
  viewport: ViewportState,
): EdgeOutcome {
  const visibleBlocks = state.view.visibleBlocks;
  if (visibleBlocks.length === 0) return { kind: "fallthrough" };

  const firstBlock = state.document.page.blocks[visibleBlocks[0].originalIndex];
  if (!firstBlock || !escapesAtDocumentEdge(firstBlock)) {
    return { kind: "fallthrough" };
  }
  if (!isPointAboveContent(canvasY, state, viewport)) {
    return { kind: "fallthrough" };
  }

  return prependLeadingParagraph(state);
}
