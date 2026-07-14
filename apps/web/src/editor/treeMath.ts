/** Public-API bridge used by app chrome while display math owns a tree caret. */

import type {
  ContentPoint,
  ContentSelection,
  StructuredDocument,
} from "@cypherkit/editor";
import { isContentSelectionCollapsed } from "@cypherkit/editor";
import {
  printMathDocument,
  structuredToMathDocument,
} from "@cypherkit/editor/math/data";
import {
  contentPointToMathTreeCaret,
  mathSourceOffsetFromContentPoint,
  mathTreeCaretToContentSelection,
  trailingMathCommandRun,
} from "@cypherkit/editor/math";
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

/** Resolve display or supplemental inline math at the active nested caret. */
export function activeTreeMath(editor: AppEditor): ActiveTreeMath | null {
  const selection = editor.state.contentSelection;
  return selection && isContentSelectionCollapsed(selection)
    ? treeMathAtFocus(editor)
    : null;
}

export interface TreeMathCommandRun {
  /** Letters typed after the `\` so far — empty right after the trigger. */
  readonly query: string;
  /** Stable identity of the run's opening `\` character. */
  readonly backslashCharId: string;
  /** Collapsed selection at the run's `\`, for anchoring menu chrome. */
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
): TreeMathCommandRun | null {
  const caret = contentPointToMathTreeCaret(context.document, context.point);
  const run = caret
    ? trailingMathCommandRun(context.document, caret)
    : undefined;
  if (!run) return null;
  return {
    query: run.query,
    backslashCharId: run.backslashCharId,
    anchor: mathTreeCaretToContentSelection(
      context.blockId,
      context.contentId,
      context.document,
      run.range.anchor,
    ),
  };
}
