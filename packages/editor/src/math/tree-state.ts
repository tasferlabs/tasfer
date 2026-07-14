/** State/operation integration for the pure structured math tree editor. */

import type { FeatureInputRule } from "../feature-facets";
import { getBlockTextLength } from "../node-shared";
import { unambiguousMathCommandCompletion } from "../nodes/math-commands";
import type { MathBlock } from "../nodes/MathNode";
import { getBlockDirection } from "../rtl";
import {
  isNodeSelection,
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
} from "../selection";
import type { Block } from "../serlization/loadPage";
import type { ContentEdit, EditorState, Operation } from "../state-types";
import {
  contentPointsEqual,
  isContentSelectionCollapsed,
  normalizeContentSelection,
  updateContentSelection,
} from "../structured-selection";
import { findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { deleteCharsInRange, orderKeyAfter } from "../sync/crdt-utils";
import {
  applyOp,
  findNextVisibleBlockIndex,
  findPreviousVisibleBlockIndex,
} from "../sync/reducer";
import type {
  StructuredDocument,
  StructuredEdit,
  StructuredMutation,
} from "../sync/structured-content";
import { maxStructuredDocumentIdCounter } from "../sync/sync";
import {
  applyMathTreeCommandToDocument,
  applyMathTreeInputToDocument,
  deleteMathTreeInputFromDocument,
} from "./input-controller";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  mathContentIdForBlock,
  parseLegacyMathDocumentInit,
  structuredToMathDocument,
} from "./structured";
import {
  adjacentMathTreeConstructRange,
  type MathTreeCaret,
  type MathTreeEditFailure,
  type MathTreeEditResult,
  mathTreeMatrixTargetCaret,
  type MathTreeMotion,
  type MathTreeRange,
  moveMathTreeCaret,
  resizeMathTreeMatrix,
} from "./tree-edit";
import {
  contentPointToMathTreeCaret,
  extendMathTreeContentSelection,
  mathContentSelectionFromSourceOffset,
  mathSourceRangeFromContentSelection,
  mathTreeCaretFromSourceOffset,
  mathTreeCaretToContentSelection,
  moveMathTreeCaretVertically,
} from "./tree-selection";

interface MathTreeContext {
  readonly block: MathBlock;
  readonly blockIndex: number;
  readonly contentId: string;
  readonly document: StructuredDocument;
  readonly caret: MathTreeCaret;
  readonly range?: MathTreeRange;
  /** Visible compatibility source to tombstone on the next actual tree edit. */
  readonly legacyLength: number;
  readonly migration?: {
    readonly init: StructuredMutation;
  };
}

export interface MathTreeStateEditResult {
  readonly state: EditorState;
  readonly ops: Operation[];
  readonly handled: true;
  /** Tree authority claimed the action, but could not apply it losslessly. */
  readonly reason?: MathTreeEditFailure;
}

/** Edit an attachment that is already tree-authoritative in every math mode. */
export const mathTreeInputRule: FeatureInputRule = {
  id: "math.tree.input",
  phase: "before-insert",
  priority: 1_000,
  owns: ({ state }) =>
    activeMathTreeContext(state) !== undefined ||
    flatSelectionOwnsMathTree(state),
  apply: ({ state, input }) => {
    const context = activeMathTreeContext(state);
    if (context) return applyMathTreeInput(state, context, input);

    // A legacy flat range cannot be mapped back to stable tree endpoints
    // losslessly. Claim it so stale compatibility char runs never receive it;
    // native content selections are handled by the context above.
    return flatSelectionOwnsMathTree(state)
      ? { state, ops: [], handled: true }
      : undefined;
  },
};

/** Lazily create the tree for a legacy display block in opt-in rollout mode. */
export const mathTreeMigrationInputRule: FeatureInputRule = {
  id: "math.tree.migrate",
  phase: "before-insert",
  priority: 1_100,
  owns: ({ state }) => legacyMathTreeMutationTarget(state),
  apply: ({ state, input }) => {
    const context = prepareMathTreeMigration(state);
    if (context) return applyMathTreeInput(state, context, input);
    // A cross-block or otherwise unmappable legacy selection is still owned by
    // tree mode. Claim it instead of letting core replace a source substring.
    return legacyMathTreeMutationTarget(state)
      ? { state, ops: [], handled: true }
      : undefined;
  },
};

/** Move an already-active nested math caret without emitting document ops. */
export function moveActiveMathTreeCaret(
  state: EditorState,
  motion: MathTreeMotion,
): { state: EditorState; ops: Operation[]; handled: true } | undefined {
  const context = activeMathTreeContext(state);
  if (!context) return undefined;
  const moved = moveMathTreeCaret(context.document, context.caret, motion);
  if (moved.handled) return commitMathTreeResult(state, context, moved);
  // A selection whose focus is already at the equation edge still has to
  // collapse even though there is no further caret stop in this direction.
  const selection = state.document.contentSelection;
  return selection &&
    mathSourceRangeFromContentSelection(context.document, selection)
    ? commitMathTreeResult(state, context, {
        handled: true,
        edits: [],
        caret: context.caret,
      })
    : undefined;
}

/**
 * Continue horizontal host-document traversal after the structured equation's
 * root edge. Tree-backed display blocks keep an empty compatibility projection,
 * so the ordinary cursor mover treats offset zero as both block edges and can
 * advance directly to the adjacent visible block.
 */
export function exitActiveMathTreeHorizontally(
  state: EditorState,
  direction: "left" | "right",
): MathTreeStateEditResult | undefined {
  const context = activeMathTreeContext(state);
  if (!context) return undefined;
  const adjacentIndex =
    direction === "left"
      ? findPreviousVisibleBlockIndex(
          state.document.page.blocks,
          context.blockIndex,
        )
      : findNextVisibleBlockIndex(
          state.document.page.blocks,
          context.blockIndex,
        );
  if (adjacentIndex === null) {
    return createMathTreeEdgeParagraph(state, context, direction);
  }
  const flat = moveCursorToPosition(
    updateContentSelection(state, null),
    context.blockIndex,
    0,
  );
  return {
    state: direction === "left" ? moveCursorLeft(flat) : moveCursorRight(flat),
    ops: [],
    handled: true,
  };
}

/**
 * Enter an adjacent tree-authoritative display equation from a neighbouring
 * block, landing at the edge that faces the caret.
 *
 * A materialized equation keeps an EMPTY compatibility projection so that
 * {@link exitActiveMathTreeHorizontally} can treat its lone offset zero as both
 * block edges and step straight out. That same collapse breaks the reverse trip:
 * a plain cursor stepping in from the RIGHT lands on offset zero — the equation's
 * LEFT edge, before the whole formula — and then steps back out instead of
 * reaching the last cell (the reported "jumps to the start of the matrix").
 *
 * So when a collapsed compatibility caret sits at the edge of its block facing
 * the move and the adjacent visible block is a materialized equation, promote
 * directly to a structured caret at that equation's NEAR edge: moving left enters
 * at its right edge (source end), moving right at its left edge (offset zero).
 * The offset-zero (left) case matches where the old projection already landed, so
 * only the right-edge entry changes behavior; both now yield a real structured
 * caret rather than an ambiguous compatibility offset. Returns undefined for
 * anything else — a non-edge caret, an active range, an RTL block (whose visual
 * left is logical forward), or a non-math / not-yet-materialized neighbour — so
 * ordinary cursor movement is untouched.
 */
export function enterAdjacentMathTreeHorizontally(
  state: EditorState,
  direction: "left" | "right",
): MathTreeStateEditResult | undefined {
  // Only a plain, collapsed compatibility caret can bridge in; a live structured
  // caret or an open range is handled by the movers above.
  if (state.document.contentSelection) return undefined;
  const cursor = state.document.cursor;
  if (!cursor) return undefined;
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return undefined;
  }
  const { blockIndex, textIndex } = cursor.position;
  const currentBlock = state.document.page.blocks[blockIndex];
  if (!currentBlock || currentBlock.deleted) return undefined;
  // Visual left/right only equals logical back/forward in LTR; leave RTL blocks
  // to the ordinary mover so we never bridge on the wrong side.
  if (
    isTextualBlock(currentBlock) &&
    getBlockDirection(currentBlock, state.marks) === "rtl"
  ) {
    return undefined;
  }
  // The caret must sit on the block edge the move steps off of.
  const atEdge =
    direction === "left"
      ? textIndex === 0
      : textIndex === getBlockTextLength(currentBlock);
  if (!atEdge) return undefined;

  const adjacentIndex =
    direction === "left"
      ? findPreviousVisibleBlockIndex(state.document.page.blocks, blockIndex)
      : findNextVisibleBlockIndex(state.document.page.blocks, blockIndex);
  if (adjacentIndex === null) return undefined;
  const adjacent = state.document.page.blocks[adjacentIndex] as
    | Block
    | MathBlock
    | undefined;
  if (!adjacent || adjacent.deleted || adjacent.type !== "math") {
    return undefined;
  }
  const document = getMathStructuredDocument(adjacent);
  if (!document) return undefined;

  const source = getStructuredMathSource(adjacent) ?? "";
  const sourceOffset = direction === "left" ? source.length : 0;
  const selection = mathContentSelectionFromSourceOffset(
    adjacent.id,
    mathContentIdForBlock(adjacent.id),
    document,
    sourceOffset,
  );
  if (!selection) return undefined;
  return {
    state: updateContentSelection(state, selection),
    ops: [],
    handled: true,
  };
}

/**
 * Continue host-document traversal after vertical movement reaches the top or
 * bottom row of a structured display equation. Unlike the horizontal bridge,
 * this lands directly at the adjacent block's vertical edge: the end of the
 * previous block for ArrowUp, or the start of the next block for ArrowDown.
 */
export function exitActiveMathTreeVertically(
  state: EditorState,
  direction: "up" | "down",
): MathTreeStateEditResult | undefined {
  const context = activeMathTreeContext(state);
  if (!context) return undefined;
  const adjacentIndex =
    direction === "up"
      ? findPreviousVisibleBlockIndex(
          state.document.page.blocks,
          context.blockIndex,
        )
      : findNextVisibleBlockIndex(
          state.document.page.blocks,
          context.blockIndex,
        );
  if (adjacentIndex === null) {
    return createMathTreeEdgeParagraph(
      state,
      context,
      direction === "up" ? "left" : "right",
    );
  }

  const adjacent = state.document.page.blocks[adjacentIndex];
  const textIndex =
    direction === "up" && adjacent && !adjacent.deleted
      ? getBlockTextLength(adjacent)
      : 0;
  return {
    state: moveCursorToPosition(
      updateContentSelection(state, null),
      adjacentIndex,
      textIndex,
    ),
    ops: [],
    handled: true,
  };
}

/** Give a terminal structured equation a real outside caret target. */
function createMathTreeEdgeParagraph(
  state: EditorState,
  context: MathTreeContext,
  direction: "left" | "right",
): MathTreeStateEditResult {
  const paragraphId = state.CRDTbinding.nextId();
  const orderKey = orderKeyAfter(
    state.document.page.blocks,
    direction === "left" ? null : context.block.id,
  );
  const paragraph: Block = {
    id: paragraphId,
    orderKey,
    type: "paragraph",
    charRuns: [],
    formats: [],
  };
  const op: Operation = {
    op: "block_insert",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    orderKey,
    blockId: paragraphId,
    blockType: "paragraph",
  };
  const blocks =
    direction === "left"
      ? [paragraph, ...state.document.page.blocks]
      : [...state.document.page.blocks, paragraph];
  const withoutNestedCaret = updateContentSelection(state, null);
  return {
    state: moveCursorToPosition(
      {
        ...withoutNestedCaret,
        document: {
          ...withoutNestedCaret.document,
          page: { ...withoutNestedCaret.document.page, blocks },
        },
      },
      direction === "left" ? 0 : blocks.length - 1,
      0,
    ),
    ops: [op],
    handled: true,
  };
}

/** Move an active display-math caret to the nearest editable visual row. */
export function moveActiveMathTreeCaretVertically(
  state: EditorState,
  direction: "up" | "down",
): { state: EditorState; ops: Operation[]; handled: true } | undefined {
  const context = activeMathTreeContext(state);
  if (!context) return undefined;
  const caret = moveMathTreeCaretVertically(
    context.document,
    context.caret,
    direction,
  );
  if (caret) {
    return commitMathTreeResult(state, context, {
      handled: true,
      edits: [],
      caret,
    });
  }
  const selection = state.document.contentSelection;
  return selection &&
    mathSourceRangeFromContentSelection(context.document, selection)
    ? commitMathTreeResult(state, context, {
        handled: true,
        edits: [],
        caret: context.caret,
      })
    : undefined;
}

/**
 * Extend a nested display-math selection vertically without flattening it.
 * The moved endpoint is snapped so no construct is ever partially covered —
 * stepping from one matrix cell into another selects the whole matrix.
 */
export function extendActiveMathTreeSelectionVertically(
  state: EditorState,
  direction: "up" | "down",
): { state: EditorState; ops: Operation[]; handled: true } | undefined {
  const context = activeMathTreeContext(state);
  const current = state.document.contentSelection;
  if (!context || !current) return undefined;
  const caret = moveMathTreeCaretVertically(
    context.document,
    context.caret,
    direction,
  );
  const selection = caret
    ? extendMathTreeContentSelection(
        context.block.id,
        context.contentId,
        context.document,
        current.anchor,
        caret,
        direction === "down" ? "end" : "start",
      )
    : null;
  if (!selection) return undefined;
  return {
    state: updateContentSelection(state, selection),
    ops: [],
    handled: true,
  };
}

/**
 * Extend a nested display-math selection by one logical tree caret. The moved
 * endpoint is snapped so no construct is ever partially covered: a caret step
 * that descends into a fraction, matrix, or other construct the anchor is not
 * inside takes that construct whole instead of landing in its guts.
 */
export function extendActiveMathTreeSelectionHorizontally(
  state: EditorState,
  direction: "left" | "right",
): { state: EditorState; ops: Operation[]; handled: true } | undefined {
  const context = activeMathTreeContext(state);
  const current = state.document.contentSelection;
  if (!context || !current) return undefined;
  const moved = moveMathTreeCaret(
    context.document,
    context.caret,
    direction === "left" ? "arrow-left" : "arrow-right",
  );
  if (!moved.handled) return undefined;
  const selection = extendMathTreeContentSelection(
    context.block.id,
    context.contentId,
    context.document,
    current.anchor,
    moved.caret,
    direction === "right" ? "end" : "start",
  );
  if (!selection) return undefined;
  return {
    state: updateContentSelection(state, selection),
    ops: [],
    handled: true,
  };
}

/** Select the canonical source extent of the active structured equation. */
export function selectActiveMathTree(
  state: EditorState,
): { state: EditorState; ops: Operation[]; handled: true } | undefined {
  const context = activeMathTreeContext(state);
  if (!context) return undefined;
  const math = structuredToMathDocument(context.document);
  if (!math) return undefined;
  const sourceLength = getStructuredMathSource(context.block)?.length ?? 0;
  const anchor = mathTreeCaretFromSourceOffset(
    context.block.id,
    context.contentId,
    math,
    context.document,
    0,
  );
  const focus = mathTreeCaretFromSourceOffset(
    context.block.id,
    context.contentId,
    math,
    context.document,
    sourceLength,
  );
  if (!anchor || !focus) return undefined;
  const anchorSelection = mathTreeCaretToContentSelection(
    context.block.id,
    context.contentId,
    context.document,
    anchor,
  );
  const focusSelection = mathTreeCaretToContentSelection(
    context.block.id,
    context.contentId,
    context.document,
    focus,
  );
  if (!anchorSelection || !focusSelection) return undefined;
  const selection = {
    anchor: anchorSelection.focus,
    focus: focusSelection.focus,
    lastUpdate: Date.now(),
  };
  const current = state.document.contentSelection;
  if (
    current &&
    contentPointsEqual(current.anchor, selection.anchor) &&
    contentPointsEqual(current.focus, selection.focus)
  ) {
    return undefined;
  }
  return {
    state: updateContentSelection(state, selection),
    ops: [],
    handled: true,
  };
}

/** Backspace inside one active structured display equation. */
export function backspaceActiveMathTree(
  state: EditorState,
): MathTreeStateEditResult | undefined {
  return deleteActiveMathTreeSelection(state, "backward");
}

/** Delete a range, or one unit on the requested side of a collapsed caret. */
export function deleteActiveMathTreeSelection(
  state: EditorState,
  direction: "backward" | "forward" = "backward",
): MathTreeStateEditResult | undefined {
  const context = editableMathTreeContext(state);
  if (!context) return undefined;
  if (!context.range) {
    const range = adjacentMathTreeConstructRange(
      context.document,
      context.caret,
      direction,
    );
    if (range) return selectMathTreeConstruct(state, context, range);
  }
  const edited = deleteMathTreeInputFromDocument(
    context.document,
    context.caret,
    context.range,
    direction,
    unambiguousMathCommandCompletion,
  );
  return settleMathTreeMutation(state, context, edited);
}

function selectMathTreeConstruct(
  state: EditorState,
  context: MathTreeContext,
  range: MathTreeRange,
): MathTreeStateEditResult {
  const committed = commitMathTreeResult(state, context, {
    handled: true,
    edits: [],
    caret: range.focus,
  });
  const document = getMathStructuredDocument(
    committed.state.document.page.blocks[context.blockIndex],
  );
  const anchor = document
    ? mathTreeCaretToContentSelection(
        context.block.id,
        context.contentId,
        document,
        range.anchor,
      )
    : null;
  const focus = document
    ? mathTreeCaretToContentSelection(
        context.block.id,
        context.contentId,
        document,
        range.focus,
      )
    : null;
  return anchor && focus
    ? {
        ...committed,
        state: updateContentSelection(committed.state, {
          anchor: anchor.focus,
          focus: focus.focus,
          lastUpdate: Date.now(),
        }),
      }
    : committed;
}

/** Forward-delete inside one active structured display equation. */
export function deleteForwardActiveMathTree(
  state: EditorState,
): MathTreeStateEditResult | undefined {
  return deleteActiveMathTreeSelection(state, "forward");
}

/** Resize the matrix containing the active stable tree caret. */
export function resizeActiveMathTreeMatrix(
  state: EditorState,
  rows: number,
  cols: number,
): MathTreeStateEditResult | undefined {
  const context = activeMathTreeContext(state);
  if (!context) return undefined;
  const caret = mathTreeMatrixTargetCaret(
    context.document,
    context.caret,
    context.range,
  );
  const resized = resizeMathTreeMatrix(
    context.document,
    caret,
    rows,
    cols,
    state.CRDTbinding,
  );
  return resized.handled
    ? commitMathTreeResult(state, context, resized)
    : undefined;
}

/** Insert/replace a command chosen by host chrome in one tree transaction. */
export function insertActiveMathTreeCommand(
  state: EditorState,
  text: string,
  caretOffset = text.length,
): MathTreeStateEditResult | undefined {
  const context = editableMathTreeContext(state);
  if (!context) return undefined;
  // `caretOffset` is the legacy source-string placement hint. Semantic nodes
  // own their slots directly, so the pure controller returns the stable caret
  // for the first editable slot instead of preserving a LaTeX offset.
  void caretOffset;
  const edited = applyMathTreeCommandToDocument(
    context.document,
    context.caret,
    context.range,
    text,
    state.CRDTbinding,
    unambiguousMathCommandCompletion,
  );
  return settleMathTreeMutation(state, context, edited);
}

/** Whether the active nested caret belongs to a tree-backed display equation. */
export function hasActiveMathTreeCaret(state: EditorState): boolean {
  return (
    activeMathTreeContext(state) !== undefined ||
    contentSelectionOwnsMathTree(state)
  );
}

/**
 * Whether a mutating action belongs to structured display-math editing.
 *
 * Existing structured attachments are authoritative in every math mode. A
 * legacy display block is included only when this schema installed the tree
 * migration rule, so compatibility schemas retain their char-run behavior.
 * This ownership query intentionally does not parse or allocate identities;
 * callers use it only to prevent unsafe fallback when migration cannot map a
 * selection losslessly.
 */
export function ownsMathTreeMutation(state: EditorState): boolean {
  if (hasActiveMathTreeCaret(state) || flatSelectionOwnsMathTree(state)) {
    return true;
  }
  return (
    isMathTreeMigrationEnabled(state) && legacyMathTreeMutationTarget(state)
  );
}

function legacyMathTreeMutationTarget(state: EditorState): boolean {
  const cursor = state.document.cursor;
  if (!cursor) return false;
  const selection = state.document.selection;
  if (
    selection &&
    !selection.isCollapsed &&
    selection.anchor.blockIndex !== selection.focus.blockIndex
  ) {
    return false;
  }
  const indexes =
    selection && !selection.isCollapsed
      ? [selection.anchor.blockIndex, selection.focus.blockIndex]
      : [cursor.position.blockIndex];
  return indexes.some((index) => {
    const block = state.document.page.blocks[index] as
      | Block
      | MathBlock
      | undefined;
    return !!(
      block &&
      !block.deleted &&
      block.type === "math" &&
      !getMathStructuredDocument(block)
    );
  });
}

/** Resolve an authoritative tree, lazily preparing one when this schema opts in. */
function editableMathTreeContext(
  state: EditorState,
): MathTreeContext | undefined {
  return (
    activeMathTreeContext(state) ??
    (isMathTreeMigrationEnabled(state)
      ? prepareMathTreeMigration(state)
      : undefined)
  );
}

function isMathTreeMigrationEnabled(state: EditorState): boolean {
  return state.schema
    .inputRules("before-insert")
    .some((rule) => rule.id === mathTreeMigrationInputRule.id);
}

function prepareMathTreeMigration(
  state: EditorState,
): MathTreeContext | undefined {
  const cursor = state.document.cursor;
  if (!cursor) return undefined;
  const blockIndex = cursor.position.blockIndex;
  const block = state.document.page.blocks[blockIndex] as
    | Block
    | MathBlock
    | undefined;
  if (!block || block.deleted || block.type !== "math") return undefined;
  const contentId = mathContentIdForBlock(block.id);
  const existing = getMathStructuredDocument(block);
  if (existing) return undefined;

  if (!("charRuns" in block)) return undefined;
  const latex = getVisibleTextFromRuns(block.charRuns);
  const init = parseLegacyMathDocumentInit(latex, { contentId });
  const math = structuredToMathDocument(init.document);
  if (!math) return undefined;
  const flatSelection = state.document.selection;
  if (
    flatSelection &&
    !flatSelection.isCollapsed &&
    (flatSelection.anchor.blockIndex !== blockIndex ||
      flatSelection.focus.blockIndex !== blockIndex)
  ) {
    return undefined;
  }
  const focusOffset =
    flatSelection && !flatSelection.isCollapsed
      ? flatSelection.focus.textIndex
      : cursor.position.textIndex;
  const caret = mathTreeCaretFromSourceOffset(
    block.id,
    contentId,
    math,
    init.document,
    focusOffset,
  );
  const anchor =
    flatSelection && !flatSelection.isCollapsed
      ? mathTreeCaretFromSourceOffset(
          block.id,
          contentId,
          math,
          init.document,
          flatSelection.anchor.textIndex,
        )
      : undefined;
  if (!caret || (flatSelection && !flatSelection.isCollapsed && !anchor)) {
    return undefined;
  }

  // The deterministic initializer may contain counters beyond the legacy
  // flat source. Advance the live allocator before the first tree mutation;
  // RGA insertion requires new counters to out-order every observed sibling.
  state.CRDTbinding.advanceIdCounter(
    maxStructuredDocumentIdCounter(init.document),
  );
  return {
    block,
    blockIndex,
    contentId,
    document: init.document,
    caret,
    ...(anchor ? { range: { anchor, focus: caret } } : {}),
    legacyLength: latex.length,
    migration: { init },
  };
}

function activeMathTreeContext(
  state: EditorState,
): MathTreeContext | undefined {
  const selection = normalizeContentSelection(
    state.document.page,
    state.document.contentSelection,
  );
  if (selection) {
    const point = selection.focus;
    const blockIndex = findBlockIndex(state.document.page, point.blockId);
    if (blockIndex < 0) return undefined;
    const block = state.document.page.blocks[blockIndex] as
      | Block
      | MathBlock
      | undefined;
    if (!block || block.deleted || block.type !== "math") return undefined;
    const contentId = mathContentIdForBlock(block.id);
    if (point.contentId !== contentId) return undefined;
    const document = getMathStructuredDocument(block);
    if (!document) return undefined;
    const caret = contentPointToMathTreeCaret(document, point);
    const anchor = contentPointToMathTreeCaret(document, selection.anchor);
    return caret && anchor
      ? {
          block,
          blockIndex,
          contentId,
          document,
          caret,
          ...(isContentSelectionCollapsed(selection)
            ? {}
            : { range: { anchor, focus: caret } }),
          legacyLength: visibleLegacyLength(block),
        }
      : undefined;
  }

  const cursor = state.document.cursor;
  if (
    !cursor ||
    (state.document.selection && !state.document.selection.isCollapsed)
  ) {
    return undefined;
  }
  const blockIndex = cursor.position.blockIndex;
  const block = state.document.page.blocks[blockIndex] as
    | Block
    | MathBlock
    | undefined;
  if (!block || block.deleted || block.type !== "math") return undefined;
  const contentId = mathContentIdForBlock(block.id);
  const document = getMathStructuredDocument(block);
  if (!document) return undefined;
  const math = structuredToMathDocument(document);
  if (!math) return undefined;
  const caret = mathTreeCaretFromSourceOffset(
    block.id,
    contentId,
    math,
    document,
    cursor.position.textIndex,
  );
  return caret
    ? {
        block,
        blockIndex,
        contentId,
        document,
        caret,
        legacyLength: visibleLegacyLength(block),
      }
    : undefined;
}

function contentSelectionOwnsMathTree(state: EditorState): boolean {
  const point = state.document.contentSelection?.focus;
  if (!point) return false;
  const blockIndex = findBlockIndex(state.document.page, point.blockId);
  if (blockIndex < 0) return false;
  const block = state.document.page.blocks[blockIndex] as
    | Block
    | MathBlock
    | undefined;
  return !!(
    block &&
    !block.deleted &&
    block.type === "math" &&
    point.contentId === mathContentIdForBlock(block.id) &&
    getMathStructuredDocument(block)
  );
}

function flatSelectionOwnsMathTree(state: EditorState): boolean {
  const selection = state.document.selection;
  if (!selection || selection.isCollapsed) return false;
  // A node selection holds the block whole. Deleting it is core's atomic
  // whole-block branch — safe for an authoritative tree — so the tree must
  // not claim it into a no-op.
  if (isNodeSelection(selection)) return false;
  // Cross-block ranges belong to the host document. Core treats an
  // authoritative display block as an atomic endpoint, so claiming the range
  // here would turn otherwise-safe typing/cut/paste into a no-op.
  if (selection.anchor.blockIndex !== selection.focus.blockIndex) return false;
  return [selection.anchor.blockIndex, selection.focus.blockIndex].some(
    (index) => {
      const block = state.document.page.blocks[index] as
        | Block
        | MathBlock
        | undefined;
      return !!(
        block &&
        !block.deleted &&
        block.type === "math" &&
        getMathStructuredDocument(block)
      );
    },
  );
}

function visibleLegacyLength(block: MathBlock): number {
  return getVisibleTextFromRuns(block.charRuns).length;
}

function applyMathTreeInput(
  state: EditorState,
  context: MathTreeContext,
  input: string,
): MathTreeStateEditResult {
  const edited = applyMathTreeInputToDocument(
    context.document,
    context.caret,
    context.range,
    input,
    state.CRDTbinding,
    unambiguousMathCommandCompletion,
  );
  return settleMathTreeMutation(state, context, edited);
}

/**
 * Finish every tree-owned mutation through one authority boundary.
 *
 * A successful edit commits normally. A failed edit on an existing tree is a
 * claimed no-op. A failed first edit still commits the lossless migration and
 * clears the compatibility source, so no caller can retry the same mutation as
 * ordinary text and corrupt the LaTeX.
 */
function settleMathTreeMutation(
  state: EditorState,
  context: MathTreeContext,
  result: MathTreeEditResult,
): MathTreeStateEditResult {
  if (result.handled || context.migration) {
    const committed = commitMathTreeResult(state, context, result);
    return result.handled ? committed : { ...committed, reason: result.reason };
  }
  return { state, ops: [], handled: true, reason: result.reason };
}

function commitMathTreeResult(
  state: EditorState,
  context: MathTreeContext,
  result: MathTreeEditResult,
): { state: EditorState; ops: Operation[]; handled: true } {
  let page = state.document.page;
  const ops: Operation[] = [];

  if (context.migration) {
    const initialized = createContentEdit(
      state,
      context.block.id,
      context.contentId,
      context.migration.init,
    );
    page = applyOp(page, initialized, state.schema);
    ops.push(initialized);
  }

  if (
    context.legacyLength > 0 &&
    (context.migration !== undefined || result.edits.length > 0)
  ) {
    const deleted = deleteCharsInRange(
      page,
      context.block.id,
      0,
      context.legacyLength,
      state.CRDTbinding,
    );
    page = deleted.newPage;
    ops.push(deleted.op);
  }

  for (const edit of result.edits) {
    const operation = createContentEdit(
      state,
      context.block.id,
      context.contentId,
      edit,
    );
    page = applyOp(page, operation, state.schema);
    ops.push(operation);
  }

  const blockIndex = findBlockIndex(page, context.block.id);
  const block = blockIndex >= 0 ? page.blocks[blockIndex] : undefined;
  const document = block ? getMathStructuredDocument(block) : undefined;
  if (!block || !document) return { state, ops, handled: true };
  block.cachedLayout = undefined;

  let next: EditorState = {
    ...state,
    document: { ...state.document, page },
  };
  const selection = mathTreeCaretToContentSelection(
    block.id,
    context.contentId,
    document,
    result.caret,
  );
  if (selection) next = updateContentSelection(next, selection);
  return { state: next, ops, handled: true };
}

function createContentEdit(
  state: EditorState,
  blockId: string,
  contentId: string,
  edit: StructuredMutation | StructuredEdit,
): ContentEdit {
  return {
    op: "content_edit",
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
    blockId,
    contentId,
    edit,
  };
}
