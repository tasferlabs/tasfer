/** Interactive state bridge for supplemental MathDocuments owned by MathMark. */

import {
  extendSelectionOutOfStructuredMark,
  flatDeleteTouchesStructuredMark,
} from "../actions/structured-marks";
import {
  type FeatureInputRule,
  STRUCTURED_MARK_ANCHOR_CHAR,
} from "../feature-facets";
import { unambiguousMathCommandCompletion } from "../nodes/math-commands";
import type { TextualBlock } from "../nodes/TextNode";
import { invalidateBlockCache } from "../rendering/renderer";
import { getBlockDirection } from "../rtl";
import {
  clearSelection,
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
} from "../selection";
import type { ContentEdit, EditorState, Operation } from "../state-types";
import {
  isContentSelectionCollapsed,
  normalizeContentSelection,
  updateContentSelection,
} from "../structured-selection";
import { findBlockIndex } from "../sync/block-lookup";
import { isTextualBlock } from "../sync/block-registry";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "../sync/crdt-utils";
import { applyOp } from "../sync/reducer";
import type { StructuredDocument } from "../sync/structured-content";
import {
  createStructuredMathMarkAttachment,
  type ResolvedInlineMathRun,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
import {
  applyMathTreeCommandToDocument,
  applyMathTreeInputToDocument,
  deleteMathTreeInputFromDocument,
  trailingMathCommandRange,
} from "./input-controller";
import { structuredToMathDocument } from "./structured";
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
  mathSourceOffsetFromContentPoint,
  mathSourceRangeFromContentSelection,
  mathTreeCaretFromSourceOffset,
  mathTreeCaretToContentSelection,
  moveMathTreeCaretVertically,
} from "./tree-selection";
import { needsCommandSeparator } from "@tasfer/tex";
import { printMathDocument } from "@tasfer/tex/data";

interface InlineMathTreeContext {
  readonly block: TextualBlock;
  readonly blockIndex: number;
  readonly run: ResolvedInlineMathRun;
  readonly contentId: string;
  readonly document: StructuredDocument;
  readonly caret: MathTreeCaret;
  readonly range?: MathTreeRange;
}

export interface InlineMathTreeStateResult {
  readonly state: EditorState;
  readonly ops: Operation[];
  readonly handled: true;
  readonly reason?: MathTreeEditFailure;
}

/**
 * Sentence punctuation that reads as prose when typed flush against a chip's
 * edge, so — like a space — it stays plain text instead of being absorbed into
 * the formula (`$x^2$` + `.` → `$x^2$.`). `.`/`,` are also number characters;
 * a digit typed right after such an ejected mark pulls both back in (see the
 * numeric-absorb branch of {@link inlineMathTreeInputRule}).
 */
const EDGE_PROSE_PUNCTUATION = new Set([",", ".", ";", ":", "!", "?"]);

/** Tree-owned insertion/replacement for an inline MathMark. */
export const inlineMathTreeInputRule: FeatureInputRule = {
  id: "math.inline-tree.input",
  phase: "before-insert",
  priority: 1_200,
  apply: ({ state, input }) => {
    const absorbed = absorbNumericPunctuationIntoChip(state, input);
    if (absorbed) return absorbed;
    const context = editableInlineMathContext(state, input);
    if (!context) return undefined;
    const split = splitInlineMathChipOnSpace(state, context, input);
    if (split) return split;
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
 * A digit typed right after a `.`/`,` that sits flush against a chip's right
 * edge pulls BOTH into the formula: the punctuation was part of a number all
 * along (`$3$` + `.` + `1` → `$3.1$`). The edge-typing entry ejects `.`/`,` as
 * prose because at that keystroke the sentence-punctuation and number-char
 * readings are indistinguishable; the digit one keystroke later resolves it.
 * The flat punctuation char is deleted and both characters re-enter through
 * the tree at the formula's end.
 */
function absorbNumericPunctuationIntoChip(
  state: EditorState,
  input: string,
): InlineMathTreeStateResult | undefined {
  if (!/^[0-9]$/.test(input)) return undefined;
  const position = collapsedFlatCursorPosition(state);
  if (!position) return undefined;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  const text = getVisibleTextFromRuns(block.charRuns);
  const punct = text[position.textIndex - 1];
  if (punct !== "." && punct !== ",") return undefined;
  const run = resolveStructuredInlineMathRuns(block).find(
    (candidate) => candidate.endIndex === position.textIndex - 1,
  );
  if (!run?.contentId || !run.document || run.latex === undefined) {
    return undefined;
  }

  let page = state.document.page;
  const ops: Operation[] = [];
  const removed = deleteCharsInRange(
    page,
    block.id,
    position.textIndex - 1,
    position.textIndex,
    state.CRDTbinding,
  );
  page = removed.newPage;
  ops.push(removed.op);
  const withPage: EditorState = {
    ...state,
    document: { ...state.document, page },
  };
  const context = inlineContextFromFlatPosition(
    withPage,
    position.blockIndex,
    run.endIndex,
  );
  if (!context) {
    return {
      state: moveCursorToPosition(withPage, position.blockIndex, run.endIndex),
      ops,
      handled: true,
    };
  }
  const edited = applyMathTreeInputToDocument(
    context.document,
    context.caret,
    undefined,
    `${punct}${input}`,
    state.CRDTbinding,
    unambiguousMathCommandCompletion,
  );
  const settled = settleInlineMathMutation(withPage, context, edited);
  return { ...settled, ops: [...ops, ...settled.ops] };
}

/**
 * A space typed at an inline formula's TOP level is the "leave the formula"
 * gesture: mid-formula it breaks the chip into two independent chips with a
 * plain host space between them, and at either edge it ejects one plain space
 * so typing continues as prose. It is NOT a split while a `\command` is
 * pending (completion/control space own the keystroke), over a selection (the
 * space deletes it), or inside a construct slot — a construct cannot be
 * divided, so the shared controller swallows the dead space instead.
 *
 * Both halves are rebuilt as fresh attachments, each anchored on its own
 * placeholder char. The caret lands after the separating space.
 */
function splitInlineMathChipOnSpace(
  state: EditorState,
  context: InlineMathTreeContext,
  input: string,
): InlineMathTreeStateResult | undefined {
  if (input !== " " || context.range) return undefined;
  if (trailingMathCommandRange(context.document, context.caret)) {
    return undefined;
  }
  const math = structuredToMathDocument(context.document);
  if (!math || context.caret.rowId !== math.root.body.id) return undefined;
  const selection = mathTreeCaretToContentSelection(
    context.block.id,
    context.contentId,
    context.document,
    context.caret,
  );
  const offset = selection
    ? mathSourceOffsetFromContentPoint(context.document, selection.focus)
    : null;
  if (offset === null) return undefined;
  const latex = printMathDocument(math);
  const left = latex.slice(0, offset);
  const right = latex.slice(offset);

  // A blank side means the caret sat at a formula edge: there is no second
  // formula to split off, so eject one plain unmarked space at that edge and
  // hand the caret to the host text. The explicit un-mark defeats tolerant
  // span resolution absorbing the new char over boundary tombstones.
  if (!left.trim() || !right.trim()) {
    const at = !right.trim() ? context.run.endIndex : context.run.startIndex;
    let page = state.document.page;
    const ops: Operation[] = [];
    const inserted = insertCharsAtPosition(
      page,
      context.block.id,
      at,
      " ",
      state.CRDTbinding,
    );
    page = inserted.newPage;
    ops.push(inserted.op);
    const unmarked = markCharsInRange(
      page,
      context.block.id,
      at,
      at + 1,
      { type: "math" },
      false,
      state.CRDTbinding,
    );
    page = unmarked.newPage;
    ops.push(unmarked.op);
    return finishInlineMathSplit(state, context, page, ops, at + 1);
  }

  const rebuilt = rebuildInlineMathRunAsChips(state, context, left, " ", right);
  return finishInlineMathSplit(
    state,
    context,
    rebuilt.page,
    rebuilt.ops,
    // Flat layout after the rebuild: [left anchor][space][right anchor].
    context.run.startIndex + 2,
  );
}

/**
 * Replace `context.run` with two independent attached chips holding `left`
 * and `right`, separated by `gap` plain unmarked characters (empty for the
 * Enter split — the block boundary is the separator there). Each half is one
 * fresh anchor char + attachment. Shared CRDT footing for both splits: the
 * rebuilt chars are inserted AFTER the old run before deleting it (new chars
 * anchored past the run's last visible char can never be adopted between the
 * old span's boundary identities once those chars become tombstones), stale
 * mark coverage is stripped, then each anchor gets its fresh attachment.
 */
function rebuildInlineMathRunAsChips(
  state: EditorState,
  context: InlineMathTreeContext,
  left: string,
  gap: string,
  right: string,
): { page: EditorState["document"]["page"]; ops: Operation[] } {
  let page = state.document.page;
  const ops: Operation[] = [];
  const op = contentEdit(state, context.block.id, context.contentId, {
    kind: "document_delete",
  });
  page = applyOp(page, op, state.schema);
  ops.push(op);
  const flat = `${STRUCTURED_MARK_ANCHOR_CHAR}${gap}${STRUCTURED_MARK_ANCHOR_CHAR}`;
  const inserted = insertCharsAtPosition(
    page,
    context.block.id,
    context.run.endIndex,
    flat,
    state.CRDTbinding,
  );
  page = inserted.newPage;
  ops.push(inserted.op);
  if (context.run.endIndex > context.run.startIndex) {
    const removed = deleteCharsInRange(
      page,
      context.block.id,
      context.run.startIndex,
      context.run.endIndex,
      state.CRDTbinding,
    );
    page = removed.newPage;
    ops.push(removed.op);
  }
  const start = context.run.startIndex;
  // Strip any coverage the dead span still resolves over the fresh chars (its
  // endpoints may be tombstones that order around them) before re-marking.
  const unmarked = markCharsInRange(
    page,
    context.block.id,
    start,
    start + flat.length,
    { type: "math" },
    false,
    state.CRDTbinding,
  );
  page = unmarked.newPage;
  ops.push(unmarked.op);
  const chips: Array<{ latex: string; at: number }> = [
    { latex: left, at: start },
    { latex: right, at: start + 1 + gap.length },
  ];
  for (const chip of chips) {
    const created = createStructuredMathMarkAttachment(
      chip.latex,
      state.CRDTbinding,
    );
    const init = contentEdit(
      state,
      context.block.id,
      created.contentId,
      created.init,
    );
    page = applyOp(page, init, state.schema);
    ops.push(init);
    const marked = markCharsInRange(
      page,
      context.block.id,
      chip.at,
      chip.at + 1,
      created.format,
      true,
      state.CRDTbinding,
    );
    page = marked.newPage;
    ops.push(marked.op);
  }
  return { page, ops };
}

/** Commit a split/eject transaction: flat caret after the separating space. */
function finishInlineMathSplit(
  state: EditorState,
  context: InlineMathTreeContext,
  page: EditorState["document"]["page"],
  ops: Operation[],
  caretIndex: number,
): InlineMathTreeStateResult {
  const blockIndex = findBlockIndex(page, context.block.id);
  if (blockIndex >= 0) invalidateBlockCache(page.blocks[blockIndex]);
  const withPage = updateContentSelection(
    { ...state, document: { ...state.document, page } },
    null,
  );
  return {
    state: moveCursorToPosition(
      withPage,
      blockIndex >= 0 ? blockIndex : context.blockIndex,
      caretIndex,
    ),
    ops,
    handled: true,
  };
}

/**
 * Fuse inline chips a delete left touching back into one formula — the inverse
 * of {@link splitInlineMathChipOnSpace}. The touching chips are rebuilt from
 * their canonical printed sources into a single fresh attachment on a single
 * fresh anchor char, following the split's CRDT footing (insert after the old
 * chars, delete, un-mark, re-mark). A chip ending in a control word gets its
 * required separator back (`\sin`⎵`x` → `\sin x`, never `\sinx`). When the
 * post-delete caret sits exactly on a seam it promotes to the nested position
 * at that seam, so the next keystroke keeps working the merged formula;
 * otherwise the caller's caret is left alone.
 */
export function rejoinAdjacentInlineMathChips(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
): { state: EditorState; ops: Operation[] } | undefined {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  // A display equation never resolves runs — its formats are always empty —
  // so no math-block guard is needed here.
  const runs = [...resolveStructuredInlineMathRuns(block)].sort(
    (left, right) => left.startIndex - right.startIndex,
  );

  // Maximal chains of runs left touching (`endIndex === startIndex`).
  const chains: ResolvedInlineMathRun[][] = [];
  for (let i = 0; i < runs.length; ) {
    let j = i;
    while (j + 1 < runs.length && runs[j].endIndex === runs[j + 1].startIndex) {
      j++;
    }
    if (
      j > i &&
      runs
        .slice(i, j + 1)
        .every(
          (run) => run.contentId && run.document && run.latex !== undefined,
        )
    ) {
      chains.push(runs.slice(i, j + 1));
    }
    i = j + 1;
  }
  if (chains.length === 0) return undefined;

  let page = state.document.page;
  const ops: Operation[] = [];
  let seamSelection: ReturnType<typeof mathTreeCaretToContentSelection> = null;
  // Right-to-left so an earlier chain's flat indices survive later rebuilds.
  for (const chain of [...chains].reverse()) {
    // Concatenate the canonical sources, reinserting the separator a control
    // word needs before a following letter so the merge stays valid LaTeX.
    // `seams[k]` is the merged-source offset of the boundary after chunk `k`.
    let combined = "";
    const seams: number[] = [];
    for (const [index, run] of chain.entries()) {
      const latex = run.latex ?? "";
      if (index > 0) {
        seams.push(combined.length);
        if (needsCommandSeparator(combined, combined.length, latex[0] ?? "")) {
          combined += " ";
        }
      }
      combined += latex;
    }
    const start = chain[0].startIndex;
    const end = chain[chain.length - 1].endIndex;

    // The persisted attachments are replaced whole by the rebuilt chip.
    for (const run of chain) {
      if (run.contentId && run.document) {
        const op = contentEdit(state, block.id, run.contentId, {
          kind: "document_delete",
        });
        page = applyOp(page, op, state.schema);
        ops.push(op);
      }
    }
    const inserted = insertCharsAtPosition(
      page,
      block.id,
      end,
      STRUCTURED_MARK_ANCHOR_CHAR,
      state.CRDTbinding,
    );
    page = inserted.newPage;
    ops.push(inserted.op);
    if (end > start) {
      const removed = deleteCharsInRange(
        page,
        block.id,
        start,
        end,
        state.CRDTbinding,
      );
      page = removed.newPage;
      ops.push(removed.op);
    }
    const unmarked = markCharsInRange(
      page,
      block.id,
      start,
      start + 1,
      { type: "math" },
      false,
      state.CRDTbinding,
    );
    page = unmarked.newPage;
    ops.push(unmarked.op);
    const created = createStructuredMathMarkAttachment(
      combined,
      state.CRDTbinding,
    );
    const init = contentEdit(state, block.id, created.contentId, created.init);
    page = applyOp(page, init, state.schema);
    ops.push(init);
    const marked = markCharsInRange(
      page,
      block.id,
      start,
      start + 1,
      created.format,
      true,
      state.CRDTbinding,
    );
    page = marked.newPage;
    ops.push(marked.op);

    // The delete that triggered this left its caret on a chip boundary; when it
    // is one of this chain's seams, hand it the nested caret at that seam —
    // just past the left chunk, before any reinserted separator.
    const seamIndex = chain.findIndex(
      (run, index) => index < chain.length - 1 && run.endIndex === textIndex,
    );
    if (seamIndex >= 0) {
      const math = structuredToMathDocument(created.init.document);
      const caret = math
        ? mathTreeCaretFromSourceOffset(
            block.id,
            created.contentId,
            math,
            created.init.document,
            seams[seamIndex],
          )
        : null;
      seamSelection = caret
        ? mathTreeCaretToContentSelection(
            block.id,
            created.contentId,
            created.init.document,
            caret,
          )
        : null;
    }
  }

  invalidateBlockCache(page.blocks[blockIndex]);
  let next: EditorState = {
    ...state,
    document: { ...state.document, page },
  };
  if (seamSelection) next = updateContentSelection(next, seamSelection);
  return { state: next, ops };
}

/** Enter the inline tree from a flat position on one of the run's edges. */
export function enterInlineMathTreeAtPosition(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
  options: { readonly allowBoundary?: boolean } = {},
): InlineMathTreeStateResult | undefined {
  const context = inlineContextFromFlatPosition(state, blockIndex, textIndex);
  if (!context) return undefined;
  // An anchor run has only boundary positions; entering from one is gated on
  // the pointer actually hovering the chip (or an explicit opt-in), so a plain
  // caret placement beside the chip doesn't steal the click into the formula.
  const hover = state.ui.inlineMathHover;
  const boundaryOwnedByPointer = !!(
    hover &&
    hover.blockIndex === blockIndex &&
    hover.startIndex === context.run.startIndex &&
    hover.endIndex === context.run.endIndex
  );
  if (!options.allowBoundary && !boundaryOwnedByPointer) {
    return undefined;
  }
  return commitInlineMathResult(state, context, {
    handled: true,
    edits: [],
    caret: context.caret,
  });
}

/**
 * Backspace/Delete while an inline attachment owns the deletion.
 *
 * A nested caret always qualifies. A collapsed flat caret qualifies when the
 * deletion faces into a run — resting on the edge the deletion enters through
 * (Backspace at the trailing edge, Delete at the leading edge) — mirroring
 * the display block: the caret promotes into the tree and large constructs
 * are selected before they are deleted. A run whose attachment is broken has
 * no tree to edit; the delete removes the whole chip (anchor char plus dead
 * attachment) instead.
 */
export function deleteActiveInlineMathTree(
  state: EditorState,
  direction: "backward" | "forward",
): InlineMathTreeStateResult | undefined {
  const broken = flatDeleteBrokenInlineMathRun(state, direction);
  if (broken) return broken;
  const context =
    activeInlineMathContext(state) ??
    flatDeleteInlineMathContext(state, direction);
  if (!context) return undefined;
  // Deleting the formula's last content keeps an EMPTY chip — a live nested
  // caret the author can keep typing into (serialized as `$$`). Deleting once
  // more removes the chip itself — attachment, mark chars, and all — and hands
  // the caret back to the host text where the chip stood. Without this, the
  // empty chip is an invisible, undeletable anchor char.
  if (isEmptyInlineMathDocument(context.document)) {
    return removeInlineMathChip(state, context);
  }
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
  // A collapsed delete facing out of the formula (Backspace at its first caret
  // stop, Delete at its last) has nothing to consume inside. Hand the caret to
  // the host text at that chip edge instead of claiming a dead no-op, so the
  // next press continues into the surrounding prose.
  if (!edited.handled && !context.range) {
    const outward = moveMathTreeCaret(
      context.document,
      context.caret,
      direction === "backward" ? "arrow-left" : "arrow-right",
    );
    if (!outward.handled) {
      return {
        state: moveCursorToPosition(
          updateContentSelection(state, null),
          context.blockIndex,
          direction === "backward"
            ? context.run.startIndex
            : context.run.endIndex,
        ),
        ops: [],
        handled: true,
      };
    }
  }
  return settleInlineMathMutation(state, context, edited);
}

function isEmptyInlineMathDocument(document: StructuredDocument): boolean {
  const math = structuredToMathDocument(document);
  return !!math && printMathDocument(math).length === 0;
}

/**
 * A directional flat delete facing a run whose attachment is broken (missing
 * or invalid) removes the chip whole — there is no tree to promote into, and
 * leaving the anchor char undeletable would strand the run forever.
 */
function flatDeleteBrokenInlineMathRun(
  state: EditorState,
  direction: "backward" | "forward",
): InlineMathTreeStateResult | undefined {
  const position = collapsedFlatCursorPosition(state);
  if (!position) return undefined;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  const faced = resolveStructuredInlineMathRuns(block).find((run) =>
    direction === "backward"
      ? position.textIndex === run.endIndex
      : position.textIndex === run.startIndex,
  );
  if (!faced || faced.document) return undefined;
  return removeInlineMathRun(state, position.blockIndex, block, faced);
}

/**
 * Delete one whole chip: its anchor char (whose tombstone dissolves the
 * covering mark) and its attachment when one is persisted. The caret lands
 * where the chip's leading edge was, as a plain flat cursor.
 */
function removeInlineMathRun(
  state: EditorState,
  blockIndexHint: number,
  block: TextualBlock,
  run: ResolvedInlineMathRun,
): InlineMathTreeStateResult {
  let page = state.document.page;
  const ops: Operation[] = [];
  if (run.contentId && block.structuredContent?.[run.contentId]) {
    const op = contentEdit(state, block.id, run.contentId, {
      kind: "document_delete",
    });
    page = applyOp(page, op, state.schema);
    ops.push(op);
  }
  if (run.endIndex > run.startIndex) {
    const deleted = deleteCharsInRange(
      page,
      block.id,
      run.startIndex,
      run.endIndex,
      state.CRDTbinding,
    );
    page = deleted.newPage;
    ops.push(deleted.op);
  }
  const blockIndex = findBlockIndex(page, block.id);
  if (blockIndex >= 0) invalidateBlockCache(page.blocks[blockIndex]);
  const withPage = updateContentSelection(
    { ...state, document: { ...state.document, page } },
    null,
  );
  return {
    state: moveCursorToPosition(
      withPage,
      blockIndex >= 0 ? blockIndex : blockIndexHint,
      run.startIndex,
    ),
    ops,
    handled: true,
  };
}

function removeInlineMathChip(
  state: EditorState,
  context: InlineMathTreeContext,
): InlineMathTreeStateResult {
  return removeInlineMathRun(
    state,
    context.blockIndex,
    context.block,
    context.run,
  );
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

/** Move one active nested inline caret; no flat chars are touched. */
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

/**
 * Extend OUT of the formula when a horizontal Shift+Arrow is already at its
 * edge: the nested selection degrades to a flat selection covering the chip
 * whole, so the next press continues into the host prose instead of the
 * keystroke dying at the formula boundary. In an RTL host block the visual
 * sides swap — the prose visually right of the chip is logically BEFORE it —
 * so the flat focus lands on the run's opposite offset.
 */
export function exitActiveInlineMathTreeSelectionHorizontally(
  state: EditorState,
  direction: "left" | "right",
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  const rtl = getBlockDirection(context.block, state.marks) === "rtl";
  const exited = extendSelectionOutOfStructuredMark(state, {
    blockIndex: context.blockIndex,
    textIndex:
      (direction === "right") !== rtl
        ? context.run.endIndex
        : context.run.startIndex,
  });
  return exited ? { state: exited, ops: [], handled: true } : undefined;
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
 *
 * A chip edge has exactly ONE caret stop and it belongs to the formula: the
 * flat position at the run boundary is the same visual spot as the tree edge
 * caret that just failed to move, so parking the caret there would swallow
 * the press. The exit therefore continues past the boundary in the same
 * press — into an adjacent chip's tree when one faces the landing edge, or
 * one ordinary flat step otherwise (the shared entry bridge covers both).
 * Only when that step has nowhere to go (the chip closes the document) does
 * the caret rest on the boundary itself.
 *
 * The formula interior always renders LTR, but the HOST side of the boundary
 * follows the block: in an RTL block the prose visually left of the chip is
 * logically AFTER it, so a visual-left exit lands at `run.endIndex` (and
 * visual-right at `run.startIndex`) — the mirror of the LTR mapping.
 */
export function exitActiveInlineMathTreeHorizontally(
  state: EditorState,
  direction: "left" | "right",
): InlineMathTreeStateResult | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  const rtl = getBlockDirection(context.block, state.marks) === "rtl";
  const atEdge = moveCursorToPosition(
    updateContentSelection(state, null),
    context.blockIndex,
    (direction === "left") !== rtl
      ? context.run.startIndex
      : context.run.endIndex,
  );
  const continued = enterAdjacentInlineMathTreeHorizontally(atEdge, direction);
  if (continued) return continued;
  return {
    state:
      direction === "left"
        ? moveCursorLeft(clearSelection(atEdge))
        : moveCursorRight(clearSelection(atEdge)),
    ops: [],
    handled: true,
  };
}

/**
 * Enter an attached inline tree when horizontal movement reaches a chip edge.
 *
 * The inline counterpart of the display block's adjacent-equation bridge, and
 * the entry half of the one-stop edge contract (see
 * {@link exitActiveInlineMathTreeHorizontally}): the chip's edge caret belongs
 * to the formula, so a collapsed flat caret resting on the run edge that faces
 * the move promotes to a structured caret at that same edge — and so does the
 * flat step this press would otherwise take when it lands exactly on such an
 * edge. Without the second branch, walking into a chip costs two presses: one
 * onto the flat boundary position and one more into the visually identical
 * tree stop. A broken run (no valid attachment) is left to flat semantics.
 *
 * In an RTL host block the run edge facing a visual move swaps: the caret at
 * `run.endIndex` sits at the chip's visual LEFT edge, so ArrowRight enters
 * there (and ArrowLeft enters at `run.startIndex`). The interior entry offset
 * keeps the LTR formula's mapping — a formula always renders LTR, so moving
 * visually right enters at source offset 0 and visually left at the end.
 */
export function enterAdjacentInlineMathTreeHorizontally(
  state: EditorState,
  direction: "left" | "right",
): InlineMathTreeStateResult | undefined {
  if (state.document.contentSelection) return undefined;
  const cursor = state.document.cursor;
  if (!cursor) return undefined;
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return undefined;
  }
  const resting = enterInlineMathRunEdgeFacingMove(
    state,
    cursor.position,
    direction,
  );
  if (resting) return resting;
  // Approach: take the flat step this press performs and promote when it
  // lands on a facing edge, so the edge is reached as the tree's caret stop
  // rather than as a flat position in front of it.
  const stepped =
    direction === "left"
      ? moveCursorLeft(clearSelection(state))
      : moveCursorRight(clearSelection(state));
  const landed = stepped.document.cursor?.position;
  if (
    !landed ||
    (landed.blockIndex === cursor.position.blockIndex &&
      landed.textIndex === cursor.position.textIndex)
  ) {
    return undefined;
  }
  return enterInlineMathRunEdgeFacingMove(stepped, landed, direction);
}

/** The facing-edge promotion both entry branches share: a caret at `position`
 * sitting on the run edge that faces the move becomes a structured caret at
 * that edge's source offset. */
function enterInlineMathRunEdgeFacingMove(
  state: EditorState,
  position: { readonly blockIndex: number; readonly textIndex: number },
  direction: "left" | "right",
): InlineMathTreeStateResult | undefined {
  const { blockIndex, textIndex } = position;
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  const rtl = getBlockDirection(block, state.marks) === "rtl";
  const run = resolveStructuredInlineMathRuns(block).find(
    (candidate) =>
      !!candidate.document &&
      ((direction === "right") !== rtl
        ? candidate.startIndex === textIndex
        : candidate.endIndex === textIndex),
  );
  if (!run?.contentId || !run.document || run.latex === undefined) {
    return undefined;
  }
  const math = structuredToMathDocument(run.document);
  if (!math) return undefined;
  const caret = mathTreeCaretFromSourceOffset(
    block.id,
    run.contentId,
    math,
    run.document,
    direction === "right" ? 0 : run.latex.length,
  );
  const selection = caret
    ? mathTreeCaretToContentSelection(
        block.id,
        run.contentId,
        run.document,
        caret,
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
 * Prepare Enter inside an inline formula for the generic block split.
 *
 * An attachment is one atomic block-scoped unit — a char split cannot divide
 * it — so mid-formula the chip itself is divided first: both halves are
 * rebuilt as independent attached chips (the space split's footing, without
 * the separating space) and the flat caret parks on their seam. The result is
 * deliberately NOT claimed; the ordinary SPLIT_BLOCK continues with the
 * threaded state and splits the block exactly between the two chips, moving
 * the right chip — attachment cloned through the structured-mark seam — to
 * block two. Backspace at that boundary reverses it: the block join carries
 * the attachment back and {@link rejoinAdjacentInlineMathChips} fuses the
 * touching chips into one formula again.
 *
 * At a formula edge there is nothing to divide, so the caret exits to that
 * edge and the whole chip stays on one side. Inside an undividable construct
 * slot, or over a nested range, Enter keeps the established exit semantics:
 * the split lands after the whole chip.
 */
export function prepareInlineMathTreeForBlockSplit(
  state: EditorState,
): { state: EditorState; ops: Operation[] } | undefined {
  const context = activeInlineMathContext(state);
  if (!context) return undefined;
  const divided = divideInlineMathChipForBlockSplit(state, context);
  if (divided) return divided;
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

/** The mid-formula branch of {@link prepareInlineMathTreeForBlockSplit}. */
function divideInlineMathChipForBlockSplit(
  state: EditorState,
  context: InlineMathTreeContext,
): { state: EditorState; ops: Operation[] } | undefined {
  if (context.range) return undefined;
  const math = structuredToMathDocument(context.document);
  // Only a top-level caret can divide the formula; inside a construct slot the
  // caller falls back to exiting past the whole chip.
  if (!math || context.caret.rowId !== math.root.body.id) return undefined;
  const selection = mathTreeCaretToContentSelection(
    context.block.id,
    context.contentId,
    context.document,
    context.caret,
  );
  const offset = selection
    ? mathSourceOffsetFromContentPoint(context.document, selection.focus)
    : null;
  if (offset === null) return undefined;
  const latex = printMathDocument(math);
  const left = latex.slice(0, offset);
  const right = latex.slice(offset);

  // A blank side means the caret sat at a formula edge: exit to that edge so
  // the generic split keeps the chip whole on one side of the boundary.
  if (!left.trim() || !right.trim()) {
    const at = !left.trim() ? context.run.startIndex : context.run.endIndex;
    return {
      state: moveCursorToPosition(
        updateContentSelection(state, null),
        context.blockIndex,
        at,
      ),
      ops: [],
    };
  }

  const rebuilt = rebuildInlineMathRunAsChips(state, context, left, "", right);
  const blockIndex = findBlockIndex(rebuilt.page, context.block.id);
  if (blockIndex >= 0) invalidateBlockCache(rebuilt.page.blocks[blockIndex]);
  const withPage = updateContentSelection(
    { ...state, document: { ...state.document, page: rebuilt.page } },
    null,
  );
  return {
    state: moveCursorToPosition(
      withPage,
      blockIndex >= 0 ? blockIndex : context.blockIndex,
      context.run.startIndex + left.length,
    ),
    ops: rebuilt.ops,
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
  input: string,
): InlineMathTreeContext | undefined {
  // A stable nested caret always owns input. A collapsed flat caret resting
  // on a chip's edge joins the formula for ordinary content keystrokes —
  // typing flush against a chip continues the same formula (`x^2|` + `z` →
  // `x^2z`) — while a space or sentence punctuation stays prose, the "leave
  // the formula" gestures.
  const active = activeInlineMathContext(state);
  if (active) return active;
  if (
    input.length !== 1 ||
    input === " " ||
    input === "\n" ||
    EDGE_PROSE_PUNCTUATION.has(input)
  ) {
    return undefined;
  }
  const position = collapsedFlatCursorPosition(state);
  if (!position) return undefined;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  const runs = resolveStructuredInlineMathRuns(block);
  // Prefer the run ENDING at the caret (typing after a chip continues it) so
  // the boundary between two adjacent chips extends the left formula.
  const touched =
    runs.find((run) => run.endIndex === position.textIndex) ??
    runs.find((run) => run.startIndex === position.textIndex);
  if (!touched) return undefined;
  return inlineContextFromFlatPosition(
    state,
    position.blockIndex,
    position.textIndex,
  );
}

/** The flat caret, when no nested selection or flat range outranks it. */
function collapsedFlatCursorPosition(
  state: EditorState,
): { readonly blockIndex: number; readonly textIndex: number } | undefined {
  if (state.document.contentSelection) return undefined;
  if (state.document.selection && !state.document.selection.isCollapsed) {
    return undefined;
  }
  return state.document.cursor?.position;
}

/** Promote a flat caret whose directional deletion faces into a run. */
function flatDeleteInlineMathContext(
  state: EditorState,
  direction: "backward" | "forward",
): InlineMathTreeContext | undefined {
  const position = collapsedFlatCursorPosition(state);
  if (!position) return undefined;
  const block = state.document.page.blocks[position.blockIndex];
  if (!block || block.deleted || !isTextualBlock(block)) return undefined;
  const faced = resolveStructuredInlineMathRuns(block).find((run) =>
    direction === "backward"
      ? position.textIndex > run.startIndex &&
        position.textIndex <= run.endIndex
      : position.textIndex >= run.startIndex &&
        position.textIndex < run.endIndex,
  );
  if (!faced) return undefined;
  return inlineContextFromFlatPosition(
    state,
    position.blockIndex,
    position.textIndex,
  );
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
  if (!run?.contentId || !run.document || run.latex === undefined) {
    return undefined;
  }
  const math = structuredToMathDocument(run.document);
  if (!math) return undefined;
  const latex = run.latex;
  // An anchor run has exactly two flat positions: its leading edge maps to
  // the source start, its trailing edge to the source end.
  const toSource = (index: number): number =>
    index <= run.startIndex ? 0 : latex.length;
  const caret = mathTreeCaretFromSourceOffset(
    block.id,
    run.contentId,
    math,
    run.document,
    toSource(focusIndex),
  );
  const anchor = mathTreeCaretFromSourceOffset(
    block.id,
    run.contentId,
    math,
    run.document,
    toSource(anchorIndex),
  );
  if (!caret || !anchor) return undefined;
  return {
    block,
    blockIndex,
    run,
    contentId: run.contentId,
    document: run.document,
    caret,
    ...(toSource(anchorIndex) === toSource(focusIndex)
      ? {}
      : { range: { anchor, focus: caret } }),
  };
}

function settleInlineMathMutation(
  state: EditorState,
  context: InlineMathTreeContext,
  result: MathTreeEditResult,
): InlineMathTreeStateResult {
  if (result.handled) {
    return commitInlineMathResult(state, context, result);
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
