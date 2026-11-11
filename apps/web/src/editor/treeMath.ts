/** Public-API bridge used by app chrome while display math owns a tree caret. */

import type {
  ContentPoint,
  ContentSelection,
  StructuredDocument,
} from "@tasfer/editor";
import { isContentSelectionCollapsed } from "@tasfer/editor";
import {
  mathMarkContentId,
  printMathDocument,
  structuredToMathDocument,
} from "@tasfer/math/data";
import { tableCaretFromContentPoint } from "@tasfer/table";
import {
  contentPointToMathTreeCaret,
  mathSourceOffsetFromContentPoint,
  mathTreeCaretToContentSelection,
  trailingMathCommandRun,
} from "@tasfer/math";
import type { MathMenuTrigger } from "./mathCommandSearch";
import type { AppEditor } from "../editorSchema";

export interface ActiveTreeMath {
  readonly blockId: string;
  readonly contentId: string;
  readonly document: StructuredDocument;
  readonly point: ContentPoint;
  readonly source: string;
  readonly sourceOffset: number;
}

function treeMathAtPoint(
  editor: AppEditor,
  point: ContentPoint,
): ActiveTreeMath | null {
  const block = editor.query.block({ block: point.blockId });
  if (!block) return null;
  const contentId = point.contentId;
  const document = editor.query.content(block.id, contentId);
  const math = document ? structuredToMathDocument(document) : undefined;
  const sourceOffset = document
    ? mathSourceOffsetFromContentPoint(document, point)
    : null;
  if (!document || !math || sourceOffset === null) return null;
  return {
    blockId: block.id,
    contentId,
    document,
    point,
    source: printMathDocument(math),
    sourceOffset,
  };
}

/** Resolve display or supplemental inline math at the nested selection focus. */
export function treeMathAtFocus(editor: AppEditor): ActiveTreeMath | null {
  const point = editor.state.contentSelection?.focus;
  return point ? treeMathAtPoint(editor, point) : null;
}

/** Resolve display or supplemental inline math at the nested selection anchor. */
export function treeMathAtAnchor(editor: AppEditor): ActiveTreeMath | null {
  const point = editor.state.contentSelection?.anchor;
  return point ? treeMathAtPoint(editor, point) : null;
}

/** A formula addressed by its document, with no caret inside it yet. */
export interface HeldTreeMath {
  readonly blockId: string;
  readonly contentId: string;
  readonly document: StructuredDocument;
  readonly source: string;
}

/**
 * The formula a table-cell selection holds whole.
 *
 * Clicking a formula in a cell puts the caret inside it, and
 * {@link treeMathAtFocus} finds it. But a range in the cell's own text — a
 * drag, Shift+arrow, the whole formula held — only covers the formula's one
 * character in the cell; the formula itself is a separate document beside the
 * grid. This finds that document. In a paragraph the flat selection does the
 * same job; a table has none.
 *
 * Null unless the range stays inside one cell and touches a formula. With
 * several, the first one wins, as a paragraph range resolves the chip at its
 * start.
 */
export function tableFormulaInSelection(
  editor: AppEditor,
): HeldTreeMath | null {
  const selection = editor.state.contentSelection;
  if (!selection || isContentSelectionCollapsed(selection)) return null;
  const { anchor, focus } = selection;
  if (anchor.blockId !== focus.blockId) return null;
  if (anchor.contentId !== focus.contentId) return null;
  const block = editor.query.block({ block: focus.blockId });
  if (block?.type !== "table") return null;
  const grid = editor.query.content(block.id, focus.contentId);
  if (!grid) return null;
  const from = tableCaretFromContentPoint(grid, anchor);
  const to = tableCaretFromContentPoint(grid, focus);
  if (!from || !to || from.cellId !== to.cellId) return null;
  const start = Math.min(from.offset, to.offset);
  const end = Math.max(from.offset, to.offset);
  const field = editor.query
    .textFields(block.id)
    .find(
      (candidate) =>
        candidate.contentId === focus.contentId &&
        candidate.nodeId === from.cellId,
    );
  for (const mark of field?.marks ?? []) {
    if (mark.name !== "math" || mark.to <= start || mark.from >= end) continue;
    const contentId = mathMarkContentId({ type: mark.name, attrs: mark.attrs });
    const document = contentId
      ? editor.query.content(block.id, contentId)
      : null;
    const math = document ? structuredToMathDocument(document) : undefined;
    if (!contentId || !document || !math) continue;
    return {
      blockId: block.id,
      contentId,
      document,
      source: printMathDocument(math),
    };
  }
  return null;
}

/** Resolve display or supplemental inline math at the active nested caret. */
export function activeTreeMath(editor: AppEditor): ActiveTreeMath | null {
  const selection = editor.state.contentSelection;
  return selection && isContentSelectionCollapsed(selection)
    ? treeMathAtFocus(editor)
    : null;
}

export interface TreeMathCommandRun {
  /** Text typed after the trigger so far — empty right after it is inserted. */
  readonly query: string;
  /** Stable identity of the run's opening trigger character. */
  readonly triggerCharId: string;
  /** Collapsed selection at the trigger, for anchoring menu chrome. */
  readonly anchor: ContentSelection | null;
}

/**
 * The uncommitted `\query` command run ending at this context's caret. Read
 * from the raw-text field content, never from the projected source: the
 * projection is not a faithful echo of what was typed (a pending lone `\`
 * projects as `\backslash`), so source slicing would misread the run.
 */
export function treeMathCommandRun(
  context: ActiveTreeMath,
  trigger: MathMenuTrigger = "\\",
): TreeMathCommandRun | null {
  const caret = contentPointToMathTreeCaret(context.document, context.point);
  const run = caret
    ? trailingMathCommandRun(context.document, caret, trigger)
    : undefined;
  if (!run) return null;
  return {
    query: run.query,
    triggerCharId: run.triggerCharId,
    anchor: mathTreeCaretToContentSelection(
      context.blockId,
      context.contentId,
      context.document,
      run.range.anchor,
    ),
  };
}

/**
 * The command run at the caret whichever trigger opened it — what chrome that
 * doesn't own the trigger (the mobile toolbar) needs to mirror what is being
 * typed. The two runs are mutually exclusive: a query is letters only, so the
 * text before the caret can end in exactly one of `/query` and `\query`.
 */
export function activeTreeMathCommandRun(
  context: ActiveTreeMath,
): (TreeMathCommandRun & { trigger: MathMenuTrigger }) | null {
  for (const trigger of ["/", "\\"] as const) {
    const run = treeMathCommandRun(context, trigger);
    if (run) return { ...run, trigger };
  }
  return null;
}
