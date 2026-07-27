/**
 * Selection adapters of the math kind — the interactive half of the math
 * structured-kind adapters: the clipboard projection of a selected range and
 * the resolver that snaps committed ranges construct-atomic.
 *
 * This deliberately lives OUTSIDE `./data`: both adapters run the
 * tree-selection bridge, which needs the `@tasfer/tex` layout engine, and
 * their only consumers are main-thread selection and clipboard flows. Keeping
 * them here lets the worker-safe `@tasfer/editor/math/data` entry register
 * the rest of math without ever reaching the layout/paint stack.
 * `mathExtension()` installs them; hosts that assemble their schema by hand
 * add {@link mathContentSelectionKind} to their `structuredKinds`.
 */

import type {
  ContentSelectionCtx,
  ContentSelectionSlice,
} from "../feature-facets";
import type { ContentSelection } from "../structured-selection";
import type { StructuredKindSpec } from "../sync/schema";
import { MATH_STRUCTURED_KIND, structuredToMathDocument } from "./structured";
import { getMathTreeRangeText } from "./tree-edit";
import {
  contentPointToMathTreeCaret,
  mathSourceOffsetFromContentPoint,
  mathSourceRangeFromContentSelection,
  snapMathContentSelection,
} from "./tree-selection";
import { printMathDocument } from "@tasfer/tex/data";

/** Losslessly encode the editable subset of a math range for the clipboard. */
export function serializeMathContentSelection({
  document,
  selection,
}: ContentSelectionCtx): ContentSelectionSlice | undefined {
  const anchor = contentPointToMathTreeCaret(document, selection.anchor);
  const focus = contentPointToMathTreeCaret(document, selection.focus);
  if (!anchor || !focus) return undefined;
  const selected = getMathTreeRangeText(document, { anchor, focus });
  if (selected.handled) {
    return { plainText: selected.text, markdown: selected.text };
  }

  // A whole semantic child (for example a selected fraction) is not literal
  // raw text, but its canonical source projection is a lossless clipboard
  // representation. Cross-slot ranges remain rejected by the range resolver.
  if (selected.reason !== "unsupported-position") return undefined;
  const math = structuredToMathDocument(document);
  const range = mathSourceRangeFromContentSelection(document, selection);
  if (!math || !range) return undefined;
  const source = printMathDocument(math).slice(range.from, range.to);
  return { plainText: source, markdown: source };
}

/**
 * Keep every committed nested math range construct-atomic. Core routes each
 * non-collapsed selection through this adapter, so a drag, shift+click, or
 * API range that would rest inside a construct the anchor is not in snaps to
 * cover that construct whole (see {@link snapMathContentSelection}).
 */
export function resolveMathContentSelection({
  document,
  selection,
}: ContentSelectionCtx): ContentSelection | undefined {
  const boundary = selection.initialBoundary;
  if (!boundary) return snapMathContentSelection(document, selection);

  const start = mathSourceOffsetFromContentPoint(document, boundary.start);
  const end = mathSourceOffsetFromContentPoint(document, boundary.end);
  const focus = mathSourceOffsetFromContentPoint(document, selection.focus);
  if (start === null || end === null || focus === null) {
    return snapMathContentSelection(document, selection);
  }

  let adjusted: ContentSelection;
  if (focus < start) {
    adjusted = { ...selection, anchor: boundary.end };
  } else if (focus > end) {
    adjusted = { ...selection, anchor: boundary.start };
  } else if (focus - start < end - focus) {
    adjusted = {
      ...selection,
      anchor: boundary.end,
      focus: boundary.start,
    };
  } else {
    adjusted = {
      ...selection,
      anchor: boundary.start,
      focus: boundary.end,
    };
  }

  const snapped = snapMathContentSelection(document, adjusted) ?? adjusted;
  return {
    ...snapped,
    unsnapped: { anchor: adjusted.anchor, focus: adjusted.focus },
  };
}

/** The math kind's selection adapters, for hand-assembled interactive schemas. */
export const mathContentSelectionKind = {
  kind: MATH_STRUCTURED_KIND,
  contentSelection: serializeMathContentSelection,
  resolveSelection: resolveMathContentSelection,
} as const satisfies StructuredKindSpec;
