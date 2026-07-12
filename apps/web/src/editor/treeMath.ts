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
  mathContentSelectionFromSourceOffset,
  mathSourceOffsetFromContentPoint,
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

/** Stable selection at one canonical-source bridge offset in this equation. */
export function treeMathSelectionAt(
  context: ActiveTreeMath,
  sourceOffset: number,
): ContentSelection | null {
  return mathContentSelectionFromSourceOffset(
    context.blockId,
    context.contentId,
    context.document,
    sourceOffset,
  );
}
