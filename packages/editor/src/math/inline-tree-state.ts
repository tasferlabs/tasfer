/** Interactive state bridge for supplemental MathDocuments owned by MathMark. */

import {
  cursorInsideStructuredMark,
  flatDeleteTouchesStructuredMark,
  selectionPartiallyIntersectsStructuredMark,
} from "../actions/structured-marks";
import type { FeatureInputRule } from "../feature-facets";
import { unambiguousMathCommandCompletion } from "../nodes/math-commands";
import { invalidateBlockCache } from "../rendering/renderer";
import { moveCursorToPosition } from "../selection";
import type { Block } from "../serlization/loadPage";
import type {
  ContentEdit,
  EditorState,
  MarkSet,
  Operation,
} from "../state-types";
import {
  isContentSelectionCollapsed,
  normalizeContentSelection,
  updateContentSelection,
} from "../structured-selection";
import { findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { applyOp } from "../sync/reducer";
import type { StructuredDocument } from "../sync/structured-content";
import { maxStructuredDocumentIdCounter } from "../sync/sync";
import {
  planInlineMathMigration,
  type ResolvedInlineMathRun,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
import {
  applyMathTreeCommandToDocument,
  applyMathTreeInputToDocument,
  deleteMathTreeInputFromDocument,
} from "./input-controller";
import { structuredToMathDocument } from "./structured";
import {
  adjacentMathTreeConstructRange,
  mathTreeMatrixTargetCaret,
  type MathTreeCaret,
  type MathTreeEditFailure,
  type MathTreeEditResult,
  type MathTreeMotion,
  type MathTreeRange,
  moveMathTreeCaret,
  resizeMathTreeMatrix,
} from "./tree-edit";
import {
  contentPointToMathTreeCaret,
  mathSourceRangeFromContentSelection,
  mathTreeCaretFromSourceOffset,
  mathTreeCaretToContentSelection,
  moveMathTreeCaretVertically,
} from "./tree-selection";

interface InlineMathTreeContext {
  readonly block: Block;
  readonly blockIndex: number;
  readonly run: ResolvedInlineMathRun;
  readonly contentId: string;
  readonly document: StructuredDocument;
  readonly caret: MathTreeCaret;
  readonly range?: MathTreeRange;
  readonly migration?: {
    readonly init?: Extract<
      import("../sync/structured-content").StructuredMutation,
      { readonly kind: "document_init" }
    >;
    readonly mark?: {
      readonly charIds: readonly string[];
      readonly format: import("../serlization/loadPage").Mark;
    };
  };
}

export interface InlineMathTreeStateResult {
  readonly state: EditorState;
  readonly ops: Operation[];
  readonly handled: true;
  readonly reason?: MathTreeEditFailure;
}

/** Tree-owned insertion/replacement for an inline MathMark. */
export const inlineMathTreeInputRule: FeatureInputRule = {
  id: "math.inline-tree.input",
  phase: "before-insert",
  priority: 1_200,
  apply: ({ state, input }) => {
    const context = editableInlineMathContext(state);
    if (!context) return undefined;
    const edited = applyMathTreeInputToDocument(
      context.document,
      context.caret,
      context.range,
      input,
      state.CRDTbinding,
      unambiguousMathCommandCompletion,
    );
    return settleInlineMathMutation(state, context, edited);
  },
};

/**
 * Keep persisted attachment projections read-only on every client.
 *
 * Tree-enabled clients get the higher-priority rule above. Legacy clients may
 * still receive an attached mark from a peer; this guard claims unsafe flat
 * edits instead of mutating only its stale compatibility characters.
 */
export const inlineMathAttachedProjectionGuard: FeatureInputRule = {
  id: "math.inline-tree.attached-projection-guard",
  phase: "before-insert",
  priority: 1_190,
  owns: ({ state }) => ownsInlineMathTreeMutation(state),
  apply: ({ state }) =>
    ownsInlineMathTreeMutation(state)
      ? { state, ops: [], handled: true }
      : undefined,
};

/** Enter/migrate the inline tree at one compatibility-source offset. */
export function enterInlineMathTreeAtPosition(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
  options: { readonly allowBoundary?: boolean } = {},
): InlineMathTreeStateResult | undefined {
  const context = inlineContextFromFlatPosition(state, blockIndex, textIndex);
  if (!context?.migration) return undefined;
  const atBoundary =
    textIndex === context.run.startIndex || textIndex === context.run.endIndex;
  const hover = state.ui.inlineMathHover;
  const boundaryOwnedByPointer = !!(
    hover &&
    hover.blockIndex === blockIndex &&
    hover.startIndex === context.run.startIndex &&
    hover.endIndex === context.run.endIndex
  );
  if (atBoundary && !options.allowBoundary && !boundaryOwnedByPointer) {
    return undefined;
  }
  return commitInlineMathResult(state, context, {
    handled: true,
    edits: [],
    caret: context.caret,
  });
}

/** Backspace/Delete while an inline attachment owns the nested caret. */
export function deleteActiveInlineMathTree(
  state: EditorState,
  direction: "backward" | "forward",
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  if (!context.range) {
    const range = adjacentMathTreeConstructRange(
      context.document,
      context.caret,
      direction,
    );
    if (range) return selectInlineMathConstruct(state, context, range);
  }
  const edited = deleteMathTreeInputFromDocument(
    context.document,
    context.caret,
    context.range,
    direction,
    unambiguousMathCommandCompletion,
  );
  return settleInlineMathMutation(state, context, edited);
}

function selectInlineMathConstruct(
  state: EditorState,
  context: InlineMathTreeContext,
  range: MathTreeRange,
): InlineMathTreeStateResult {
  const committed = commitInlineMathResult(state, context, {
    handled: true,
    edits: [],
    caret: range.focus,
  });
  const block = committed.state.document.page.blocks[context.blockIndex];
  const document = block?.structuredContent?.[context.contentId];
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

/** Move one active nested inline caret without touching compatibility chars. */
export function moveActiveInlineMathTreeCaret(
  state: EditorState,
  motion: MathTreeMotion,
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  const moved = moveMathTreeCaret(context.document, context.caret, motion);
  if (moved.handled) return commitInlineMathResult(state, context, moved);
  // Collapse a range even when its focus is already at the formula boundary.
  // Previously the failed move left a full-formula selection active.
  const selection = state.document.contentSelection;
  return selection &&
    mathSourceRangeFromContentSelection(context.document, selection)
    ? commitInlineMathResult(state, context, {
        handled: true,
        edits: [],
        caret: context.caret,
      })
    : undefined;
}

/** Move the active nested caret between visual rows of one inline formula. */
export function moveActiveInlineMathTreeCaretVertically(
  state: EditorState,
  direction: "up" | "down",
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  const caret = moveMathTreeCaretVertically(
    context.document,
    context.caret,
    direction,
  );
  if (caret) {
    return commitInlineMathResult(state, context, {
      handled: true,
      edits: [],
      caret,
    });
  }
  const selection = state.document.contentSelection;
  return selection &&
    mathSourceRangeFromContentSelection(context.document, selection)
    ? commitInlineMathResult(state, context, {
        handled: true,
        edits: [],
        caret: context.caret,
      })
    : undefined;
}

/** Extend the active nested selection to the visual row above/below. */
export function extendActiveInlineMathTreeSelectionVertically(
  state: EditorState,
  direction: "up" | "down",
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  const current = state.document.contentSelection;
  if (!context || !current) return undefined;
  const caret = moveMathTreeCaretVertically(
    context.document,
    context.caret,
    direction,
  );
  const target = caret
    ? mathTreeCaretToContentSelection(
        context.block.id,
        context.contentId,
        context.document,
        caret,
      )
    : null;
  if (!target) return undefined;
  return {
    state: updateContentSelection(state, {
      anchor: current.anchor,
      focus: target.focus,
      lastUpdate: target.lastUpdate,
    }),
    ops: [],
    handled: true,
  };
}

/** Extend an inline structured-math selection by one logical tree caret. */
export function extendActiveInlineMathTreeSelectionHorizontally(
  state: EditorState,
  direction: "left" | "right",
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  const current = state.document.contentSelection;
  if (!context || !current) return undefined;
  const moved = moveMathTreeCaret(
    context.document,
    context.caret,
    direction === "left" ? "arrow-left" : "arrow-right",
  );
  if (!moved.handled) return undefined;
  const target = mathTreeCaretToContentSelection(
    context.block.id,
    context.contentId,
    context.document,
    moved.caret,
  );
  if (!target) return undefined;
  return {
    state: updateContentSelection(state, {
      anchor: current.anchor,
      focus: target.focus,
      lastUpdate: target.lastUpdate,
    }),
    ops: [],
    handled: true,
  };
}

/** Whether a nested selection currently belongs to an attached inline tree. */
export function hasActiveInlineMathTreeCaret(state: EditorState): boolean {
  return ownsActiveInlineMathContentSelection(state);
}

/**
 * Leave an attached inline tree through its leading/trailing host-text edge.
 *
 * The pure tree controller intentionally has no target beyond the root row.
 * Once it reports that edge, horizontal document navigation must hand the
 * caret back to the flat host block rather than claiming the arrow as a no-op.
 */
export function exitActiveInlineMathTreeHorizontally(
  state: EditorState,
  direction: "left" | "right",
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  const withoutContentSelection = updateContentSelection(state, null);
  return {
    state: moveCursorToPosition(
      withoutContentSelection,
      context.blockIndex,
      direction === "left" ? context.run.startIndex : context.run.endIndex,
    ),
    ops: [],
    handled: true,
  };
}

/**
 * Leave an attached inline tree at its trailing flat boundary before Enter.
 *
 * The attachment is scoped to its current block, so splitting through its
 * compatibility projection would orphan the structured document. Promoting
 * Enter to the end of the whole mark keeps the attachment on block one while
 * the ordinary split path moves any following prose to block two.
 */
export function exitActiveInlineMathTreeForBlockSplit(
  state: EditorState,
): { state: EditorState; ops: Operation[] } | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  const withoutContentSelection = updateContentSelection(state, null);
  return {
    state: moveCursorToPosition(
      withoutContentSelection,
      context.blockIndex,
      context.run.endIndex,
    ),
    ops: [],
  };
}

/** Insert/replace a command chosen by host chrome in the active inline tree. */
export function insertActiveInlineMathTreeCommand(
  state: EditorState,
  text: string,
  caretOffset = text.length,
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  void caretOffset;
  const edited = applyMathTreeCommandToDocument(
    context.document,
    context.caret,
    context.range,
    text,
    state.CRDTbinding,
    unambiguousMathCommandCompletion,
  );
  return settleInlineMathMutation(state, context, edited);
}

/** Resize the matrix containing the active inline tree caret. */
export function resizeActiveInlineMathTreeMatrix(
  state: EditorState,
  rows: number,
  cols: number,
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
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
    ? commitInlineMathResult(state, context, resized)
    : undefined;
}

/** True when unsupported fallback must not mutate compatibility characters. */
export function ownsInlineMathTreeMutation(state: EditorState): boolean {
  const point = state.document.contentSelection?.focus;
  if (point) {
    const blockIndex = findBlockIndex(state.document.page, point.blockId);
    const block = state.document.page.blocks[blockIndex];
    if (
      block &&
      !block.deleted &&
      isTextualBlock(block) &&
      resolveStructuredInlineMathRuns(block).some(
        (run) => run.contentId === point.contentId && !!run.document,
      )
    ) {
      return true;
    }
  }
  return (
    selectionPartiallyIntersectsStructuredMark(state, "math") ||
    cursorInsideStructuredMark(state, "math")
  );
}

/** True when a flat or nested directional deletion would touch an attachment. */
export function ownsInlineMathTreeDelete(
  state: EditorState,
  direction: "backward" | "forward",
): boolean {
  // Mixed flat selections are expanded to whole structured marks by the core
  // delete transaction. Claim only a nested caret or collapsed adjacent unit.
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return false;
  }
  return (
    ownsActiveInlineMathContentSelection(state) ||
    flatDeleteTouchesStructuredMark(state, direction, "math")
  );
}

function ownsActiveInlineMathContentSelection(state: EditorState): boolean {
  const point = state.document.contentSelection?.focus;
  if (!point) return false;
  const blockIndex = findBlockIndex(state.document.page, point.blockId);
  const block = state.document.page.blocks[blockIndex];
  return !!(
    block &&
    !block.deleted &&
    isTextualBlock(block) &&
    resolveStructuredInlineMathRuns(block).some(
      (run) => run.contentId === point.contentId && !!run.document,
    )
  );
}

function editableInlineMathContext(
  state: EditorState,
): InlineMathTreeContext | undefined {
  // Flat chip edges retain their established prose/join/split semantics. A
  // direct click first promotes the run through `enterInlineMathTreeAtPosition`;
  // only that stable nested caret opts subsequent input into tree authority.
  return activeInlineMathContext(state);
}

function activeInlineMathContext(
  state: EditorState,
): InlineMathTreeContext | undefined {
  const selection = normalizeContentSelection(
    state.document.page,
    state.document.contentSelection,
  );
  if (!selection) return undefined;
  const blockIndex = findBlockIndex(
    state.document.page,
    selection.focus.blockId,
  );
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  const run = resolveStructuredInlineMathRuns(block).find(
    (candidate) =>
      candidate.contentId === selection.focus.contentId && candidate.document,
  );
  if (!run?.contentId || !run.document) return undefined;
  const caret = contentPointToMathTreeCaret(run.document, selection.focus);
  const anchor = contentPointToMathTreeCaret(run.document, selection.anchor);
  if (!caret || !anchor) return undefined;
  return {
    block,
    blockIndex,
    run,
    contentId: run.contentId,
    document: run.document,
    caret,
    ...(isContentSelectionCollapsed(selection)
      ? {}
      : { range: { anchor, focus: caret } }),
  };
}

function inlineContextFromFlatPosition(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
): InlineMathTreeContext | undefined {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  const flatSelection = state.document.selection;
  if (
    flatSelection &&
    !flatSelection.isCollapsed &&
    (flatSelection.anchor.blockIndex !== blockIndex ||
      flatSelection.focus.blockIndex !== blockIndex)
  ) {
    return undefined;
  }
  const anchorIndex =
    flatSelection && !flatSelection.isCollapsed
      ? flatSelection.anchor.textIndex
      : textIndex;
  const focusIndex =
    flatSelection && !flatSelection.isCollapsed
      ? flatSelection.focus.textIndex
      : textIndex;
  const run = resolveStructuredInlineMathRuns(block).find(
    (candidate) =>
      anchorIndex >= candidate.startIndex &&
      anchorIndex <= candidate.endIndex &&
      focusIndex >= candidate.startIndex &&
      focusIndex <= candidate.endIndex,
  );
  if (!run) return undefined;
  const planned = planInlineMathMigration(block, run);
  if (!planned.ok) return undefined;
  const math = structuredToMathDocument(planned.document);
  if (!math) return undefined;
  const caret = mathTreeCaretFromSourceOffset(
    block.id,
    planned.contentId,
    math,
    planned.document,
    focusIndex - run.startIndex,
  );
  const anchor = mathTreeCaretFromSourceOffset(
    block.id,
    planned.contentId,
    math,
    planned.document,
    anchorIndex - run.startIndex,
  );
  if (!caret || !anchor) return undefined;
  state.CRDTbinding.advanceIdCounter(
    maxStructuredDocumentIdCounter(planned.document),
  );
  return {
    block,
    blockIndex,
    run,
    contentId: planned.contentId,
    document: planned.document,
    caret,
    ...(anchorIndex === focusIndex ? {} : { range: { anchor, focus: caret } }),
    ...(planned.init || planned.needsMarkUpdate
      ? {
          migration: {
            ...(planned.init ? { init: planned.init } : {}),
            ...(planned.needsMarkUpdate
              ? {
                  mark: {
                    charIds: planned.charIds,
                    format: planned.format,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function settleInlineMathMutation(
  state: EditorState,
  context: InlineMathTreeContext,
  result: MathTreeEditResult,
): InlineMathTreeStateResult {
  if (result.handled || context.migration) {
    const committed = commitInlineMathResult(state, context, result);
    return result.handled ? committed : { ...committed, reason: result.reason };
  }
  return { state, ops: [], handled: true, reason: result.reason };
}

function commitInlineMathResult(
  state: EditorState,
  context: InlineMathTreeContext,
  result: MathTreeEditResult,
): InlineMathTreeStateResult {
  let page = state.document.page;
  const ops: Operation[] = [];
  if (context.migration?.init) {
    const op = contentEdit(
      state,
      context.block.id,
      context.contentId,
      context.migration.init,
    );
    page = applyOp(page, op, state.schema);
    ops.push(op);
  }
  if (context.migration?.mark) {
    const op: MarkSet = {
      op: "mark_set",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: context.block.id,
      charIds: [...context.migration.mark.charIds],
      format: context.migration.mark.format,
      value: true,
    };
    page = applyOp(page, op, state.schema);
    ops.push(op);
  }
  for (const edit of result.edits) {
    const op = contentEdit(state, context.block.id, context.contentId, edit);
    page = applyOp(page, op, state.schema);
    ops.push(op);
  }

  const blockIndex = findBlockIndex(page, context.block.id);
  if (blockIndex < 0) return { state, ops, handled: true };
  invalidateBlockCache(page.blocks[blockIndex]);
  const document =
    page.blocks[blockIndex].structuredContent?.[context.contentId];
  const selection = document
    ? mathTreeCaretToContentSelection(
        context.block.id,
        context.contentId,
        document,
        result.caret,
      )
    : null;
  const withPage: EditorState = {
    ...state,
    document: { ...state.document, page },
  };
  return {
    state: selection ? updateContentSelection(withPage, selection) : withPage,
    ops,
    handled: true,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function contentEdit(
  state: EditorState,
  blockId: string,
  contentId: string,
  edit: ContentEdit["edit"],
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
